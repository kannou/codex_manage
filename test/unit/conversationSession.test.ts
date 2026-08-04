import assert from 'node:assert/strict';
import test from 'node:test';
import type { Thread } from '../../src/codex/protocol/generated/v2/Thread';
import type { ThreadItem } from '../../src/codex/protocol/generated/v2/ThreadItem';
import type { ThreadResumeResponse } from '../../src/codex/protocol/generated/v2/ThreadResumeResponse';
import type { Turn } from '../../src/codex/protocol/generated/v2/Turn';
import type { Model } from '../../src/codex/protocol/generated/v2/Model';
import {
  ConversationSession,
  createConversationRuntimeSettings,
  visibleConversationModels,
  type ConversationSessionClient
} from '../../src/conversation/conversationSession';
import { createThread, createTurn } from '../support/threadFixture';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((error: Error) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: (value) => resolvePromise?.(value),
    reject: (error) => rejectPromise?.(error)
  };
}

function resumeResponse(thread: Thread): ThreadResumeResponse {
  return {
    thread,
    model: 'gpt-fixture',
    modelProvider: 'openai',
    serviceTier: null,
    cwd: thread.cwd,
    instructionSources: [],
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandbox: {
      type: 'workspaceWrite',
      writableRoots: [thread.cwd],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false
    },
    reasoningEffort: 'medium'
  };
}

function liveTurn(id = 'turn-live'): Turn {
  return createTurn({
    id,
    status: 'inProgress',
    completedAt: null,
    durationMs: null,
    items: []
  });
}

function runtimeModel(overrides: Partial<Model> = {}): Model {
  return {
    id: 'gpt-fixture-id',
    model: 'gpt-fixture',
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: 'GPT Fixture',
    description: 'Fixture model',
    hidden: false,
    supportedReasoningEfforts: [],
    defaultReasoningEffort: 'medium',
    inputModalities: [],
    supportsPersonality: false,
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault: false,
    ...overrides
  };
}

test('deduplicates visible models that share the same runtime model value', () => {
  const model = runtimeModel({
    id: 'gpt-5.6-terra-id',
    model: 'gpt-5.6-terra',
    displayName: 'GPT-5.6-Terra',
    description: 'Frontier'
  });

  const visible = visibleConversationModels([
    model,
    { ...model, id: 'gpt-5.6-terra-alias' }
  ]);

  assert.deepEqual(visible.map((candidate) => candidate.id), ['gpt-5.6-terra-id']);
});

test('deduplicates model choices with the same visible label and keeps the current value', () => {
  const advertised = runtimeModel({
    id: 'gpt-5.6-terra-catalog',
    model: 'gpt-5.6-terra-catalog',
    displayName: 'GPT-5.6-Terra',
    description: 'Frontier'
  });

  const runtime = createConversationRuntimeSettings(
    [advertised],
    'gpt-5.6-terra',
    null,
    null,
    'workspace-write',
    'on-request',
    'user'
  );

  assert.equal(runtime.model, 'gpt-5.6-terra');
  assert.deepEqual(runtime.models.map((candidate) => candidate.value), ['gpt-5.6-terra']);
});

function commandExecution(
  id: string,
  status: Extract<ThreadItem, { type: 'commandExecution' }>['status']
): Extract<ThreadItem, { type: 'commandExecution' }> {
  return {
    type: 'commandExecution',
    id,
    command: `printf ${id}`,
    cwd: 'D:\\workspace',
    processId: null,
    source: 'agent',
    status,
    commandActions: [],
    aggregatedOutput: '',
    exitCode: status === 'completed' ? 0 : null,
    durationMs: status === 'completed' ? 10 : null
  };
}

function fileChange(
  id: string,
  status: Extract<ThreadItem, { type: 'fileChange' }>['status']
): Extract<ThreadItem, { type: 'fileChange' }> {
  return { type: 'fileChange', id, changes: [], status };
}

function webSearch(id: string): Extract<ThreadItem, { type: 'webSearch' }> {
  return { type: 'webSearch', id, query: 'current documentation', action: null };
}

function mcpToolCall(
  id: string,
  status: Extract<ThreadItem, { type: 'mcpToolCall' }>['status']
): Extract<ThreadItem, { type: 'mcpToolCall' }> {
  return {
    type: 'mcpToolCall',
    id,
    server: 'fixture',
    tool: 'lookup',
    status,
    arguments: {},
    appContext: null,
    pluginId: null,
    result: null,
    error: status === 'failed' ? { message: 'Lookup failed' } : null,
    durationMs: status === 'inProgress' ? null : 10
  };
}

test('resumes before starting a text turn and locks concurrent sends', async () => {
  const resume = deferred<ThreadResumeResponse>();
  const start = deferred<{ turn: Turn }>();
  const startParams: unknown[] = [];
  let resumeCalls = 0;
  const client: ConversationSessionClient = {
    resumeThread: async () => {
      resumeCalls += 1;
      return resume.promise;
    },
    readThread: async () => ({ thread: createThread() }),
    startTurn: async (params) => {
      startParams.push(params);
      return start.promise;
    },
    interruptTurn: async () => ({}),
    listModels: async () => ({ data: [], nextCursor: null })
  };
  const session = new ConversationSession(client, createThread());

  const first = session.send('Continue the thread');
  const duplicate = await session.send('Duplicate');
  assert.equal(duplicate, false);
  assert.equal(resumeCalls, 1);
  assert.equal(session.snapshot().operation, 'resuming');

  resume.resolve(resumeResponse(createThread()));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(startParams.length, 1);
  assert.deepEqual(
    (startParams[0] as { input: unknown }).input,
    [{ type: 'text', text: 'Continue the thread', text_elements: [] }]
  );
  assert.match(
    String((startParams[0] as { clientUserMessageId?: unknown }).clientUserMessageId),
    /^[0-9a-f-]{36}$/u
  );

  start.resolve({ turn: liveTurn() });
  assert.equal(await first, true);
  assert.equal(session.snapshot().activeTurnId, 'turn-live');
  assert.equal(session.snapshot().operation, 'running');
});

test('sends host-selected images, file references, and Skills after text in the same turn', async () => {
  const startParams: unknown[] = [];
  const client: ConversationSessionClient = {
    ...passiveClient(),
    resumeThread: async () => resumeResponse(createThread()),
    startTurn: async (params) => {
      startParams.push(params);
      return { turn: liveTurn() };
    }
  };
  const session = new ConversationSession(client, createThread());

  assert.equal(await session.send('Review this', [
    { type: 'localImage', path: '/workspace/diagram.png' },
    {
      type: 'text',
      text: 'Referenced file: /workspace/AGENTS.md',
      text_elements: [{ byteRange: { start: 17, end: 37 }, placeholder: '@AGENTS.md' }]
    },
    { type: 'skill', name: 'review', path: '/skills/review/SKILL.md' }
  ]), true);
  assert.deepEqual((startParams[0] as { input: unknown }).input, [
    { type: 'text', text: 'Review this', text_elements: [] },
    { type: 'localImage', path: '/workspace/diagram.png' },
    {
      type: 'text',
      text: 'Referenced file: /workspace/AGENTS.md',
      text_elements: [{ byteRange: { start: 17, end: 37 }, placeholder: '@AGENTS.md' }]
    },
    { type: 'skill', name: 'review', path: '/skills/review/SKILL.md' }
  ]);
});

test('applies streaming deltas and converges on the completed turn snapshot', () => {
  const client = passiveClient();
  const session = new ConversationSession(client, createThread());
  const turn = liveTurn();
  session.applyNotification({
    method: 'turn/started',
    params: { threadId: 'thread-1', turn }
  });
  session.applyNotification({
    method: 'item/agentMessage/delta',
    params: {
      threadId: 'thread-1',
      turnId: turn.id,
      itemId: 'agent-live',
      delta: 'Streamed'
    }
  });
  assert.equal(session.snapshot().model.turns[0]?.items[0]?.kind, 'message');

  const completed = createTurn({
    id: turn.id,
    status: 'completed',
    items: [{
      type: 'agentMessage',
      id: 'agent-live',
      text: 'Final response',
      phase: 'final_answer',
      memoryCitation: null
    }]
  });
  session.applyNotification({
    method: 'turn/completed',
    params: { threadId: 'thread-1', turn: completed }
  });

  const item = session.snapshot().model.turns[0]?.items[0];
  assert.equal(item?.kind, 'message');
  if (item?.kind === 'message') {
    assert.equal(item.text, 'Final response');
  }
  assert.equal(session.snapshot().operation, 'idle');
});

test('keeps a completed command until the next visible activity starts', () => {
  const session = new ConversationSession(passiveClient(), createThread());
  const turn = liveTurn();
  session.applyNotification({
    method: 'turn/started',
    params: { threadId: 'thread-1', turn }
  });
  session.applyNotification({
    method: 'item/started',
    params: {
      threadId: 'thread-1',
      turnId: turn.id,
      item: commandExecution('command-first', 'inProgress'),
      startedAtMs: 1
    }
  });
  session.applyNotification({
    method: 'item/completed',
    params: {
      threadId: 'thread-1',
      turnId: turn.id,
      item: commandExecution('command-first', 'completed'),
      completedAtMs: 2
    }
  });
  session.applyNotification({
    method: 'item/started',
    params: {
      threadId: 'thread-1',
      turnId: turn.id,
      item: {
        type: 'agentMessage',
        id: 'agent-live',
        text: '',
        phase: null,
        memoryCitation: null
      },
      startedAtMs: 3
    }
  });

  let snapshot = session.snapshot().model.turns[0];
  assert.equal(snapshot?.liveItemIds?.includes('command-first'), true);
  assert.equal(snapshot?.items.some((item) => item.id === 'agent-live'), false);

  session.applyNotification({
    method: 'item/reasoning/summaryTextDelta',
    params: {
      threadId: 'thread-1',
      turnId: turn.id,
      itemId: 'reasoning-live',
      summaryIndex: 0,
      delta: 'Checking'
    }
  });
  snapshot = session.snapshot().model.turns[0];
  assert.equal(snapshot?.liveItemIds?.includes('command-first'), false);

  session.applyNotification({
    method: 'item/started',
    params: {
      threadId: 'thread-1',
      turnId: turn.id,
      item: fileChange('file-live', 'inProgress'),
      startedAtMs: 4
    }
  });
  snapshot = session.snapshot().model.turns[0];
  assert.equal(snapshot?.liveItemIds?.includes('command-first'), false);

  session.applyNotification({
    method: 'item/agentMessage/delta',
    params: {
      threadId: 'thread-1',
      turnId: turn.id,
      itemId: 'agent-live',
      delta: '次の返答'
    }
  });
  snapshot = session.snapshot().model.turns[0];
  assert.equal(snapshot?.liveItemIds?.includes('command-first'), false);
  assert.equal(
    snapshot?.items.find((item) => item.id === 'agent-live')?.kind,
    'message'
  );

  session.applyNotification({
    method: 'item/started',
    params: {
      threadId: 'thread-1',
      turnId: turn.id,
      item: commandExecution('command-second', 'inProgress'),
      startedAtMs: 5
    }
  });
  session.applyNotification({
    method: 'item/completed',
    params: {
      threadId: 'thread-1',
      turnId: turn.id,
      item: commandExecution('command-second', 'completed'),
      completedAtMs: 6
    }
  });
  snapshot = session.snapshot().model.turns[0];
  assert.equal(snapshot?.liveItemIds?.includes('command-second'), true);

  session.applyNotification({
    method: 'item/started',
    params: {
      threadId: 'thread-1',
      turnId: turn.id,
      item: commandExecution('command-third', 'inProgress'),
      startedAtMs: 7
    }
  });
  snapshot = session.snapshot().model.turns[0];
  assert.equal(snapshot?.liveItemIds?.includes('command-second'), false);
  assert.equal(snapshot?.liveItemIds?.includes('command-third'), true);
});

test('replaces completed transient cards across activity types and retains failures', () => {
  const session = new ConversationSession(passiveClient(), createThread());
  const turn = liveTurn();
  session.applyNotification({
    method: 'turn/started',
    params: { threadId: 'thread-1', turn }
  });
  session.applyNotification({
    method: 'item/started',
    params: {
      threadId: 'thread-1',
      turnId: turn.id,
      item: fileChange('file-first', 'inProgress'),
      startedAtMs: 1
    }
  });
  session.applyNotification({
    method: 'item/completed',
    params: {
      threadId: 'thread-1',
      turnId: turn.id,
      item: fileChange('file-first', 'completed'),
      completedAtMs: 2
    }
  });

  let snapshot = session.snapshot().model.turns[0];
  assert.equal(snapshot?.liveItemIds?.includes('file-first'), true);

  session.applyNotification({
    method: 'item/started',
    params: {
      threadId: 'thread-1',
      turnId: turn.id,
      item: webSearch('web-next'),
      startedAtMs: 3
    }
  });
  snapshot = session.snapshot().model.turns[0];
  assert.equal(snapshot?.liveItemIds?.includes('file-first'), false);
  assert.equal(snapshot?.liveItemIds?.includes('web-next'), true);

  session.applyNotification({
    method: 'item/completed',
    params: {
      threadId: 'thread-1',
      turnId: turn.id,
      item: webSearch('web-next'),
      completedAtMs: 4
    }
  });
  session.applyNotification({
    method: 'item/started',
    params: {
      threadId: 'thread-1',
      turnId: turn.id,
      item: mcpToolCall('mcp-failed', 'inProgress'),
      startedAtMs: 5
    }
  });
  snapshot = session.snapshot().model.turns[0];
  assert.equal(snapshot?.liveItemIds?.includes('web-next'), false);

  session.applyNotification({
    method: 'item/completed',
    params: {
      threadId: 'thread-1',
      turnId: turn.id,
      item: mcpToolCall('mcp-failed', 'failed'),
      completedAtMs: 6
    }
  });
  session.applyNotification({
    method: 'item/started',
    params: {
      threadId: 'thread-1',
      turnId: turn.id,
      item: commandExecution('command-after-failure', 'inProgress'),
      startedAtMs: 7
    }
  });
  snapshot = session.snapshot().model.turns[0];
  assert.equal(snapshot?.liveItemIds?.includes('mcp-failed'), true);
  assert.equal(snapshot?.liveItemIds?.includes('command-after-failure'), true);

  session.applyNotification({
    method: 'item/started',
    params: {
      threadId: 'thread-1',
      turnId: turn.id,
      item: fileChange('file-parallel', 'inProgress'),
      startedAtMs: 8
    }
  });
  snapshot = session.snapshot().model.turns[0];
  assert.equal(snapshot?.liveItemIds?.includes('mcp-failed'), true);
  assert.equal(snapshot?.liveItemIds?.includes('command-after-failure'), true);
  assert.equal(snapshot?.liveItemIds?.includes('file-parallel'), true);
});

test('keeps streamed text visible and uses one convergence workflow for duplicate completion', async () => {
  const read = deferred<{ thread: Thread }>();
  let readCalls = 0;
  const client: ConversationSessionClient = {
    ...passiveClient(),
    readThread: async () => {
      readCalls += 1;
      return read.promise;
    }
  };
  const session = new ConversationSession(client, createThread());
  session.applyNotification({
    method: 'item/agentMessage/delta',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-partial',
      itemId: 'agent-partial',
      delta: 'Streamed response'
    }
  });
  const partialCompletion = {
    method: 'turn/completed' as const,
    params: {
      threadId: 'thread-1',
      turn: createTurn({
        id: 'turn-partial',
        items: [],
        itemsView: 'notLoaded'
      })
    }
  };
  session.applyNotification(partialCompletion);
  session.applyNotification(partialCompletion);

  const provisional = session.snapshot().model.turns[0];
  assert.equal(provisional?.itemsView, 'notLoaded');
  assert.equal(provisional?.items[0]?.kind, 'message');
  assert.equal(provisional?.items[0]?.kind === 'message' ? provisional.items[0].text : null, 'Streamed response');
  assert.equal(readCalls, 1);

  read.resolve({
    thread: createThread({
      turns: [createTurn({
        id: 'turn-partial',
        items: [{
          type: 'agentMessage',
          id: 'agent-partial',
          text: 'Authoritative response',
          phase: 'final_answer',
          memoryCitation: null
        }]
      })]
    })
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  const completed = session.snapshot().model.turns[0];
  assert.equal(completed?.itemsView, 'full');
  assert.equal(completed?.items[0]?.kind === 'message' ? completed.items[0].text : null, 'Authoritative response');
  assert.equal(session.snapshot().sync, 'ready');
  assert.equal(readCalls, 2);
});

test('keeps provisional text and requests manual reload when completion convergence fails', async () => {
  const client: ConversationSessionClient = {
    ...passiveClient(),
    readThread: async () => {
      throw new Error('private read failure');
    }
  };
  const session = new ConversationSession(client, createThread());
  session.applyNotification({
    method: 'item/agentMessage/delta',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-partial',
      itemId: 'agent-partial',
      delta: 'Keep this response'
    }
  });
  session.applyNotification({
    method: 'turn/completed',
    params: {
      threadId: 'thread-1',
      turn: createTurn({ id: 'turn-partial', items: [], itemsView: 'summary' })
    }
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  const item = session.snapshot().model.turns[0]?.items[0];
  assert.equal(item?.kind === 'message' ? item.text : null, 'Keep this response');
  assert.equal(session.snapshot().sync, 'stale');
  assert.match(session.snapshot().notice ?? '', /reload/iu);
  assert.doesNotMatch(session.snapshot().notice ?? '', /private read failure/u);
});

test('ignores an automatic completion read that resolves after disconnect', async () => {
  const read = deferred<{ thread: Thread }>();
  const client: ConversationSessionClient = {
    ...passiveClient(),
    readThread: async () => read.promise
  };
  const session = new ConversationSession(client, createThread());
  session.applyNotification({
    method: 'item/agentMessage/delta',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-partial',
      itemId: 'agent-partial',
      delta: 'Provisional response'
    }
  });
  session.applyNotification({
    method: 'turn/completed',
    params: {
      threadId: 'thread-1',
      turn: createTurn({ id: 'turn-partial', items: [], itemsView: 'notLoaded' })
    }
  });
  session.markDisconnected();
  read.resolve({
    thread: createThread({
      turns: [createTurn({
        id: 'turn-partial',
        items: [{
          type: 'agentMessage',
          id: 'agent-partial',
          text: 'Late authoritative response',
          phase: 'final_answer',
          memoryCitation: null
        }]
      })]
    })
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  const item = session.snapshot().model.turns[0]?.items[0];
  assert.equal(item?.kind === 'message' ? item.text : null, 'Provisional response');
  assert.equal(session.snapshot().sync, 'stale');
  assert.match(session.snapshot().notice ?? '', /connection closed/iu);
});

test('stops only the host-owned active turn and accepts idle status before completion', async () => {
  const interrupt = deferred<Record<string, never>>();
  const calls: unknown[] = [];
  const client: ConversationSessionClient = {
    ...passiveClient(),
    interruptTurn: async (params) => {
      calls.push(params);
      return interrupt.promise;
    }
  };
  const session = new ConversationSession(client, createThread({
    status: { type: 'active', activeFlags: [] },
    turns: [liveTurn('turn-owned')]
  }));

  const first = session.stop();
  const duplicate = await session.stop();
  assert.equal(duplicate, false);
  assert.deepEqual(calls, [{ threadId: 'thread-1', turnId: 'turn-owned' }]);
  interrupt.resolve({});
  assert.equal(await first, true);
  assert.equal(session.snapshot().operation, 'interrupting');

  session.applyNotification({
    method: 'thread/status/changed',
    params: { threadId: 'thread-1', status: { type: 'idle' } }
  });
  assert.equal(session.snapshot().sync, 'ready');
  assert.equal(session.snapshot().operation, 'interrupting');

  session.applyNotification({
    method: 'turn/completed',
    params: {
      threadId: 'thread-1',
      turn: createTurn({ id: 'turn-owned', status: 'interrupted' })
    }
  });
  assert.equal(session.snapshot().operation, 'idle');
  assert.equal(session.snapshot().notice, 'The turn was stopped.');
  assert.equal(await session.send('Next message'), true);
});

test('reads authoritative history when resume returns a stale interrupted turn', async () => {
  const interrupted = createTurn({ id: 'turn-interrupted', status: 'interrupted' });
  const current = createThread({ turns: [interrupted] });
  const stale = createThread({
    turns: [liveTurn('turn-interrupted')]
  });
  let reads = 0;
  let starts = 0;
  const client: ConversationSessionClient = {
    ...passiveClient(),
    resumeThread: async () => resumeResponse(stale),
    readThread: async () => {
      reads += 1;
      return { thread: current };
    },
    startTurn: async () => {
      starts += 1;
      return { turn: liveTurn('turn-next') };
    }
  };
  const session = new ConversationSession(client, current);

  assert.equal(await session.send('Next message'), true);
  assert.equal(reads, 1);
  assert.equal(starts, 1);
  assert.equal(session.snapshot().sync, 'ready');
  assert.equal(session.snapshot().activeTurnId, 'turn-next');
});

test('keeps history while disconnected and replaces it after resume/read resync', async () => {
  const initial = createThread({
    name: 'Before disconnect',
    turns: [createTurn({ id: 'turn-old' })]
  });
  const reloaded = createThread({
    name: 'After reconnect',
    turns: [createTurn({ id: 'turn-new' })]
  });
  const client: ConversationSessionClient = {
    ...passiveClient(),
    resumeThread: async () => resumeResponse(initial),
    readThread: async () => ({ thread: reloaded })
  };
  const session = new ConversationSession(client, initial);

  session.markDisconnected();
  assert.equal(session.snapshot().sync, 'stale');
  assert.equal(session.snapshot().model.title, 'Before disconnect');
  assert.equal(await session.resync(), true);
  assert.equal(session.snapshot().sync, 'ready');
  assert.equal(session.snapshot().model.title, 'After reconnect');
  assert.deepEqual(session.snapshot().model.turns.map((turn) => turn.id), ['turn-new']);
});

test('does not expose an unexpected transport error in the session notice', async () => {
  const client: ConversationSessionClient = {
    ...passiveClient(),
    resumeThread: async () => {
      throw new Error('private transport detail');
    }
  };
  const session = new ConversationSession(client, createThread());

  assert.equal(await session.send('Hello'), false);
  assert.doesNotMatch(session.snapshot().notice ?? '', /private transport detail/u);
});

test('keeps an active thread without a visible turn locked instead of starting another turn', async () => {
  let resumeCalls = 0;
  let startCalls = 0;
  const client: ConversationSessionClient = {
    ...passiveClient(),
    resumeThread: async (params) => {
      resumeCalls += 1;
      return resumeResponse(createThread({ id: params.threadId }));
    },
    startTurn: async () => {
      startCalls += 1;
      return { turn: liveTurn() };
    }
  };
  const session = new ConversationSession(client, createThread({
    status: { type: 'active', activeFlags: [] }
  }));

  assert.equal(session.snapshot().operation, 'resuming');
  assert.equal(await session.send('Do not overlap'), false);
  assert.equal(resumeCalls, 0);
  assert.equal(startCalls, 0);
});

test('cancels a pending send when its session is disposed', async () => {
  const resume = deferred<ThreadResumeResponse>();
  let startCalls = 0;
  const client: ConversationSessionClient = {
    ...passiveClient(),
    resumeThread: async () => resume.promise,
    startTurn: async () => {
      startCalls += 1;
      return { turn: liveTurn() };
    }
  };
  const session = new ConversationSession(client, createThread());
  const sending = session.send('Cancel before start');
  session.dispose();
  resume.resolve(resumeResponse(createThread()));

  assert.equal(await sending, false);
  assert.equal(startCalls, 0);
});

test('retries an authoritative read when notifications race with resynchronization', async () => {
  let readCalls = 0;
  let session: ConversationSession;
  const client: ConversationSessionClient = {
    ...passiveClient(),
    readThread: async () => {
      readCalls += 1;
      if (readCalls < 3) {
        session.applyNotification({
          method: 'item/agentMessage/delta',
          params: {
            threadId: 'thread-1',
            turnId: `turn-race-${readCalls}`,
            itemId: `item-race-${readCalls}`,
            delta: 'racing'
          }
        });
      }
      return { thread: createThread({ name: `Authoritative ${readCalls}` }) };
    }
  };
  session = new ConversationSession(client, createThread());
  session.markDisconnected();

  assert.equal(await session.resync(), true);
  assert.equal(readCalls, 3);
  assert.equal(session.snapshot().sync, 'ready');
  assert.equal(session.snapshot().model.title, 'Authoritative 3');
});

test('becomes stale as soon as a notification creates an ID collision', () => {
  const session = new ConversationSession(passiveClient(), createThread({
    turns: [createTurn({
      id: 'turn-old',
      items: [{
        type: 'agentMessage',
        id: 'shared-item',
        text: 'Done',
        phase: null,
        memoryCitation: null
      }]
    })]
  }));
  session.applyNotification({
    method: 'item/started',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-new',
      item: {
        type: 'agentMessage',
        id: 'shared-item',
        text: '',
        phase: null,
        memoryCitation: null
      },
      startedAtMs: 1
    }
  });

  assert.equal(session.snapshot().sync, 'stale');
  assert.match(session.snapshot().notice ?? '', /resynchronize/iu);
});

test('keeps an inconsistent authoritative reload stale', async () => {
  const active = (id: string): Turn => createTurn({
    id,
    status: 'inProgress',
    completedAt: null,
    durationMs: null
  });
  const client: ConversationSessionClient = {
    ...passiveClient(),
    readThread: async () => ({
      thread: createThread({
        status: { type: 'active', activeFlags: [] },
        turns: [active('turn-1'), active('turn-2')]
      })
    })
  };
  const session = new ConversationSession(client, createThread());
  session.markDisconnected();

  assert.equal(await session.resync(), false);
  assert.equal(session.snapshot().sync, 'stale');
  assert.match(session.snapshot().notice ?? '', /inconsistent/iu);
});

test('updates cached display metadata without changing conversation history', () => {
  const session = new ConversationSession(passiveClient(), createThread({
    name: 'Before rename',
    turns: [createTurn({ id: 'turn-kept' })]
  }));
  session.updateTitle('After rename');

  assert.equal(session.snapshot().model.title, 'After rename');
  assert.deepEqual(session.snapshot().model.turns.map((turn) => turn.id), ['turn-kept']);
});

test('loads validated runtime choices and applies changed settings only to the next turn', async () => {
  const resumeParams: unknown[] = [];
  const startParams: unknown[] = [];
  const fixtureModel: Model = {
    id: 'fixture-id',
    model: 'gpt-fixture',
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: 'GPT Fixture',
    description: 'Fixture model',
    hidden: false,
    supportedReasoningEfforts: [
      { reasoningEffort: 'medium', description: 'Balanced' },
      { reasoningEffort: 'high', description: 'More reasoning' }
    ],
    defaultReasoningEffort: 'medium',
    inputModalities: [],
    supportsPersonality: false,
    additionalSpeedTiers: [],
    serviceTiers: [{ id: 'fast', name: 'Fast', description: 'Lower latency' }],
    defaultServiceTier: null,
    isDefault: true
  };
  const client: ConversationSessionClient = {
    ...passiveClient(),
    listModels: async () => ({
      data: [
        fixtureModel,
        { ...fixtureModel, id: 'gpt-5.6-terra-id', model: 'gpt-5.6-terra', displayName: 'GPT-5.6-Terra', isDefault: false },
        { ...fixtureModel, id: 'gpt-5.6-luna-id', model: 'gpt-5.6-luna', displayName: 'GPT-5.6-Luna', isDefault: false }
      ],
      nextCursor: null
    }),
    resumeThread: async (params) => {
      resumeParams.push(params);
      return resumeResponse(createThread({ id: params.threadId }));
    },
    startTurn: async (params) => {
      startParams.push(params);
      return { turn: liveTurn() };
    }
  };
  const session = new ConversationSession(client, createThread());

  assert.equal(await session.loadRuntimeSettings(), true);
  assert.equal(session.snapshot().runtime.model, 'fixture-id');
  assert.deepEqual(session.snapshot().runtime.models.map((model) => [model.value, model.label]), [
    ['fixture-id', 'GPT Fixture'],
    ['gpt-5.6-terra-id', 'GPT-5.6-Terra'],
    ['gpt-5.6-luna-id', 'GPT-5.6-Luna']
  ]);
  assert.equal(session.updateRuntimeSettings({
    model: 'fixture-id',
    effort: 'high',
    serviceTier: 'fast',
    sandbox: 'read-only',
    approvalPolicy: 'never',
    approvalsReviewer: 'auto_review'
  }), true);
  assert.equal(await session.send('Use the selected runtime'), true);

  assert.deepEqual(resumeParams[1], {
    threadId: 'thread-1',
    model: 'gpt-fixture',
    serviceTier: 'fast',
    approvalPolicy: 'never',
    approvalsReviewer: 'auto_review',
    sandbox: 'read-only'
  });
  assert.equal((startParams[0] as { effort?: unknown }).effort, 'high');
  assert.equal((startParams[0] as { serviceTier?: unknown }).serviceTier, 'fast');
  assert.equal((startParams[0] as { approvalPolicy?: unknown }).approvalPolicy, 'never');
  assert.equal((startParams[0] as { approvalsReviewer?: unknown }).approvalsReviewer, 'auto_review');
});

test('preserves a compatible reasoning effort and falls back for an unsupported model', () => {
  const baseModel: Model = {
    id: 'model-a',
    model: 'model-a',
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: 'Model A',
    description: 'Current model',
    hidden: false,
    supportedReasoningEfforts: [
      { reasoningEffort: 'medium', description: 'Balanced' },
      { reasoningEffort: 'high', description: 'More reasoning' }
    ],
    defaultReasoningEffort: 'medium',
    inputModalities: ['text'],
    supportsPersonality: false,
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault: true
  };
  const compatibleModel: Model = {
    ...baseModel,
    id: 'model-b',
    model: 'model-b',
    displayName: 'Model B',
    description: 'Compatible model',
    isDefault: false
  };
  const incompatibleModel: Model = {
    ...baseModel,
    id: 'model-c',
    model: 'model-c',
    displayName: 'Model C',
    description: 'Model without high reasoning',
    supportedReasoningEfforts: [
      { reasoningEffort: 'low', description: 'Fast' },
      { reasoningEffort: 'medium', description: 'Balanced' }
    ],
    isDefault: false
  };
  const session = new ConversationSession(passiveClient(), createThread());
  session.initializeRuntimeSettings(
    [baseModel, compatibleModel, incompatibleModel],
    baseModel.id,
    'high',
    null,
    'workspace-write',
    'on-request',
    'user'
  );

  assert.equal(session.updateRuntimeSettings({
    model: compatibleModel.id,
    effort: null,
    serviceTier: null,
    sandbox: 'workspace-write',
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user'
  }), true);
  assert.equal(session.snapshot().runtime.effort, 'high');

  assert.equal(session.updateRuntimeSettings({
    model: incompatibleModel.id,
    effort: null,
    serviceTier: null,
    sandbox: 'workspace-write',
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user'
  }), true);
  assert.equal(session.snapshot().runtime.effort, null);
  assert.equal(session.snapshot().runtime.defaultEffort, 'medium');
});

test('switches every advertised model while preserving a granular approval policy', async () => {
  const granularApproval = {
    granular: {
      sandbox_approval: true,
      rules: false,
      skill_approval: true,
      request_permissions: true,
      mcp_elicitations: false
    }
  } as const;
  const baseModel: Model = {
    id: 'gpt-5.6-sol',
    model: 'gpt-5.6-sol',
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: 'GPT-5.6-Sol',
    description: 'Frontier',
    hidden: false,
    supportedReasoningEfforts: [
      { reasoningEffort: 'low', description: 'Fast' },
      { reasoningEffort: 'medium', description: 'Balanced' }
    ],
    defaultReasoningEffort: 'low',
    inputModalities: ['text'],
    supportsPersonality: false,
    additionalSpeedTiers: ['fast'],
    serviceTiers: [{ id: 'priority', name: 'Fast', description: 'Lower latency' }],
    defaultServiceTier: null,
    isDefault: true
  };
  const models: readonly Model[] = [
    baseModel,
    { ...baseModel, id: 'gpt-5.6-terra', model: 'gpt-5.6-terra', displayName: 'GPT-5.6-Terra', defaultReasoningEffort: 'medium', isDefault: false },
    { ...baseModel, id: 'gpt-5.6-luna', model: 'gpt-5.6-luna', displayName: 'GPT-5.6-Luna', defaultReasoningEffort: 'medium', isDefault: false }
  ];

  for (const selectedModel of models) {
    const resumeParams: unknown[] = [];
    const startParams: unknown[] = [];
    const client: ConversationSessionClient = {
      ...passiveClient(),
      listModels: async () => ({ data: [...models], nextCursor: null }),
      resumeThread: async (params) => {
        resumeParams.push(params);
        return {
          ...resumeResponse(createThread({ id: params.threadId })),
          model: 'gpt-5.6-sol',
          reasoningEffort: null,
          approvalPolicy: granularApproval
        };
      },
      startTurn: async (params) => {
        startParams.push(params);
        return { turn: liveTurn(`turn-${selectedModel.id}`) };
      }
    };
    const session = new ConversationSession(client, createThread());

    assert.equal(await session.loadRuntimeSettings(), true);
    assert.equal(session.snapshot().runtime.approvalPolicy, 'custom');
    assert.equal(session.updateRuntimeSettings({
      model: selectedModel.id,
      effort: null,
      serviceTier: null,
      sandbox: 'workspace-write',
      approvalPolicy: 'custom',
      approvalsReviewer: 'user'
    }), true);
    assert.equal(session.snapshot().runtime.defaultEffort, selectedModel.defaultReasoningEffort);
    assert.equal(await session.send(`Use ${selectedModel.displayName}`), true);
    assert.equal((resumeParams[1] as { model?: unknown }).model, selectedModel.model);
    assert.deepEqual((resumeParams[1] as { approvalPolicy?: unknown }).approvalPolicy, granularApproval);
    assert.equal((startParams[0] as { model?: unknown }).model, selectedModel.model);
    assert.deepEqual((startParams[0] as { approvalPolicy?: unknown }).approvalPolicy, granularApproval);
  }
});

test('keeps default and unlisted current runtime values meaningful instead of blank', async () => {
  const model: Model = {
    id: 'gpt-fixture',
    model: 'gpt-fixture',
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: 'GPT Fixture',
    description: 'Fixture model',
    hidden: false,
    supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Balanced' }],
    defaultReasoningEffort: 'medium',
    inputModalities: ['text'],
    supportsPersonality: false,
    additionalSpeedTiers: ['fast'],
    serviceTiers: [{ id: 'priority', name: 'Fast', description: 'Lower latency' }],
    defaultServiceTier: null,
    isDefault: true
  };
  const client: ConversationSessionClient = {
    ...passiveClient(),
    listModels: async () => ({ data: [model], nextCursor: null }),
    resumeThread: async (params) => ({
      ...resumeResponse(createThread({ id: params.threadId })),
      model: 'gpt-unlisted',
      reasoningEffort: 'ultra',
      serviceTier: 'legacy-fast'
    })
  };
  const session = new ConversationSession(client, createThread());

  assert.equal(await session.loadRuntimeSettings(), true);
  const runtime = session.snapshot().runtime;
  assert.equal(runtime.model, 'gpt-unlisted');
  assert.match(runtime.models[0]?.label ?? '', /current, unlisted/iu);
  assert.equal(runtime.effort, 'ultra');
  assert.match(runtime.efforts[0]?.label ?? '', /current, unlisted/iu);
  assert.equal(runtime.defaultEffort, null);
  assert.equal(runtime.serviceTier, 'legacy-fast');
  assert.match(runtime.serviceTiers[0]?.label ?? '', /current, unlisted/iu);
});

function passiveClient(): ConversationSessionClient {
  return {
    resumeThread: async (params) => resumeResponse(createThread({ id: params.threadId })),
    readThread: async (params) => ({ thread: createThread({ id: params.threadId }) }),
    startTurn: async () => ({ turn: liveTurn() }),
    interruptTurn: async () => ({}),
    listModels: async () => ({ data: [], nextCursor: null })
  };
}
