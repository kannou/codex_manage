import assert from 'node:assert/strict';
import test from 'node:test';
import type { ConversationViewModel } from '../../src/conversation/conversationViewModel';
import {
  createConversationLatestState,
  markConversationLatestSeen,
  updateConversationLatest
} from '../../src/webview/threads/conversationLatest';

function model(text: string, status = 'In progress'): ConversationViewModel {
  return {
    threadId: 'thread-1',
    title: 'Thread 1',
    cwd: '/workspace',
    status: 'Running',
    updatedAt: 1,
    isPartialHistory: false,
    turns: [{
      id: 'turn-1',
      status,
      itemsView: 'full',
      startedAt: 1,
      completedAt: null,
      durationMs: null,
      errorMessage: null,
      workDetails: null,
      changedFiles: [],
      items: [{ kind: 'message', id: 'agent-1', role: 'assistant', text }],
      liveItemIds: ['agent-1']
    }]
  };
}

test('follows initial and near-bottom activity without showing Latest', () => {
  const initial = updateConversationLatest(
    createConversationLatestState(),
    model('Hello'),
    true,
    false
  );
  assert.equal(initial.followLatest, true);
  assert.equal(initial.state.hasUnseenActivity, false);

  const streaming = updateConversationLatest(initial.state, model('Hello world'), false, true);
  assert.equal(streaming.followLatest, true);
  assert.equal(streaming.state.hasUnseenActivity, false);
});

test('keeps the reading position and retains Latest until activity is seen', () => {
  const initial = updateConversationLatest(
    createConversationLatestState(),
    model('Hello'),
    true,
    true
  );
  const streaming = updateConversationLatest(initial.state, model('Hello world'), false, false);
  assert.equal(streaming.followLatest, false);
  assert.equal(streaming.state.hasUnseenActivity, true);

  const unchanged = updateConversationLatest(streaming.state, model('Hello world'), false, false);
  assert.equal(unchanged.state.hasUnseenActivity, true);

  const completed = updateConversationLatest(
    unchanged.state,
    model('Hello world', 'Completed'),
    false,
    false
  );
  assert.equal(completed.state.hasUnseenActivity, true);
  assert.equal(markConversationLatestSeen(completed.state).hasUnseenActivity, false);
});
