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
import type { ThreadsHostToWebviewMessage } from '../../src/webview/protocol';
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

async function openEditor(coordinator: ConversationCoordinator) {
  const presentation = new Presentation();
  const connection = coordinator.attachPresentation(presentation, 'thread-1', { id: 'thread-1', title: 'Thread 1' });
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

test('switches a streaming turn between sidebar and editor without resuming or starting again', async (t) => {
  const { coordinator, calls } = setup(t);
  const sidebar = await open(coordinator);
  sidebar.connection.handleMessage({
    type: 'threads/conversation/send', sessionId: sidebar.sessionId,
    threadId: 'thread-1', requestId: 'send', text: 'Start'
  });
  await flush();
  const resumes = calls.resumes;
  const editor = await openEditor(coordinator);
  assert.ok(sidebar.presentation.messages.some((message) => message.type === 'threads/showList'));
  const sidebarCount = sidebar.presentation.messages.length;
  sidebar.connection.handleMessage({
    type: 'threads/conversation/stop', sessionId: editor.sessionId,
    threadId: 'thread-1', requestId: 'stale-stop'
  });
  coordinator.handleNotification({
    method: 'item/agentMessage/delta',
    params: { threadId: 'thread-1', turnId: 'live', itemId: 'reply', delta: 'Editor stream' }
  });
  await flush();
  assert.equal(calls.interrupts.length, 0);
  assert.equal(sidebar.presentation.messages.length, sidebarCount);
  assert.match(JSON.stringify(editor.presentation.state().model), /Editor stream/u);
  editor.connection.handleMessage({
    type: 'threads/openSidebar', sessionId: editor.sessionId, threadId: 'thread-1'
  });
  await flush();
  const resumedSidebar = sidebar.presentation.state();
  assert.equal(resumedSidebar.execution.kind, 'running');
  assert.match(JSON.stringify(resumedSidebar.model), /Editor stream/u);
  editor.connection.handleMessage({
    type: 'threads/conversation/stop', sessionId: resumedSidebar.sessionId,
    threadId: 'thread-1', requestId: 'stale-editor-stop'
  });
  sidebar.connection.handleMessage({
    type: 'threads/conversation/stop', sessionId: resumedSidebar.sessionId,
    threadId: 'thread-1', requestId: 'stop'
  });
  await flush();
  assert.deepEqual(calls.interrupts, [{ threadId: 'thread-1', turnId: 'live' }]);
  assert.equal(calls.starts, 1);
  assert.equal(calls.reads, 1);
  assert.equal(calls.resumes, resumes);
});

test('allows the passive sidebar to reopen a conversation and keeps list updates live', async (t) => {
  const opened: string[] = [];
  const { coordinator } = setup(t, { onOpenEditor: (reference) => opened.push(reference.id) });
  const sidebar = await open(coordinator);
  const editor = await openEditor(coordinator);
  const editorCount = editor.presentation.messages.length;
  coordinator.setConnectionStatus({ kind: 'connecting' });
  const list = sidebar.presentation.messages.at(-1);
  assert.equal(list?.type, 'threads/listState');
  if (list?.type === 'threads/listState') assert.equal(list.status.kind, 'connecting');
  sidebar.connection.handleMessage({ type: 'threads/openEditor', threadId: 'thread-1' });
  sidebar.connection.handleMessage({ type: 'threads/openEditor', threadId: 'unknown' });
  assert.deepEqual(opened, ['thread-1']);
  sidebar.connection.handleMessage({ type: 'threads/open', threadId: 'thread-1' });
  await flush();
  assert.notEqual(sidebar.presentation.state().sessionId, sidebar.sessionId);
  assert.equal(editor.presentation.messages.length, editorCount);
  assert.equal(coordinator.focusConversationPrompt(), true);
});

test('opens an editor without a sidebar and transfers to a lazily resolved sidebar', async (t) => {
  let resolveReveal!: () => void;
  const { coordinator, calls } = setup(t, {
    revealSidebar: () => new Promise<void>((resolve) => { resolveReveal = resolve; })
  });
  const editor = await openEditor(coordinator);
  editor.connection.handleMessage({
    type: 'threads/conversation/draft/update', sessionId: editor.sessionId,
    threadId: 'thread-1', text: 'Preserve this draft'
  });
  editor.connection.handleMessage({
    type: 'threads/openSidebar', sessionId: editor.sessionId, threadId: 'thread-1'
  });
  const sidebar = await open(coordinator);
  resolveReveal();
  await flush();
  assert.equal(sidebar.presentation.state().draftText, 'Preserve this draft');
  assert.equal(calls.reads, 1);
  assert.equal(calls.resumes, 1);
});

test('resolving a sidebar while an editor is active leaves the editor in control', async (t) => {
  const { coordinator } = setup(t);
  const editor = await openEditor(coordinator);
  const sidebar = new Presentation();
  const connection = coordinator.attachPresentation(sidebar, 'thread-1');
  connection.handleMessage({ type: 'threads/ready' });
  assert.ok(sidebar.messages.some((message) => message.type === 'threads/showList'));
  assert.ok(sidebar.messages.every((message) => message.type !== 'threads/conversationLoaded'));
  coordinator.focusConversationPrompt();
  assert.equal(editor.presentation.messages.at(-1)?.type, 'threads/focusConversationPrompt');
});

test('a pending send clears only its own draft after moving to the editor', async (t) => {
  const { coordinator, client, calls } = setup(t);
  const sidebar = await open(coordinator);
  let resolveStart!: (value: Awaited<ReturnType<ConversationSessionClient['startTurn']>>) => void;
  client.startTurn = () => new Promise((resolve) => { resolveStart = resolve; });
  sidebar.connection.handleMessage({
    type: 'threads/conversation/send', sessionId: sidebar.sessionId,
    threadId: 'thread-1', requestId: 'pending', text: 'First message'
  });
  await flush();
  const resumes = calls.resumes;
  const editor = await openEditor(coordinator);
  assert.equal(editor.presentation.state().draftText, 'First message');
  editor.connection.handleMessage({
    type: 'threads/conversation/draft/update', sessionId: editor.sessionId,
    threadId: 'thread-1', text: 'Next message'
  });
  resolveStart({ turn: createTurn({ id: 'live', status: 'inProgress' }) });
  await flush();
  assert.equal(editor.presentation.state().draftText, 'Next message');
  assert.equal(editor.presentation.state().execution.kind, 'running');
  assert.equal(calls.resumes, resumes);
});

test('stops in the editor, returns to the sidebar, and sends again after completion', async (t) => {
  const { coordinator, calls } = setup(t);
  const sidebar = await open(coordinator);
  const editor = await openEditor(coordinator);
  editor.connection.handleMessage({
    type: 'threads/conversation/send', sessionId: editor.sessionId,
    threadId: 'thread-1', requestId: 'send', text: 'First'
  });
  await flush();
  editor.connection.handleMessage({
    type: 'threads/conversation/stop', sessionId: editor.sessionId,
    threadId: 'thread-1', requestId: 'stop'
  });
  editor.connection.handleMessage({
    type: 'threads/openSidebar', sessionId: editor.sessionId, threadId: 'thread-1'
  });
  await flush();
  coordinator.handleNotification({
    method: 'turn/completed', params: { threadId: 'thread-1', turn: createTurn({ id: 'live', status: 'interrupted' }) }
  });
  await flush();
  assert.equal(sidebar.presentation.state().execution.kind, 'idle');
  sidebar.connection.handleMessage({
    type: 'threads/conversation/send', sessionId: sidebar.presentation.state().sessionId,
    threadId: 'thread-1', requestId: 'next', text: 'Next'
  });
  await flush();
  assert.equal(calls.starts, 2);
  assert.equal(calls.interrupts.length, 1);
});

test('keeps a pending reload when moving to the editor without issuing a second resume', async (t) => {
  const { coordinator, client, calls } = setup(t);
  const sidebar = await open(coordinator);
  let resolveResume!: (value: ThreadResumeResponse) => void;
  let resumes = 0;
  client.resumeThread = () => {
    resumes += 1;
    return new Promise((resolve) => { resolveResume = resolve; });
  };
  sidebar.connection.handleMessage({ type: 'threads/reload' });
  const editor = await openEditor(coordinator);
  resolveResume(resumeResponse());
  await flush();
  assert.equal(resumes, 1);
  assert.equal(calls.reads, 2);
  assert.equal(editor.presentation.state().execution.kind, 'idle');
  assert.equal(coordinator.focusConversationPrompt(), true);
});

test('a late sidebar reveal cannot replace a newer editor selection', async (t) => {
  let resolveReveal!: () => void;
  const { coordinator } = setup(t, {
    revealSidebar: () => new Promise<void>((resolve) => { resolveReveal = resolve; })
  });
  await open(coordinator);
  const first = await openEditor(coordinator);
  first.connection.handleMessage({
    type: 'threads/openSidebar', sessionId: first.sessionId, threadId: 'thread-1'
  });
  const second = await openEditor(coordinator);
  resolveReveal();
  await flush();
  coordinator.focusConversationPrompt();
  assert.equal(second.presentation.messages.at(-1)?.type, 'threads/focusConversationPrompt');
  assert.equal(second.presentation.state().sessionId, second.sessionId);
});

function imageModel() {
  return {
    id: 'gpt-fixture', model: 'gpt-fixture', upgrade: null, upgradeInfo: null,
    availabilityNux: null, displayName: 'Fixture', description: '', hidden: false,
    supportedReasoningEfforts: [{ reasoningEffort: 'medium' as const, description: '' }],
    defaultReasoningEffort: 'medium' as const, inputModalities: ['text', 'image'] as ('text' | 'image')[],
    supportsPersonality: false, additionalSpeedTiers: ['fast'],
    serviceTiers: [{ id: 'priority', name: 'Fast', description: '' }],
    defaultServiceTier: null, isDefault: true
  };
}

for (const kind of ['Image', 'Mention', 'Skill'] as const) {
  test(`keeps a pending ${kind} selection across presentation changes`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'codex-phase3-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, kind === 'Image' ? 'image.png' : kind === 'Skill' ? 'SKILL.md' : 'context.txt');
    writeFileSync(path, 'fixture');
    const picked = { path, sizeBytes: 7, name: 'fixture', description: 'Fixture skill' };
    let finish!: (value: (typeof picked)[]) => void;
    const picker = () => new Promise<(typeof picked)[]>((resolve) => { finish = resolve; });
    const { coordinator, client, calls } = setup(t, {
      pickLocalImages: picker, pickMentionFiles: picker, pickSkills: picker
    });
    client.listModels = async () => ({ data: [imageModel()], nextCursor: null });
    const sidebar = await open(coordinator);
    sidebar.connection.handleMessage({
      type: `threads/conversation/attachment/add${kind}`,
      sessionId: sidebar.sessionId, threadId: 'thread-1'
    });
    const editor = await openEditor(coordinator);
    finish([picked]);
    await flush();
    assert.equal(editor.presentation.state().attachments.length, 1);
    const attachments = editor.presentation.state().attachments;
    assert.equal(JSON.stringify(attachments).includes(directory), false);
    editor.connection.handleMessage({
      type: 'threads/openSidebar', sessionId: editor.sessionId, threadId: 'thread-1'
    });
    await flush();
    assert.deepEqual(sidebar.presentation.state().attachments, attachments);
    assert.equal(calls.resumes, 1);
    assert.equal(calls.starts, 0);
  });
}

test('ignores a pending picker after leaving the conversation or disposing the coordinator', async (t) => {
  for (const dispose of [false, true]) {
    let finish!: (value: { path: string; sizeBytes: number }[]) => void;
    const { coordinator } = setup(t, {
      pickMentionFiles: () => new Promise((resolve) => { finish = resolve; })
    });
    const sidebar = await open(coordinator);
    sidebar.connection.handleMessage({
      type: 'threads/conversation/attachment/addMention', sessionId: sidebar.sessionId, threadId: 'thread-1'
    });
    if (dispose) coordinator.dispose();
    else sidebar.connection.handleMessage({ type: 'threads/back' });
    const count = sidebar.presentation.messages.length;
    finish([{ path: '/workspace/late.txt', sizeBytes: 7 }]);
    await flush();
    assert.equal(sidebar.presentation.messages.length, count);
    if (!dispose) {
      const reopened = await open(coordinator);
      assert.deepEqual(reopened.presentation.state().attachments, []);
    }
  }
});

test('publishes a bookmark saved after moving to the editor and prevents duplicate writes', async (t) => {
  let finish!: () => void;
  let saved = false;
  let writes = 0;
  const { coordinator, client } = setup(t, {
    turnBookmarkStore: {
      getBookmarks: () => saved ? [{ turnId: 'turn-1', itemId: 'reply' }] : [],
      setBookmarked: async () => {
        writes += 1;
        await new Promise<void>((resolve) => { finish = resolve; });
        saved = true;
      }
    }
  });
  client.readThread = async () => ({ thread: createThread({ turns: [createTurn({ items: [{
    type: 'agentMessage', id: 'reply', text: 'Bookmark me', phase: 'final_answer', memoryCitation: null
  }] })] }) });
  const sidebar = await open(coordinator);
  const toggle = {
    type: 'threads/conversation/bookmark/toggle' as const, threadId: 'thread-1',
    turnId: 'turn-1', itemId: 'reply'
  };
  sidebar.connection.handleMessage({ ...toggle, sessionId: sidebar.sessionId });
  const editor = await openEditor(coordinator);
  editor.connection.handleMessage({ ...toggle, sessionId: editor.sessionId });
  assert.equal(writes, 1);
  finish();
  await flush();
  assert.equal(editor.presentation.state().bookmarkedMessages.length, 1);
});

test('preserves runtime choices on a round trip and uses them for the next editor turn', async (t) => {
  const { coordinator, client } = setup(t);
  client.listModels = async () => ({ data: [imageModel()], nextCursor: null });
  const sidebar = await open(coordinator);
  const settings = {
    model: 'gpt-fixture', effort: 'medium' as const, serviceTier: 'priority',
    sandbox: 'workspace-write' as const, approvalPolicy: 'on-request' as const, approvalsReviewer: 'user' as const
  };
  sidebar.connection.handleMessage({
    type: 'threads/conversation/settings', sessionId: sidebar.sessionId, threadId: 'thread-1', settings
  });
  await flush();
  const before = sidebar.presentation.state().runtime;
  assert.equal(before.serviceTier, 'priority');
  const editor = await openEditor(coordinator);
  assert.deepEqual(editor.presentation.state().runtime, before);
  editor.connection.handleMessage({ type: 'threads/openSidebar', sessionId: editor.sessionId, threadId: 'thread-1' });
  await flush();
  assert.deepEqual(sidebar.presentation.state().runtime, before);
  const again = await openEditor(coordinator);
  let resumed: Parameters<ConversationSessionClient['resumeThread']>[0] | undefined;
  client.resumeThread = async (params) => {
    resumed = params;
    return resumeResponse();
  };
  let sent: Parameters<ConversationSessionClient['startTurn']>[0] | undefined;
  client.startTurn = async (params) => {
    sent = params;
    return { turn: createTurn({ id: 'live', status: 'inProgress' }) };
  };
  again.connection.handleMessage({
    type: 'threads/conversation/send', sessionId: again.sessionId, threadId: 'thread-1', requestId: 'send', text: 'Configured'
  });
  await flush();
  assert.equal(sent?.serviceTier, 'priority');
  assert.equal(sent?.model, settings.model);
  assert.equal(sent?.effort, settings.effort);
  assert.equal(sent?.approvalPolicy, settings.approvalPolicy);
  assert.equal(resumed?.sandbox, settings.sandbox);
  assert.equal(resumed?.approvalsReviewer, settings.approvalsReviewer);
});

for (const kind of ['approval', 'userInput', 'mcp'] as const) {
  test(`answers ${kind} only once in the current presentation after a round trip`, async (t) => {
    const responses: unknown[] = [];
    const { coordinator } = setup(t, {
      respondToServerRequest: async (id, result) => { responses.push({ id, result }); return true; }
    });
    const sidebar = await open(coordinator);
    const common = { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1' };
    if (kind === 'approval') {
      coordinator.handleServerRequest({ id: kind, method: 'item/commandExecution/requestApproval', params: {
        ...common, startedAtMs: 1, command: 'npm test', cwd: 'D:\\workspace'
      } });
    } else if (kind === 'userInput') {
      coordinator.handleServerRequest({ id: kind, method: 'item/tool/requestUserInput', params: {
        ...common, autoResolutionMs: null, questions: [{
          id: 'color', header: 'Color', question: 'Choose', isOther: true, isSecret: false,
          options: [{ label: 'Blue', description: 'Use blue' }]
        }]
      } });
    } else {
      coordinator.handleServerRequest({ id: kind, method: 'mcpServer/elicitation/request', params: {
        threadId: 'thread-1', turnId: 'turn-1', serverName: 'fixture', mode: 'form', _meta: null,
        message: 'Configure', requestedSchema: {
          type: 'object', properties: { name: { type: 'string' } }, required: ['name']
        }
      } });
    }
    const editor = await openEditor(coordinator);
    const interaction = editor.presentation.state().interactions[0];
    assert.ok(interaction);
    const reply = kind === 'approval'
      ? { kind, decision: 'decline' as const }
      : kind === 'userInput'
        ? { kind, answers: { color: ['Blue'] } }
        : { kind, action: 'accept' as const, values: { name: 'demo' } };
    const message = {
      type: 'threads/conversation/interaction' as const, threadId: 'thread-1',
      interactionId: interaction.id, reply
    };
    sidebar.connection.handleMessage({ ...message, sessionId: editor.sessionId });
    assert.equal(responses.length, 0);
    editor.connection.handleMessage({ type: 'threads/openSidebar', sessionId: editor.sessionId, threadId: 'thread-1' });
    await flush();
    const state = sidebar.presentation.state();
    assert.deepEqual(state.interactions, editor.presentation.state().interactions);
    editor.connection.handleMessage({ ...message, sessionId: state.sessionId });
    assert.equal(responses.length, 0);
    sidebar.connection.handleMessage({ ...message, sessionId: state.sessionId });
    sidebar.connection.handleMessage({ ...message, sessionId: state.sessionId });
    await flush();
    assert.deepEqual(responses, [{ id: kind, result: kind === 'approval'
      ? { decision: 'decline' }
      : kind === 'userInput'
        ? { answers: { color: { answers: ['Blue'] } } }
        : { action: 'accept', content: { name: 'demo' }, _meta: null }
    }]);
    assert.deepEqual(sidebar.presentation.state().interactions, []);
  });
}

test('discards a Skill search from the old screen and allows a fresh editor selection', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-phase3-skill-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'SKILL.md');
  writeFileSync(path, 'fixture');
  const { coordinator, client } = setup(t);
  const result = { data: [{ cwd: 'D:\\workspace', errors: [], skills: [{
    name: 'fixture', description: 'Fixture', path, scope: 'user' as const,
    enabled: true
  }] }] };
  let finish!: (value: typeof result) => void;
  client.listSkills = () => new Promise((resolve) => { finish = resolve; });
  const sidebar = await open(coordinator);
  sidebar.connection.handleMessage({
    type: 'threads/conversation/suggestion/search', sessionId: sidebar.sessionId,
    threadId: 'thread-1', requestId: 'old', kind: 'skill', query: 'fixture'
  });
  const editor = await openEditor(coordinator);
  finish(result);
  await flush();
  assert.equal(editor.presentation.messages.some((message) => message.type === 'threads/conversationSuggestions'), false);
  client.listSkills = async () => result;
  editor.connection.handleMessage({
    type: 'threads/conversation/suggestion/search', sessionId: editor.sessionId,
    threadId: 'thread-1', requestId: 'new', kind: 'skill', query: 'fixture'
  });
  await flush();
  const suggestions = editor.presentation.messages.find((message) => message.type === 'threads/conversationSuggestions');
  assert.ok(suggestions && suggestions.type === 'threads/conversationSuggestions');
  const candidate = suggestions.suggestions[0];
  assert.ok(candidate);
  editor.connection.handleMessage({
    type: 'threads/conversation/suggestion/select', sessionId: editor.sessionId,
    threadId: 'thread-1', requestId: 'new', suggestionId: candidate.id
  });
  await flush();
  editor.connection.handleMessage({ type: 'threads/openSidebar', sessionId: editor.sessionId, threadId: 'thread-1' });
  await flush();
  assert.equal(sidebar.presentation.state().attachments[0]?.kind, 'skill');
});

test('keeps context usage across presentation changes and routes account usage to the active screen', async (t) => {
  const { coordinator, client } = setup(t);
  client.readThread = async () => ({ thread: createThread({ turns: [createTurn()] }) });
  const sidebar = await open(coordinator);
  const breakdown = {
    totalTokens: 25000, inputTokens: 20000, cachedInputTokens: 5000,
    outputTokens: 5000, reasoningOutputTokens: 2000
  };
  coordinator.handleNotification({ method: 'thread/tokenUsage/updated', params: {
    threadId: 'thread-1', turnId: 'turn-1',
    tokenUsage: { total: breakdown, last: breakdown, modelContextWindow: 100000 }
  } });
  const expected = sidebar.presentation.state().contextWindow;
  assert.ok(expected);
  const editor = await openEditor(coordinator);
  assert.deepEqual(editor.presentation.state().contextWindow, expected);
  const sidebarCount = sidebar.presentation.messages.length;
  coordinator.handleNotification({ method: 'account/rateLimits/updated', params: { rateLimits: {
    limitId: 'codex', limitName: null,
    primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1750000000 },
    secondary: null, credits: null, individualLimit: null, planType: null, rateLimitReachedType: null
  } } });
  const usage = editor.presentation.messages.at(-1);
  assert.ok(usage?.type === 'threads/conversationUsage');
  assert.equal(usage.usage?.primary?.remainingPercent, 75);
  assert.equal(sidebar.presentation.messages.length, sidebarCount);
  editor.connection.handleMessage({ type: 'threads/openSidebar', sessionId: editor.sessionId, threadId: 'thread-1' });
  await flush();
  assert.deepEqual(sidebar.presentation.state().contextWindow, expected);
});

test('reload shortcut requires focus on the visible conversation and coalesces repeated reloads', async (t) => {
  const focus: boolean[] = [];
  const { coordinator, client, calls } = setup(t, { onConversationFocusChange: (value) => focus.push(value) });
  const sidebar = await open(coordinator);
  coordinator.reloadFocusedConversation();
  assert.equal(calls.resumes, 1);
  let finish!: (value: ThreadResumeResponse) => void;
  let reloads = 0;
  client.resumeThread = () => { reloads += 1; return new Promise((resolve) => { finish = resolve; }); };
  sidebar.connection.handleMessage({ type: 'threads/viewFocus', focused: true });
  assert.equal(focus.at(-1), true);
  coordinator.reloadFocusedConversation();
  coordinator.reloadFocusedConversation();
  assert.equal(reloads, 1);
  finish(resumeResponse());
  await flush();
  sidebar.connection.handleMessage({ type: 'threads/viewFocus', focused: false });
  coordinator.reloadFocusedConversation();
  assert.equal(reloads, 1);
  sidebar.connection.handleMessage({ type: 'threads/viewFocus', focused: true });
  sidebar.presentation.visible = false;
  sidebar.connection.visibilityChanged();
  assert.equal(focus.at(-1), false);
  coordinator.reloadFocusedConversation();
  assert.equal(reloads, 1);
  sidebar.presentation.visible = true;
  sidebar.connection.handleMessage({ type: 'threads/back' });
  sidebar.connection.handleMessage({ type: 'threads/viewFocus', focused: true });
  assert.equal(focus.at(-1), false);
  coordinator.reloadFocusedConversation();
  assert.equal(reloads, 1);
});

test('toggle shortcut switches both ways only from the focused conversation and preserves drafts', async (t) => {
  const opened: string[] = [];
  const { coordinator, calls } = setup(t, { onOpenEditor: (reference) => opened.push(reference.id) });
  const sidebar = await open(coordinator);
  sidebar.connection.handleMessage({ type: 'threads/conversation/draft/update', sessionId: sidebar.sessionId,
    threadId: 'thread-1', text: 'Shortcut draft' });
  coordinator.toggleFocusedConversationLocation();
  assert.deepEqual(opened, []);
  sidebar.connection.handleMessage({ type: 'threads/viewFocus', focused: true });
  coordinator.toggleFocusedConversationLocation();
  assert.deepEqual(opened, ['thread-1']);
  sidebar.connection.handleMessage({ type: 'threads/viewFocus', focused: false });
  const editor = await openEditor(coordinator);
  assert.equal(editor.presentation.state().draftText, 'Shortcut draft');
  // The passive sidebar cannot give the active editor keyboard ownership.
  sidebar.connection.handleMessage({ type: 'threads/viewFocus', focused: true });
  coordinator.toggleFocusedConversationLocation();
  assert.equal(editor.presentation.state().sessionId, editor.sessionId);
  editor.connection.handleMessage({ type: 'threads/viewFocus', focused: true });
  coordinator.toggleFocusedConversationLocation();
  await flush();
  assert.equal(sidebar.presentation.state().draftText, 'Shortcut draft');
  assert.notEqual(sidebar.presentation.state().sessionId, sidebar.sessionId);
  assert.equal(calls.resumes, 1);
  assert.equal(calls.starts, 0);
});

test('scroll shortcuts read the current distance and reject unfocused or stale presentations', async (t) => {
  let amount = 400;
  const { coordinator } = setup(t, { readConversationScrollAmount: () => amount });
  const sidebar = await open(coordinator);
  const scrolls = () => sidebar.presentation.messages.filter((message) => message.type === 'threads/scrollConversation');
  coordinator.scrollFocusedConversation('down');
  assert.equal(scrolls().length, 0);
  sidebar.connection.handleMessage({ type: 'threads/viewFocus', focused: true });
  coordinator.scrollFocusedConversation('down');
  assert.deepEqual(scrolls().at(-1), { type: 'threads/scrollConversation', sessionId: sidebar.sessionId,
    threadId: 'thread-1', pixels: 400 });
  amount = 125;
  coordinator.scrollFocusedConversation('up');
  assert.equal(scrolls().at(-1)?.pixels, -125);
  amount = Number.NaN;
  coordinator.scrollFocusedConversation('down');
  assert.equal(scrolls().at(-1)?.pixels, 400);
  const editor = await openEditor(coordinator);
  sidebar.connection.handleMessage({ type: 'threads/viewFocus', focused: true });
  coordinator.scrollFocusedConversation('down');
  assert.equal(editor.presentation.messages.some((message) => message.type === 'threads/scrollConversation'), false);
  editor.connection.handleMessage({ type: 'threads/viewFocus', focused: true });
  coordinator.scrollFocusedConversation('up');
  assert.deepEqual(editor.presentation.messages.at(-1), { type: 'threads/scrollConversation', sessionId: editor.sessionId,
    threadId: 'thread-1', pixels: -400 });
  assert.equal(scrolls().length, 3);
});
