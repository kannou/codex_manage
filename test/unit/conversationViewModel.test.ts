import assert from 'node:assert/strict';
import test from 'node:test';
import type { ThreadItem } from '../../src/codex/protocol/generated/v2/ThreadItem';
import { toConversationViewModel } from '../../src/conversation/conversationViewModel';
import { createThread, createTurn } from '../support/threadFixture';

const hiddenValues = {
  reasoning: 'private reasoning content',
  output: 'secret command output',
  diff: 'secret patch diff',
  prompt: 'secret delegated prompt',
  hook: 'secret hook fragment'
};

const fileReferencePath = 'D:\\作業\\AGENTS.md';
const fileReferencePrefix = 'Referenced file: ';
const fileReferenceText = `${fileReferencePrefix}${fileReferencePath}`;

const items: ThreadItem[] = [
  {
    type: 'userMessage',
    id: 'user-1',
    clientId: null,
    content: [
      { type: 'text', text: '<script>alert(1)</script>', text_elements: [] },
      {
        type: 'text',
        text: fileReferenceText,
        text_elements: [{
          byteRange: {
            start: Buffer.byteLength(fileReferencePrefix, 'utf8'),
            end: Buffer.byteLength(fileReferenceText, 'utf8')
          },
          placeholder: '@AGENTS.md'
        }]
      },
      { type: 'localImage', path: 'D:\\image.png' },
      { type: 'skill', name: 'review', path: 'D:\\skill' },
      { type: 'mention', name: 'figma', path: 'app://figma' }
    ]
  },
  {
    type: 'agentMessage',
    id: 'agent-1',
    text: 'Done safely.',
    phase: 'final_answer',
    memoryCitation: null
  },
  {
    type: 'reasoning',
    id: 'reasoning-1',
    summary: ['Checked the implementation.'],
    content: [hiddenValues.reasoning]
  },
  {
    type: 'commandExecution',
    id: 'command-1',
    command: 'npm test',
    cwd: 'D:\\workspace',
    processId: null,
    source: 'agent',
    status: 'completed',
    commandActions: [],
    aggregatedOutput: hiddenValues.output,
    exitCode: 0,
    durationMs: 125
  },
  {
    type: 'fileChange',
    id: 'file-1',
    changes: [{
      path: 'src/example.ts',
      kind: { type: 'update', move_path: null },
      diff: hiddenValues.diff
    }],
    status: 'completed'
  },
  {
    type: 'collabAgentToolCall',
    id: 'collab-1',
    tool: 'spawnAgent',
    status: 'completed',
    senderThreadId: 'thread-1',
    receiverThreadIds: ['thread-child'],
    prompt: hiddenValues.prompt,
    model: null,
    reasoningEffort: null,
    agentsStates: {}
  },
  {
    type: 'hookPrompt',
    id: 'hook-1',
    fragments: [{ text: hiddenValues.hook, hookRunId: 'hook-run-1' }]
  }
];

test('maps stored history in order while excluding sensitive work payloads', () => {
  const model = toConversationViewModel(createThread({
    name: 'Conversation fixture',
    status: { type: 'active', activeFlags: [] },
    turns: [createTurn({
      items,
      itemsView: 'summary',
      status: 'failed',
      error: {
        message: 'Fixture failure',
        codexErrorInfo: 'other',
        additionalDetails: null
      }
    })]
  }));

  assert.equal(model.title, 'Conversation fixture');
  assert.equal(model.status, 'Running');
  assert.equal(model.updatedAt, 1_752_633_660_000);
  assert.equal(model.isPartialHistory, true);
  assert.deepEqual(model.turns[0]?.items.map((item) => item.id), items.map((item) => item.id));
  assert.equal(model.turns[0]?.startedAt, 1_752_633_600_000);
  assert.equal(model.turns[0]?.durationMs, 2_000);
  assert.equal(model.turns[0]?.errorMessage, 'Fixture failure');
  assert.deepEqual(model.turns[0]?.workDetails, { count: 5, status: 'Failed' });
  assert.deepEqual(model.turns[0]?.changedFiles, []);

  const userMessage = model.turns[0]?.items[0];
  assert.equal(userMessage?.kind, 'message');
  if (userMessage?.kind === 'message') {
    assert.match(userMessage.text, /<script>alert\(1\)<\/script>/u);
    assert.match(userMessage.text, /Referenced file: @AGENTS\.md/u);
    assert.match(userMessage.text, /\[Image attachment\]/u);
    assert.match(userMessage.text, /\[Skill: review\]/u);
    assert.match(userMessage.text, /\[Mention: figma\]/u);
  }

  const serialized = JSON.stringify(model);
  for (const hidden of Object.values(hiddenValues)) {
    assert.equal(serialized.includes(hidden), false, `Expected hidden payload not to include ${hidden}.`);
  }
  assert.equal(serialized.includes(fileReferencePath), false);
  assert.match(serialized, /Checked the implementation/u);
  assert.match(serialized, /npm test/u);
  assert.match(serialized, /src\/example\.ts/u);
});

test('falls back to a generic card for a future unknown item variant', () => {
  const futureItem = {
    type: 'futureWorkItem',
    id: 'future-1',
    internalPayload: 'do not expose'
  } as unknown as ThreadItem;
  const model = toConversationViewModel(createThread({
    turns: [createTurn({ items: [futureItem] })]
  }));

  assert.deepEqual(model.turns[0]?.items[0], {
    kind: 'activity',
    id: 'future-1',
    activityKind: 'unknown',
    title: 'Unsupported work item: futureWorkItem',
    status: null,
    detail: null,
    detailPresentation: 'collapsible'
  });
  assert.equal(JSON.stringify(model).includes('do not expose'), false);
});

test('shows reasoning directly while running and as a collapsible detail after completion', () => {
  const reasoning: ThreadItem = {
    type: 'reasoning',
    id: 'reasoning-live',
    summary: ['Inspecting the reducer.', 'Checking the renderer.'],
    content: [hiddenValues.reasoning]
  };
  const running = toConversationViewModel(createThread({
    status: { type: 'active', activeFlags: [] },
    turns: [createTurn({
      status: 'inProgress',
      completedAt: null,
      durationMs: null,
      items: [reasoning]
    })]
  }));
  const completed = toConversationViewModel(createThread({
    turns: [createTurn({ items: [reasoning] })]
  }));

  const runningItem = running.turns[0]?.items[0];
  const completedItem = completed.turns[0]?.items[0];
  assert.equal(runningItem?.kind, 'activity');
  assert.equal(completedItem?.kind, 'activity');
  if (runningItem?.kind === 'activity' && completedItem?.kind === 'activity') {
    assert.equal(runningItem.detail, 'Inspecting the reducer.\n\nChecking the renderer.');
    assert.equal(runningItem.detailPresentation, 'inline');
    assert.equal(completedItem.detailPresentation, 'collapsible');
  }
});

test('does not render an empty reasoning summary card', () => {
  const model = toConversationViewModel(createThread({
    turns: [createTurn({
      items: [{
        type: 'reasoning',
        id: 'reasoning-empty',
        summary: ['', '  '],
        content: [hiddenValues.reasoning]
      }]
    })]
  }));

  assert.deepEqual(model.turns[0]?.items, []);
  assert.equal(model.turns[0]?.workDetails, null);
});

test('keeps live work items separate and groups the same items after completion and reload', () => {
  const turnItems = [items[0]!, items[3]!, items[4]!, items[1]!];
  const running = toConversationViewModel(createThread({
    status: { type: 'active', activeFlags: [] },
    turns: [createTurn({
      status: 'inProgress',
      completedAt: null,
      durationMs: null,
      items: turnItems
    })]
  }));
  const completedThread = createThread({
    turns: [createTurn({ items: turnItems })]
  });
  const completed = toConversationViewModel(completedThread);
  const reloaded = toConversationViewModel(completedThread);

  assert.equal(running.turns[0]?.workDetails, null);
  assert.deepEqual(completed.turns[0]?.workDetails, { count: 2, status: null });
  assert.deepEqual(reloaded.turns[0]?.workDetails, completed.turns[0]?.workDetails);
  assert.deepEqual(
    completed.turns[0]?.items.map((item) => item.id),
    turnItems.map((item) => item.id)
  );
});

test('reports interrupted and declined work in the collapsed heading', () => {
  const interrupted = toConversationViewModel(createThread({
    turns: [createTurn({
      status: 'interrupted',
      items: [items[3]!]
    })]
  }));
  const declinedCommand: ThreadItem = {
    ...items[3] as Extract<ThreadItem, { type: 'commandExecution' }>,
    id: 'command-declined',
    status: 'declined'
  };
  const declined = toConversationViewModel(createThread({
    turns: [createTurn({ items: [declinedCommand] })]
  }));
  const messagesOnly = toConversationViewModel(createThread({
    turns: [createTurn({ items: [items[0]!, items[1]!] })]
  }));

  assert.deepEqual(interrupted.turns[0]?.workDetails, { count: 1, status: 'Interrupted' });
  assert.deepEqual(declined.turns[0]?.workDetails, { count: 1, status: 'Declined' });
  assert.equal(messagesOnly.turns[0]?.workDetails, null);
});

test('lists completed workspace file changes once with safe relative paths', () => {
  const fileChanges: ThreadItem[] = [
    {
      type: 'fileChange',
      id: 'files-first',
      changes: [
        { path: 'src/new.ts', kind: { type: 'add' }, diff: '' },
        { path: 'src/shared.ts', kind: { type: 'add' }, diff: '' },
        { path: 'src/old.ts', kind: { type: 'delete' }, diff: '' },
        {
          path: 'src/before.ts',
          kind: { type: 'update', move_path: 'src/after.ts' },
          diff: ''
        },
        { path: '..\\escape.ts', kind: { type: 'update', move_path: null }, diff: '' },
        { path: 'D:\\outside\\hidden.ts', kind: { type: 'update', move_path: null }, diff: '' }
      ],
      status: 'completed'
    },
    {
      type: 'fileChange',
      id: 'files-second',
      changes: [
        { path: 'src/shared.ts', kind: { type: 'update', move_path: null }, diff: '' },
        { path: 'D:\\other\\nested.ts', kind: { type: 'update', move_path: null }, diff: '' }
      ],
      status: 'completed'
    }
  ];
  const thread = createThread({
    cwd: 'D:\\workspace',
    turns: [createTurn({ items: [...fileChanges, items[1]!] })]
  });
  const folders = [
    { path: 'D:\\workspace', name: 'workspace' },
    { path: 'D:\\other', name: 'other' }
  ];
  const model = toConversationViewModel(thread, folders);
  const reloaded = toConversationViewModel(thread, folders);

  assert.deepEqual(
    model.turns[0]?.changedFiles.map(({ path, change, canOpen }) => ({ path, change, canOpen })),
    [
      { path: 'workspace/src/new.ts', change: 'Added', canOpen: true },
      { path: 'workspace/src/shared.ts', change: 'Updated', canOpen: true },
      { path: 'workspace/src/old.ts', change: 'Deleted', canOpen: false },
      { path: 'workspace/src/after.ts', change: 'Moved', canOpen: true },
      { path: 'other/nested.ts', change: 'Updated', canOpen: true }
    ]
  );
  assert.deepEqual(reloaded.turns[0]?.changedFiles, model.turns[0]?.changedFiles);
  assert.equal(model.cwd, 'D:\\workspace');
  assert.equal(JSON.stringify(model.turns[0]?.changedFiles).includes('D:\\'), false);
});

test('does not list provisional or running file changes', () => {
  const fileChange = items[4]!;
  const running = toConversationViewModel(createThread({
    turns: [createTurn({
      status: 'inProgress',
      completedAt: null,
      durationMs: null,
      items: [fileChange]
    })]
  }), [{ path: 'D:\\workspace' }]);
  const partial = toConversationViewModel(createThread({
    turns: [createTurn({ itemsView: 'summary', items: [fileChange] })]
  }), [{ path: 'D:\\workspace' }]);

  assert.deepEqual(running.turns[0]?.changedFiles, []);
  assert.deepEqual(partial.turns[0]?.changedFiles, []);
});
