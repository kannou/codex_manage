import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import * as vscode from 'vscode';
import {
  ConversationCoordinator,
  type ConversationCoordinatorOptions,
  type ConversationPresentation
} from '../../src/conversation/conversationCoordinator';
import type { ConversationSessionClient } from '../../src/conversation/conversationSession';
import type { ThreadResumeResponse } from '../../src/codex/protocol/generated/v2/ThreadResumeResponse';
import type { ThreadsHostToWebviewMessage } from '../../src/webview/threads/protocol';
import { createThread, createTurn } from '../support/threadFixture';

class Presentation implements ConversationPresentation {
  public readonly messages: ThreadsHostToWebviewMessage[] = [];
  public unreadCount = 0;
  public visible = true;

  public postMessage(message: ThreadsHostToWebviewMessage): void {
    this.messages.push(message);
  }

  public isVisible(): boolean {
    return this.visible;
  }

  public setUnreadCount(count: number): void {
    this.unreadCount = count;
  }

  public state() {
    const message = [...this.messages].reverse().find((candidate) =>
      candidate.type === 'threads/conversationLoaded' || candidate.type === 'threads/conversationState'
    );
    assert.ok(message);
    return message.state;
  }
}

function resumeResponse(): ThreadResumeResponse {
  return {
    thread: createThread(),
    model: 'gpt-fixture',
    modelProvider: 'openai',
    serviceTier: null,
    cwd: 'D:\\workspace',
    instructionSources: [],
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandbox: { type: 'readOnly', networkAccess: false },
    reasoningEffort: 'medium'
  };
}

function setup(t: TestContext, overrides: Partial<ConversationCoordinatorOptions> = {}) {
  const calls = { reads: 0, resumes: 0, starts: 0, interrupts: [] as unknown[] };
  const client: ConversationSessionClient = {
    readThread: async () => {
      calls.reads += 1;
      return { thread: createThread() };
    },
    resumeThread: async () => {
      calls.resumes += 1;
      return resumeResponse();
    },
    listModels: async () => ({ data: [], nextCursor: null }),
    startTurn: async () => {
      calls.starts += 1;
      return { turn: createTurn({ id: 'live', status: 'inProgress', completedAt: null }) };
    },
    interruptTurn: async (params) => {
      calls.interrupts.push(params);
      return {};
    }
  };
  const coordinator = new ConversationCoordinator({
    conversationClient: client,
    logger: { appendLine: () => undefined },
    ...overrides
  });
  t.after(() => coordinator.dispose());
  coordinator.setSnapshot({
    pinned: { threads: [], nextCursor: null, loaded: true },
    active: {
      threads: [{
        id: 'thread-1', title: 'Thread 1', description: '', tooltip: new vscode.MarkdownString(),
        cwd: 'D:\\workspace', createdAt: new Date(0), updatedAt: new Date(0), recencyAt: new Date(0),
        statusLabel: 'Idle', iconId: 'comment-discussion', archived: false, pinned: false,
        sourceLabel: 'vscode'
      }],
      nextCursor: null,
      loaded: true
    },
    archive: { threads: [], nextCursor: null, loaded: true }
  });
  coordinator.setConnectionStatus({ kind: 'ready' });
  return { coordinator, client, calls };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 25));
}

async function open(coordinator: ConversationCoordinator, presentation = new Presentation()) {
  const connection = coordinator.attachPresentation(presentation, 'thread-1');
  connection.handleMessage({ type: 'threads/ready' });
  await flush();
  return { presentation, connection, sessionId: presentation.state().sessionId };
}

test('keeps a running session and applies notifications with no presentation attached', async (t) => {
  const { coordinator, calls } = setup(t);
  const first = await open(coordinator);
  first.connection.handleMessage({
    type: 'threads/conversation/send', sessionId: first.sessionId,
    threadId: 'thread-1', requestId: 'send', text: 'Start'
  });
  await flush();
  assert.equal(first.presentation.state().execution.kind, 'running');
  const resumes = calls.resumes;
  first.connection.dispose();
  const oldMessageCount = first.presentation.messages.length;
  coordinator.handleNotification({
    method: 'item/agentMessage/delta',
    params: { threadId: 'thread-1', turnId: 'live', itemId: 'reply', delta: 'Background answer' }
  });
  const second = await open(coordinator);
  assert.equal(calls.reads, 1);
  assert.equal(calls.resumes, resumes);
  assert.equal(calls.starts, 1);
  assert.equal(calls.interrupts.length, 0);
  assert.equal(first.presentation.messages.length, oldMessageCount);
  assert.equal(second.presentation.state().execution.kind, 'running');
  assert.match(JSON.stringify(second.presentation.state().model), /Background answer/u);
  second.connection.handleMessage({
    type: 'threads/conversation/stop', sessionId: second.sessionId,
    threadId: 'thread-1', requestId: 'stop'
  });
  await flush();
  assert.deepEqual(calls.interrupts, [{ threadId: 'thread-1', turnId: 'live' }]);
  second.connection.dispose();
  coordinator.handleNotification({
    method: 'turn/completed',
    params: { threadId: 'thread-1', turn: createTurn({
      id: 'live', status: 'interrupted', items: [{
        type: 'agentMessage', id: 'reply', text: 'Background answer',
        phase: 'final_answer', memoryCitation: null
      }]
    }) }
  });
  const third = await open(coordinator);
  assert.equal(third.presentation.state().execution.kind, 'idle');
  assert.equal(calls.reads, 1);
  assert.equal(calls.resumes, resumes);
});

test('retains drafts, attachments, and runtime settings and rejects a superseded connection', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-coordinator-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'context.txt');
  writeFileSync(path, 'context');
  const { coordinator, calls } = setup(t, {
    pickMentionFiles: async () => [{ path, sizeBytes: 7 }]
  });
  const first = await open(coordinator);
  first.connection.handleMessage({
    type: 'threads/conversation/draft/update', sessionId: first.sessionId,
    threadId: 'thread-1', text: 'Unsent draft'
  });
  first.connection.handleMessage({
    type: 'threads/conversation/attachment/addMention', sessionId: first.sessionId,
    threadId: 'thread-1'
  });
  await flush();
  const before = first.presentation.state();
  assert.equal(before.attachments.length, 1);
  assert.equal(before.runtime.status, 'ready');
  const second = await open(coordinator);
  // Even messages containing the new session ID must not work through the old binding.
  first.connection.handleMessage({
    type: 'threads/conversation/send', sessionId: second.sessionId,
    threadId: 'thread-1', requestId: 'stale-send', text: 'Do not send'
  });
  first.connection.handleMessage({ type: 'threads/back' });
  first.connection.dispose();
  await flush();
  assert.equal(calls.starts, 0);
  assert.equal(coordinator.focusConversationPrompt(), true);
  assert.equal(second.presentation.state().draftText, 'Unsent draft');
  assert.deepEqual(second.presentation.state().attachments, before.attachments);
  assert.deepEqual(second.presentation.state().runtime, before.runtime);
  assert.equal(calls.reads, 1);
  assert.equal(calls.resumes, 1);
});

test('retains server requests while detached and sends an interaction response only once', async (t) => {
  const responses: unknown[] = [];
  const { coordinator } = setup(t, {
    respondToServerRequest: async (id, result) => { responses.push({ id, result }); return true; }
  });
  const first = await open(coordinator);
  first.connection.dispose();
  coordinator.handleServerRequest({
    id: 'approval', method: 'item/commandExecution/requestApproval', params: {
      threadId: 'thread-1', turnId: 'live', itemId: 'command', startedAtMs: 1,
      command: 'npm test', cwd: 'D:\\workspace'
    }
  });
  const second = await open(coordinator);
  const interaction = second.presentation.state().interactions[0];
  assert.ok(interaction);
  const message = {
    type: 'threads/conversation/interaction' as const,
    sessionId: second.sessionId, threadId: 'thread-1', interactionId: interaction.id,
    reply: { kind: 'approval' as const, decision: 'decline' as const }
  };
  first.connection.handleMessage(message);
  assert.equal(responses.length, 0);
  second.connection.handleMessage(message);
  second.connection.handleMessage(message);
  await flush();
  assert.deepEqual(responses, [{ id: 'approval', result: { decision: 'decline' } }]);
  assert.deepEqual(second.presentation.state().interactions, []);
});

test('ignores history from a detached presentation and reuses only the current session', async (t) => {
  let resolveRead!: (value: { thread: ReturnType<typeof createThread> }) => void;
  const pendingRead = new Promise<{ thread: ReturnType<typeof createThread> }>((resolve) => {
    resolveRead = resolve;
  });
  const { coordinator, client, calls } = setup(t);
  const readThread = client.readThread;
  client.readThread = () => pendingRead;
  const first = new Presentation();
  const oldConnection = coordinator.attachPresentation(first, 'thread-1');
  oldConnection.handleMessage({ type: 'threads/ready' });
  client.readThread = readThread;
  const second = await open(coordinator);
  const oldCount = first.messages.length;
  resolveRead({ thread: createThread({ name: 'Obsolete history' }) });
  await flush();
  assert.equal(first.messages.length, oldCount);
  assert.equal(second.presentation.state().model.title, 'Fixture thread');
  const third = await open(coordinator);
  assert.equal(third.presentation.state().model.title, 'Fixture thread');
  assert.equal(calls.reads, 1);
  assert.equal(calls.resumes, 1);
});

test('coordinator disposal invalidates bindings and prevents a pending send from starting', async (t) => {
  const { coordinator, client, calls } = setup(t);
  const first = await open(coordinator);
  let resolveResume!: (value: ThreadResumeResponse) => void;
  client.resumeThread = () => new Promise((resolve) => { resolveResume = resolve; });
  first.connection.handleMessage({
    type: 'threads/conversation/send', sessionId: first.sessionId,
    threadId: 'thread-1', requestId: 'pending', text: 'Start'
  });
  coordinator.dispose();
  const count = first.presentation.messages.length;
  resolveResume(resumeResponse());
  first.connection.handleMessage({ type: 'threads/ready' });
  await flush();
  assert.equal(calls.starts, 0);
  assert.equal(first.presentation.messages.length, count);
  assert.throws(() => coordinator.attachPresentation(new Presentation()), /disposed/u);
});
