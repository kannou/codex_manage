import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_COMPOSER_TEXT_LENGTH,
  MAX_CONVERSATION_ID_LENGTH,
  isThreadsHostMessage,
  isThreadsWebviewMessage,
  isThreadsWebviewState,
  restoreThreadsWebviewState
} from '../../src/webview/threads/protocol';

const conversationState = {
  sessionId: 'session-1',
  revision: 1,
  model: {
    threadId: 'thread-1',
    title: 'Thread 1',
    cwd: 'D:\\workspace',
    status: 'Running',
    updatedAt: 1_750_000_000_000,
    isPartialHistory: false,
    turns: [
      {
        id: 'turn-1',
        status: 'In progress',
        itemsView: 'full',
        startedAt: 1_750_000_000_000,
        completedAt: null,
        durationMs: null,
        errorMessage: null,
        workDetails: null,
        changedFiles: [],
        items: [
          { kind: 'message', id: 'message-1', role: 'assistant', text: 'Hello' }
        ]
      }
    ]
  },
  execution: { kind: 'running', turnId: 'turn-1' },
  runtime: {
    status: 'ready',
    models: [{ value: 'gpt-fixture', label: 'GPT Fixture', description: 'Fixture model' }],
    model: 'gpt-fixture',
    efforts: [{ value: 'medium', label: 'medium', description: 'Balanced' }],
    effort: 'medium',
    defaultEffort: 'medium',
    serviceTiers: [],
    serviceTier: null,
    defaultServiceTier: null,
    sandbox: 'workspace-write',
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    message: null
  },
  availableAdditions: ['localImage', 'mention', 'skill'],
  draftText: 'Continue this thread',
  attachments: [
    { id: 'attachment-1', kind: 'localImage', name: 'diagram.png', sizeBytes: 1024 },
    { id: 'attachment-2', kind: 'mention', name: 'AGENTS.md', sizeBytes: 2048 },
    { id: 'attachment-3', kind: 'skill', name: 'review', description: 'Review changes' }
  ],
  interactions: [],
  bookmarkedTurnIds: ['turn-1']
} as const;

test('accepts only the explicit sidebar navigation messages', () => {
  for (const message of [
    { type: 'threads/ready' },
    { type: 'threads/viewFocus', focused: true },
    { type: 'threads/viewFocus', focused: false },
    { type: 'threads/new' },
    { type: 'threads/open', threadId: 'thread-1' },
    { type: 'threads/back' },
    { type: 'threads/reload' }
    ,{ type: 'threads/conversation/usage/read' }
  ]) {
    assert.equal(isThreadsWebviewMessage(message), true);
  }

  assert.equal(isThreadsWebviewMessage({ type: 'threads/open', threadId: '' }), false);
  assert.equal(isThreadsWebviewMessage({ type: 'threads/viewFocus', focused: 'yes' }), false);
  assert.equal(isThreadsWebviewMessage({ type: 'threads/viewFocus', focused: true, threadId: 'thread-1' }), false);
  assert.equal(isThreadsWebviewMessage({ type: 'threads/new', method: 'thread/start' }), false);
  assert.equal(isThreadsWebviewMessage({ type: 'threads/execute', command: 'anything' }), false);
});

test('validates usage snapshots without accepting misleading percentages', () => {
  const usage = { primary: { remainingPercent: 75, resetsAt: 1_750_000_000 }, secondary: null,
    credits: { unlimited: false, balance: '12.50' }, individualLimit: null };
  assert.equal(isThreadsHostMessage({ type: 'threads/conversationUsage', status: 'ready', usage }), true);
  assert.equal(isThreadsHostMessage({ type: 'threads/conversationUsage', status: 'ready', usage: {
    ...usage, primary: { remainingPercent: -1, resetsAt: null }
  }}), false);
  assert.equal(isThreadsHostMessage({ type: 'threads/conversationUsage', status: 'unavailable' }), true);
});

test('requires thread IDs only for thread-scoped management actions', () => {
  for (const action of ['loadMoreActive', 'loadMoreArchive']) {
    assert.equal(isThreadsWebviewMessage({ type: 'threads/action', action }), true);
    assert.equal(isThreadsWebviewMessage({ type: 'threads/action', action, threadId: 'thread-1' }), false);
  }
  for (const action of ['refresh', 'openSettings']) {
    assert.equal(isThreadsWebviewMessage({ type: 'threads/action', action }), false);
  }
  for (const action of ['pin', 'unpin', 'rename', 'archive', 'unarchive']) {
    assert.equal(isThreadsWebviewMessage({ type: 'threads/action', action, threadId: 'thread-1' }), true);
    assert.equal(isThreadsWebviewMessage({ type: 'threads/action', action }), false);
  }
  assert.equal(isThreadsWebviewMessage({
    type: 'threads/action',
    action: 'workbench.action.terminal.new'
  }), false);
});

test('accepts bounded composer actions and rejects arbitrary conversation payloads', () => {
  assert.equal(isThreadsWebviewMessage({
    type: 'threads/conversation/seen',
    sessionId: 'session-1',
    threadId: 'thread-1',
    turnId: 'turn-1'
  }), true);
  assert.equal(isThreadsWebviewMessage({
    type: 'threads/conversation/seen',
    sessionId: 'session-1',
    threadId: 'thread-1',
    turnId: ''
  }), false);
  assert.equal(isThreadsWebviewMessage({
    type: 'threads/conversation/copy', sessionId: 'session-1', threadId: 'thread-1',
    turnId: 'turn-1', itemId: 'message-1', codeBlockIndex: 0
  }), true);
  assert.equal(isThreadsWebviewMessage({
    type: 'threads/conversation/openChangedFile', sessionId: 'session-1', threadId: 'thread-1',
    turnId: 'turn-1', fileId: 'changed-file-1'
  }), true);
  assert.equal(isThreadsWebviewMessage({
    type: 'threads/conversation/openChangedFile', sessionId: 'session-1', threadId: 'thread-1',
    turnId: 'turn-1', fileId: 'changed-file-1', path: 'D:\\private\\file.ts'
  }), false);
  assert.equal(isThreadsWebviewMessage({
    type: 'threads/conversation/copy', sessionId: 'session-1', threadId: 'thread-1',
    turnId: 'turn-1', itemId: 'message-1', codeBlockIndex: -1, command: 'clipboard.write'
  }), false);
  assert.equal(isThreadsWebviewMessage({
    type: 'threads/conversation/rename',
    sessionId: 'session-1',
    threadId: 'thread-1',
    name: 'Renamed thread'
  }), true);
  assert.equal(isThreadsWebviewMessage({
    type: 'threads/conversation/rename',
    sessionId: 'session-1',
    threadId: 'thread-1',
    name: '   '
  }), false);
  assert.equal(isThreadsWebviewMessage({
    type: 'threads/conversation/send',
    sessionId: 'session-1',
    threadId: 'thread-1',
    requestId: 'request-1',
    text: 'Continue this thread'
  }), true);
  assert.equal(isThreadsWebviewMessage({
    type: 'threads/conversation/draft/update',
    sessionId: 'session-1',
    threadId: 'thread-1',
    text: ''
  }), true);
  assert.equal(isThreadsWebviewMessage({
    type: 'threads/conversation/draft/update',
    sessionId: 'session-1',
    threadId: 'thread-1',
    text: 'x'.repeat(MAX_COMPOSER_TEXT_LENGTH + 1)
  }), false);
  assert.equal(isThreadsWebviewMessage({
    type: 'threads/conversation/draft/update',
    sessionId: 'session-1',
    threadId: 'thread-1',
    text: 'Keep this private',
    path: '/private/draft.txt'
  }), false);
  assert.equal(isThreadsWebviewMessage({
    type: 'threads/conversation/attachment/addImage',
    sessionId: 'session-1',
    threadId: 'thread-1'
  }), true);
  assert.equal(isThreadsWebviewMessage({
    type: 'threads/conversation/attachment/addMention',
    sessionId: 'session-1',
    threadId: 'thread-1'
  }), true);
  assert.equal(isThreadsWebviewMessage({
    type: 'threads/conversation/attachment/addSkill',
    sessionId: 'session-1',
    threadId: 'thread-1'
  }), true);
  assert.equal(isThreadsWebviewMessage({
    type: 'threads/conversation/attachment/remove',
    sessionId: 'session-1',
    threadId: 'thread-1',
    attachmentId: 'attachment-1'
  }), true);
  assert.equal(isThreadsWebviewMessage({
    type: 'threads/conversation/attachment/addImage',
    sessionId: 'session-1',
    threadId: 'thread-1',
    path: '/private/image.png'
  }), false);
  assert.equal(isThreadsWebviewMessage({
    type: 'threads/conversation/settings',
    sessionId: 'session-1',
    threadId: 'thread-1',
    settings: {
      model: 'gpt-fixture',
      effort: null,
      serviceTier: null,
      sandbox: 'workspace-write',
      approvalPolicy: 'custom',
      approvalsReviewer: 'custom'
    }
  }), true);
  assert.equal(isThreadsWebviewMessage({
    type: 'threads/conversation/interaction',
    sessionId: 'session-1',
    threadId: 'thread-1',
    interactionId: 'interaction-1',
    reply: { kind: 'approval', decision: 'decline' }
  }), true);
  assert.equal(isThreadsWebviewMessage({
    type: 'threads/conversation/interaction',
    sessionId: 'session-1',
    threadId: 'thread-1',
    interactionId: 'interaction-1',
    reply: { kind: 'approval', decision: 'alwaysAllowEverything' }
  }), false);
  assert.equal(isThreadsWebviewMessage({
    type: 'threads/conversation/settings',
    sessionId: 'session-1',
    threadId: 'thread-1',
    settings: {
      model: 'gpt-fixture',
      effort: 'high',
      serviceTier: 'fast',
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review'
    }
  }), true);
  assert.equal(isThreadsWebviewMessage({
    type: 'threads/conversation/stop',
    sessionId: 'session-1',
    threadId: 'thread-1',
    requestId: 'request-2'
  }), true);
  assert.equal(isThreadsWebviewMessage({
    type: 'threads/conversation/bookmark/toggle',
    sessionId: 'session-1',
    threadId: 'thread-1',
    turnId: 'turn-1'
  }), true);
  assert.equal(isThreadsWebviewMessage({
    type: 'threads/conversation/bookmark/toggle',
    sessionId: 'session-1',
    threadId: 'thread-1',
    turnId: 'turn-1',
    bookmarked: true
  }), false);

  for (const text of ['', ' \n\t', 'x'.repeat(MAX_COMPOSER_TEXT_LENGTH + 1)]) {
    assert.equal(isThreadsWebviewMessage({
      type: 'threads/conversation/send',
      sessionId: 'session-1',
      threadId: 'thread-1',
      requestId: 'request-1',
      text
    }), false);
  }
  assert.equal(isThreadsWebviewMessage({
    type: 'threads/conversation/send',
    sessionId: 'x'.repeat(MAX_CONVERSATION_ID_LENGTH + 1),
    threadId: 'thread-1',
    requestId: 'request-1',
    text: 'Hello'
  }), false);
  assert.equal(isThreadsWebviewMessage({
    type: 'threads/conversation/settings',
    sessionId: 'session-1',
    threadId: 'thread-1',
    settings: {
      model: 'gpt-fixture',
      effort: null,
      serviceTier: null,
      sandbox: 'danger-everywhere',
      approvalPolicy: 'never',
      approvalsReviewer: 'user'
    }
  }), false);
  assert.equal(isThreadsWebviewMessage({
    type: 'threads/conversation/stop',
    sessionId: 'session-1',
    threadId: 'thread-1',
    requestId: 'request-2',
    turnId: 'turn-from-webview'
  }), false);
  assert.equal(isThreadsWebviewMessage({
    type: 'threads/conversation/send',
    sessionId: 'session-1',
    threadId: 'thread-1',
    requestId: 'request-1',
    text: 'Hello',
    method: 'turn/start'
  }), false);
});

test('validates persisted navigation state and host messages', () => {
  assert.equal(isThreadsWebviewState({
    version: 2,
    screen: 'conversation',
    selectedThreadId: 'thread-1',
    listScrollTop: 120,
    expandedGroups: { pinned: false, active: true, archive: true }
  }), true);
  assert.equal(isThreadsWebviewState({
    version: 2,
    screen: 'conversation',
    selectedThreadId: null,
    listScrollTop: 0,
    expandedGroups: { pinned: true, active: true, archive: false }
  }), false);
  assert.equal(isThreadsWebviewState({
    version: 2,
    screen: 'list',
    selectedThreadId: null,
    listScrollTop: 0
  }), false);

  assert.equal(isThreadsHostMessage({ type: 'threads/showList' }), true);
  assert.equal(isThreadsHostMessage({
    type: 'threads/reduceMotion',
    preference: 'off'
  }), true);
  assert.equal(isThreadsHostMessage({
    type: 'threads/reduceMotion',
    preference: 'system'
  }), false);
  assert.equal(isThreadsHostMessage({
    type: 'threads/focusConversationPrompt',
    sessionId: 'session-1',
    threadId: 'thread-1'
  }), true);
  assert.equal(isThreadsHostMessage({
    type: 'threads/focusConversationPrompt',
    sessionId: 'session-1',
    threadId: 'thread-1',
    command: 'workbench.action.terminal.new'
  }), false);
  assert.equal(isThreadsHostMessage({
    type: 'threads/conversationLoading',
    sessionId: 'session-1',
    threadId: 'thread-1',
    title: 'Thread 1'
  }), true);
  assert.equal(isThreadsHostMessage({
    type: 'threads/newConversationLoaded',
    state: conversationState
  }), true);
  assert.equal(isThreadsHostMessage({
    type: 'threads/conversationCreated',
    previousThreadId: 'draft-1',
    state: { ...conversationState, model: { ...conversationState.model, threadId: 'thread-created' } }
  }), true);
  assert.equal(isThreadsHostMessage({
    type: 'threads/conversationLoaded',
    state: conversationState
  }), true);
  assert.equal(isThreadsHostMessage({
    type: 'threads/conversationState',
    state: {
      ...conversationState,
      revision: 2,
      execution: { kind: 'idle' }
    }
  }), true);
  assert.equal(isThreadsHostMessage({
    type: 'threads/conversationState',
    state: {
      ...conversationState,
      model: {
        ...conversationState.model,
        turns: [{
          ...conversationState.model.turns[0],
          status: 'Completed',
          changedFiles: [{
            id: 'changed-file-1',
            path: 'D:\\private\\example.ts',
            change: 'Updated',
            canOpen: true
          }]
        }]
      },
      execution: { kind: 'idle' }
    }
  }), false);
  assert.equal(isThreadsHostMessage({
    type: 'threads/conversationState',
    state: {
      ...conversationState,
      model: {
        ...conversationState.model,
        turns: [{
          ...conversationState.model.turns[0],
          status: 'Completed',
          workDetails: { count: 1, status: 'Failed' },
          changedFiles: [{
            id: 'changed-file-1',
            path: 'src/example.ts',
            change: 'Updated',
            canOpen: true
          }],
          items: [{
            kind: 'activity',
            id: 'command-1',
            activityKind: 'command',
            title: 'npm test',
            status: 'Failed',
            detail: null,
            detailPresentation: 'collapsible'
          }]
        }]
      },
      execution: { kind: 'idle' }
    }
  }), true);
  assert.equal(isThreadsHostMessage({
    type: 'threads/conversationError',
    sessionId: 'session-1',
    threadId: 'thread-1',
    title: 'Thread 1',
    message: 500
  }), false);
  assert.equal(isThreadsHostMessage({
    type: 'threads/conversationState',
    state: { ...conversationState, bookmarkedTurnIds: ['turn-missing'] }
  }), false);
  assert.equal(isThreadsHostMessage({
    type: 'threads/conversationState',
    state: { ...conversationState, bookmarkedTurnIds: ['turn-1', 'turn-1'] }
  }), false);
  assert.equal(isThreadsHostMessage({
    type: 'threads/conversationState',
    state: { ...conversationState, revision: -1 }
  }), false);
  const { draftText: _draftText, ...withoutDraftText } = conversationState;
  assert.equal(isThreadsHostMessage({
    type: 'threads/conversationState',
    state: withoutDraftText
  }), false);
  assert.equal(isThreadsHostMessage({
    type: 'threads/conversationState',
    state: { ...conversationState, draftText: 'x'.repeat(MAX_COMPOSER_TEXT_LENGTH + 1) }
  }), false);
  assert.equal(isThreadsHostMessage({
    type: 'threads/conversationState',
    state: {
      ...conversationState,
      model: {
        ...conversationState.model,
        turns: [{ ...conversationState.model.turns[0], workDetails: { count: 0, status: null } }]
      }
    }
  }), false);
  assert.equal(isThreadsHostMessage({
    type: 'threads/conversationState',
    state: {
      ...conversationState,
      attachments: [{
        id: 'attachment-unsafe',
        kind: 'skill',
        name: 'review',
        description: 'Review changes',
        path: '/private/SKILL.md'
      }]
    }
  }), false);
  assert.equal(isThreadsHostMessage({
    type: 'threads/conversationState',
    state: {
      ...conversationState,
      execution: { kind: 'running', turnId: '' }
    }
  }), false);
});

test('validates correlated conversation operation results', () => {
  assert.equal(isThreadsHostMessage({
    type: 'threads/conversationOperationResult',
    sessionId: 'session-1',
    threadId: 'thread-1',
    requestId: 'request-1',
    operation: 'send',
    outcome: 'accepted'
  }), true);
  assert.equal(isThreadsHostMessage({
    type: 'threads/conversationOperationResult',
    sessionId: 'session-1',
    threadId: 'thread-1',
    requestId: 'request-2',
    operation: 'stop',
    outcome: 'rejected',
    message: 'The turn already completed.'
  }), true);
  assert.equal(isThreadsHostMessage({
    type: 'threads/conversationOperationResult',
    sessionId: 'session-1',
    threadId: 'thread-1',
    requestId: 'request-2',
    operation: 'execute',
    outcome: 'accepted'
  }), false);
  assert.equal(isThreadsHostMessage({
    type: 'threads/conversationOperationResult',
    sessionId: 'session-1',
    threadId: 'thread-1',
    requestId: 'request-2',
    operation: 'stop',
    outcome: 'rejected'
  }), false);
});

test('restores group visibility and migrates version 1 navigation state', () => {
  assert.deepEqual(restoreThreadsWebviewState({
    version: 2,
    screen: 'list',
    selectedThreadId: 'thread-1',
    listScrollTop: 80,
    expandedGroups: { pinned: false, active: true, archive: true },
    draftText: 'must not persist',
    attachments: [{ path: '/private/file.txt' }]
  }), {
    version: 2,
    screen: 'list',
    selectedThreadId: 'thread-1',
    listScrollTop: 80,
    expandedGroups: { pinned: false, active: true, archive: true }
  });

  assert.deepEqual(restoreThreadsWebviewState({
    version: 1,
    screen: 'conversation',
    selectedThreadId: 'thread-2',
    listScrollTop: 120
  }), {
    version: 2,
    screen: 'conversation',
    selectedThreadId: 'thread-2',
    listScrollTop: 120,
    expandedGroups: { pinned: true, active: true, archive: false }
  });

  assert.deepEqual(restoreThreadsWebviewState({
    version: 2,
    screen: 'list',
    selectedThreadId: null,
    listScrollTop: 0,
    expandedGroups: { pinned: 'yes', active: true, archive: false }
  }), {
    version: 2,
    screen: 'list',
    selectedThreadId: null,
    listScrollTop: 0,
    expandedGroups: { pinned: true, active: true, archive: false }
  });
});
