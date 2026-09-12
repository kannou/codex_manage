import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import * as vscode from 'vscode';
import type { Thread } from '../../src/codex/protocol/generated/v2/Thread';
import {
  CONVERSATION_VIEW_TYPE,
  ConversationPanelManager
} from '../../src/conversation/conversationPanelManager';
import { ConversationCoordinator } from '../../src/conversation/conversationCoordinator';
import { createThread, createTurn } from '../support/threadFixture';

function createManager(t: TestContext, options: {
  extensionUri: vscode.Uri;
  readThread: (threadId: string) => Promise<Thread>;
  onResume?: () => void;
  logger: { appendLine(value: string): void };
}): { manager: ConversationPanelManager; coordinator: ConversationCoordinator } {
  const coordinator = new ConversationCoordinator({
    conversationClient: {
      readThread: async ({ threadId }) => ({ thread: await options.readThread(threadId) }),
      resumeThread: async ({ threadId }) => {
        options.onResume?.();
        return {
          thread: createThread({ id: threadId }), model: 'gpt-fixture', modelProvider: 'openai',
          serviceTier: null, cwd: 'D:\\workspace', instructionSources: [], approvalPolicy: 'on-request',
          approvalsReviewer: 'user', sandbox: { type: 'readOnly', networkAccess: false }, reasoningEffort: 'medium'
        };
      },
      listModels: async () => ({ data: [], nextCursor: null }),
      startTurn: async () => { throw new Error('Unexpected turn/start'); },
      interruptTurn: async () => { throw new Error('Unexpected turn/interrupt'); }
    },
    logger: options.logger
  });
  t.after(() => coordinator.dispose());
  return { manager: new ConversationPanelManager({ ...options, coordinator }), coordinator };
}

type Listener<T> = (event: T) => unknown;

class FakeWebview {
  public readonly cspSource = 'vscode-webview-resource:';
  public options: vscode.WebviewOptions = {};
  public html = '';
  public readonly postedMessages: unknown[] = [];
  private readonly listeners = new Set<Listener<unknown>>();

  public asWebviewUri(uri: vscode.Uri): vscode.Uri {
    return vscode.Uri.file(`webview${uri.fsPath}`);
  }

  public onDidReceiveMessage(listener: Listener<unknown>): vscode.Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  public async postMessage(message: unknown): Promise<boolean> {
    this.postedMessages.push(message);
    return true;
  }

  public fire(message: unknown): void {
    for (const listener of this.listeners) {
      listener(message);
    }
  }
}

class FakeWebviewPanel {
  public title = '';
  public active = true;
  public visible = true;
  private readonly viewStateListeners = new Set<Listener<void>>();
  public onDidChangeViewState(listener: Listener<void>): vscode.Disposable {
    this.viewStateListeners.add(listener);
    return { dispose: () => this.viewStateListeners.delete(listener) };
  }
  public setActive(active: boolean): void {
    this.active = active;
    for (const listener of this.viewStateListeners) listener();
  }
  public readonly webview = new FakeWebview();
  public revealCount = 0;
  public disposed = false;
  private readonly disposeListeners = new Set<Listener<void>>();

  public reveal(): void {
    this.revealCount += 1;
  }

  public onDidDispose(listener: Listener<void>): vscode.Disposable {
    this.disposeListeners.add(listener);
    return { dispose: () => this.disposeListeners.delete(listener) };
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const listener of this.disposeListeners) {
      listener();
    }
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value) => resolvePromise?.(value)
  };
}

function installPanelFactory(createdPanels: FakeWebviewPanel[]): void {
  (vscode.window as unknown as {
    createWebviewPanel: (
      viewType: string,
      title: string,
      column: vscode.ViewColumn,
      options: vscode.WebviewPanelOptions & vscode.WebviewOptions
    ) => vscode.WebviewPanel;
  }).createWebviewPanel = (viewType, title, _column, options) => {
    assert.equal(viewType, CONVERSATION_VIEW_TYPE);
    assert.equal(options.enableScripts, true);
    const panel = new FakeWebviewPanel();
    panel.title = title;
    createdPanels.push(panel);
    return panel as unknown as vscode.WebviewPanel;
  };
}

async function flushPromises(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test('reuses one panel per thread and loads only after the ready handshake', async (t) => {
  const panels: FakeWebviewPanel[] = [];
  installPanelFactory(panels);
  let readCount = 0;
  const { manager } = createManager(t, {
    extensionUri: vscode.Uri.file('D:\\extension'),
    readThread: async () => {
      readCount += 1;
      return createThread({ name: 'Loaded title' });
    },
    logger: { appendLine: () => undefined }
  });
  t.after(() => manager.dispose());

  manager.openThread({ id: 'thread-1', title: 'Thread 1' });
  manager.openThread({ id: 'thread-1', title: 'Updated title' });

  assert.equal(panels.length, 1);
  assert.equal(panels[0]?.revealCount, 1);
  assert.equal(readCount, 0);

  panels[0]?.webview.fire({ type: 'threads/ready' });
  await flushPromises();

  assert.equal(readCount, 1);
  assert.equal(panels[0]?.title, 'Loaded title');
  assert.deepEqual(
    panels[0]?.webview.postedMessages.map((message) =>
      (message as { type?: unknown }).type
    ),
    ['threads/reduceMotion', 'threads/conversationLoading', 'threads/conversationLoaded']
  );
});

test('drops a stale thread/read result after a newer reload completes', async (t) => {
  const panels: FakeWebviewPanel[] = [];
  installPanelFactory(panels);
  const reads: Deferred<Thread>[] = [];
  const { manager } = createManager(t, {
    extensionUri: vscode.Uri.file('D:\\extension'),
    readThread: () => {
      const read = deferred<Thread>();
      reads.push(read);
      return read.promise;
    },
    logger: { appendLine: () => undefined }
  });
  t.after(() => manager.dispose());

  manager.openThread({ id: 'thread-1', title: 'Thread 1' });
  panels[0]?.webview.fire({ type: 'threads/ready' });
  panels[0]?.webview.fire({ type: 'threads/reload' });
  assert.equal(reads.length, 2);

  reads[1]?.resolve(createThread({ name: 'Newest history' }));
  await flushPromises();
  reads[0]?.resolve(createThread({ name: 'Stale history' }));
  await flushPromises();

  const loaded = panels[0]?.webview.postedMessages.filter(
    (message) => (message as { type?: unknown }).type === 'threads/conversationLoaded'
  ) as Array<{ state: { model: { title: string } } }>;
  assert.deepEqual(loaded.map((message) => message.state.model.title), ['Newest history']);
  assert.equal(panels[0]?.title, 'Newest history');
});

test('restores a valid panel and rejects invalid persisted state', async (t) => {
  const warnings: string[] = [];
  (vscode.window as unknown as {
    showWarningMessage: (message: string) => Promise<string | undefined>;
  }).showWarningMessage = async (message) => {
    warnings.push(message);
    return undefined;
  };
  const { manager } = createManager(t, {
    extensionUri: vscode.Uri.file('D:\\extension'),
    readThread: async () => createThread(),
    logger: { appendLine: () => undefined }
  });
  t.after(() => manager.dispose());

  const restored = new FakeWebviewPanel();
  await manager.deserializeWebviewPanel(
    restored as unknown as vscode.WebviewPanel,
    { version: 1, threadId: 'thread-1', title: 'Restored thread' }
  );
  assert.equal(restored.title, 'Restored thread');
  assert.match(restored.webview.html, /data-thread-id="thread-1"/u);

  const invalid = new FakeWebviewPanel();
  await manager.deserializeWebviewPanel(
    invalid as unknown as vscode.WebviewPanel,
    { version: 99, threadId: 'thread-2', title: 'Invalid' }
  );
  assert.equal(invalid.disposed, true);
  assert.equal(warnings.length, 1);
});

test('opens only validated changed and linked workspace files', async (t) => {
  (vscode.workspace as unknown as {
    workspaceFolders: Array<{ name: string; uri: { fsPath: string } }>;
  }).workspaceFolders = [{ name: 'workspace', uri: { fsPath: 'D:\\workspace' } }];
  const opened: string[] = [];
  const selections: Array<{ line: number; character: number } | undefined> = [];
  (vscode.window as unknown as {
    showTextDocument: (
      uri: vscode.Uri,
      options?: { selection?: { start: { line: number; character: number } } }
    ) => Promise<unknown>;
  }).showTextDocument = async (uri, options) => {
    opened.push(uri.fsPath);
    const start = options?.selection?.start;
    selections.push(start ? { line: start.line, character: start.character } : undefined);
    return {};
  };
  const panels: FakeWebviewPanel[] = [];
  installPanelFactory(panels);
  const { manager } = createManager(t, {
    extensionUri: vscode.Uri.file('D:\\extension'),
    readThread: async () => createThread({
      turns: [{
        id: 'turn-files',
        items: [{
          type: 'fileChange',
          id: 'file-change',
          changes: [
            { path: 'src/example.ts', kind: { type: 'update', move_path: null }, diff: '' },
            { path: 'src/deleted.ts', kind: { type: 'delete' }, diff: '' }
          ],
          status: 'completed'
        }],
        itemsView: 'full',
        status: 'completed',
        error: null,
        startedAt: 1,
        completedAt: 2,
        durationMs: 1_000
      }]
    }),
    logger: { appendLine: () => undefined }
  });
  t.after(() => manager.dispose());

  manager.openThread({ id: 'thread-1', title: 'Thread 1' });
  panels[0]?.webview.fire({ type: 'threads/ready' });
  await flushPromises();
  const loaded = panels[0]?.webview.postedMessages.find(
    (message) => (message as { type?: unknown }).type === 'threads/conversationLoaded'
  ) as {
    state: { sessionId: string; model: {
      turns: Array<{
        id: string;
        changedFiles: Array<{ id: string; canOpen: boolean }>;
      }>;
    } };
  };
  const changedFiles = loaded.state.model.turns[0]?.changedFiles ?? [];
  const openable = changedFiles.find((file) => file.canOpen);
  const deleted = changedFiles.find((file) => !file.canOpen);
  assert.ok(openable);
  assert.ok(deleted);

  panels[0]?.webview.fire({
    type: 'threads/conversation/openChangedFile',
    sessionId: loaded.state.sessionId, threadId: 'thread-1',
    turnId: 'turn-files',
    fileId: openable.id
  });
  panels[0]?.webview.fire({
    type: 'threads/conversation/openChangedFile',
    sessionId: loaded.state.sessionId, threadId: 'thread-1',
    turnId: 'turn-files',
    fileId: deleted.id
  });
  panels[0]?.webview.fire({
    type: 'threads/conversation/openChangedFile',
    sessionId: loaded.state.sessionId, threadId: 'thread-1',
    turnId: 'turn-stale',
    fileId: openable.id
  });
  panels[0]?.webview.fire({
    type: 'threads/conversation/openFileLink',
    sessionId: loaded.state.sessionId, threadId: 'thread-1',
    fileLink: 'src/example.ts:12:4'
  });
  panels[0]?.webview.fire({
    type: 'threads/conversation/openFileLink',
    sessionId: loaded.state.sessionId, threadId: 'thread-1',
    fileLink: 'D:\\outside\\hidden.ts:1'
  });
  await flushPromises();

  assert.deepEqual(opened, [
    'D:\\workspace\\src\\example.ts',
    'D:\\workspace\\src\\example.ts'
  ]);
  assert.deepEqual(selections, [undefined, { line: 11, character: 3 }]);
});

test('keeps only one editor tab and reuses its session after closing and reopening', async (t) => {
  const panels: FakeWebviewPanel[] = [];
  installPanelFactory(panels);
  const reads: string[] = [];
  const { manager, coordinator } = createManager(t, {
    extensionUri: vscode.Uri.file('/extension'),
    readThread: async (id) => { reads.push(id); return createThread({ id }); },
    logger: { appendLine: () => undefined }
  });
  t.after(() => manager.dispose());
  manager.openThread({ id: 'thread-1', title: 'First' });
  panels[0]!.webview.fire({ type: 'threads/ready' });
  await flushPromises();
  coordinator.handleNotification({
    method: 'turn/started', params: { threadId: 'thread-1', turn: createTurn({ id: 'live', status: 'inProgress' }) }
  });
  manager.openThread({ id: 'thread-2', title: 'Second' });
  assert.equal(panels[0]!.disposed, true);
  panels[1]!.webview.fire({ type: 'threads/ready' });
  await flushPromises();
  panels[1]!.dispose();
  coordinator.handleNotification({
    method: 'item/agentMessage/delta',
    params: { threadId: 'thread-1', turnId: 'live', itemId: 'reply', delta: 'Still running' }
  });
  manager.openThread({ id: 'thread-1', title: 'First' });
  panels[2]!.webview.fire({ type: 'threads/ready' });
  await flushPromises();
  assert.deepEqual(reads, ['thread-1', 'thread-2']);
  assert.match(JSON.stringify(panels[2]!.webview.postedMessages), /Still running/u);
});

test('closes the editor when its conversation is moved to the sidebar', async (t) => {
  const panels: FakeWebviewPanel[] = [];
  installPanelFactory(panels);
  const { manager, coordinator } = createManager(t, {
    extensionUri: vscode.Uri.file('/extension'), readThread: async () => createThread(),
    logger: { appendLine: () => undefined }
  });
  t.after(() => manager.dispose());
  const sidebarMessages: unknown[] = [];
  const sidebar = coordinator.attachPresentation({
    postMessage: (message) => sidebarMessages.push(message), isVisible: () => true,
    setUnreadCount: () => undefined
  });
  sidebar.handleMessage({ type: 'threads/ready' });
  manager.openThread({ id: 'thread-1', title: 'First' });
  panels[0]!.webview.fire({ type: 'threads/ready' });
  await flushPromises();
  const loaded = panels[0]!.webview.postedMessages.find((message) =>
    (message as { type?: string }).type === 'threads/conversationLoaded'
  ) as { state: { sessionId: string } };
  panels[0]!.webview.fire({
    type: 'threads/openSidebar', sessionId: loaded.state.sessionId, threadId: 'thread-1'
  });
  await flushPromises();
  assert.equal(panels[0]!.disposed, true);
  assert.equal(manager.focusPrompt(), false);
  assert.ok(sidebarMessages.some((message) =>
    (message as { type?: string }).type === 'threads/conversationLoaded'
  ));
});

test('restores only one editor tab even when saved tabs refer to different threads', async (t) => {
  let reads = 0;
  let resumes = 0;
  const { manager, coordinator } = createManager(t, {
    extensionUri: vscode.Uri.file('/extension'),
    readThread: async (id) => { reads += 1; return createThread({ id }); },
    onResume: () => { resumes += 1; },
    logger: { appendLine: () => undefined }
  });
  t.after(() => manager.dispose());
  coordinator.setConnectionStatus({ kind: 'ready' });
  const first = new FakeWebviewPanel();
  const second = new FakeWebviewPanel();
  await manager.deserializeWebviewPanel(first as unknown as vscode.WebviewPanel, {
    version: 1, threadId: 'thread-1', title: 'First'
  });
  await manager.deserializeWebviewPanel(second as unknown as vscode.WebviewPanel, {
    version: 1, threadId: 'thread-2', title: 'Second'
  });
  assert.equal(first.disposed, false);
  assert.equal(second.disposed, true);
  assert.equal(reads, 0);
  first.webview.fire({ type: 'threads/ready' });
  await flushPromises();
  assert.equal(reads, 1);
  assert.equal(resumes, 1);
  assert.ok(first.webview.postedMessages.some((message) =>
    (message as { type?: string }).type === 'threads/conversationLoaded'
  ));
});

test('focuses the prompt without revealing a focused editor and waits for focus after revealing another editor', async (t) => {
  const panels: FakeWebviewPanel[] = [];
  installPanelFactory(panels);
  const { manager } = createManager(t, {
    extensionUri: vscode.Uri.file('/extension'), readThread: async () => createThread(),
    logger: { appendLine: () => undefined }
  });
  t.after(() => manager.dispose());
  manager.openThread({ id: 'thread-1', title: 'First' });
  const panel = panels[0]!;
  panel.webview.fire({ type: 'threads/ready' });
  await flushPromises();
  panel.webview.fire({ type: 'threads/viewFocus', focused: true });
  panel.webview.postedMessages.length = 0;

  assert.equal(manager.focusPrompt(), true);
  assert.equal(panel.revealCount, 0);
  assert.equal((panel.webview.postedMessages.at(-1) as { type: string }).type, 'threads/focusConversationPrompt');

  panel.setActive(false);
  panel.webview.fire({ type: 'threads/viewFocus', focused: false });
  panel.webview.postedMessages.length = 0;
  manager.focusPrompt();
  assert.equal(panel.revealCount, 1);
  assert.equal(panel.webview.postedMessages.length, 0);
  panel.setActive(true);
  assert.equal(panel.webview.postedMessages.length, 0);
  panel.webview.fire({ type: 'threads/viewFocus', focused: true });
  assert.equal(panel.webview.postedMessages.length, 1);
  assert.equal((panel.webview.postedMessages[0] as { type: string }).type, 'threads/focusConversationPrompt');
  panel.webview.fire({ type: 'threads/viewFocus', focused: true });
  assert.equal(panel.webview.postedMessages.length, 1);

  // The editor can remain active while keyboard focus moves to the sidebar.
  panel.webview.fire({ type: 'threads/viewFocus', focused: false });
  panel.webview.postedMessages.length = 0;
  manager.focusPrompt();
  assert.equal(panel.revealCount, 2);
  assert.equal(panel.webview.postedMessages.length, 0);
  panel.webview.fire({ type: 'threads/viewFocus', focused: true });
  assert.equal(panel.webview.postedMessages.length, 1);
});

test('retains a prompt focus request until history loads and cancels it when another editor is selected', async (t) => {
  const panels: FakeWebviewPanel[] = [];
  installPanelFactory(panels);
  const read = deferred<Thread>();
  const { manager } = createManager(t, {
    extensionUri: vscode.Uri.file('/extension'), readThread: () => read.promise,
    logger: { appendLine: () => undefined }
  });
  t.after(() => manager.dispose());
  manager.openThread({ id: 'thread-1', title: 'First' });
  const panel = panels[0]!;
  manager.focusPrompt();
  panel.webview.fire({ type: 'threads/viewFocus', focused: true });
  panel.webview.fire({ type: 'threads/ready' });
  read.resolve(createThread());
  await flushPromises();
  const focusMessages = () => panel.webview.postedMessages.filter((message) =>
    (message as { type: string }).type === 'threads/focusConversationPrompt'
  );
  assert.equal(focusMessages().length, 1);
  panel.webview.fire({ type: 'threads/viewFocus', focused: false });
  manager.focusPrompt();
  panel.setActive(false);
  panel.setActive(true);
  panel.webview.fire({ type: 'threads/viewFocus', focused: true });
  assert.equal(focusMessages().length, 1);
});
