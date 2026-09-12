import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isConversationWebviewState
} from '../../src/webview/conversation/state';

test('accepts only versioned conversation panel state', () => {
  assert.equal(isConversationWebviewState({
    version: 1,
    threadId: 'thread-1',
    title: 'Thread 1'
  }), true);
  assert.equal(isConversationWebviewState({
    version: 2,
    threadId: 'thread-1',
    title: 'Thread 1'
  }), false);
  assert.equal(isConversationWebviewState({
    version: 1,
    threadId: '',
    title: 'Thread 1'
  }), false);
});
