import assert from 'node:assert/strict';
import test from 'node:test';
import { conversationActivityPresentation } from '../../src/webview/threads/conversationActivity';

test('shows a generic activity indicator only while Codex is normally responding', () => {
  assert.deepEqual(
    conversationActivityPresentation(
      { kind: 'running', turnId: 'turn-1' },
      false,
      false,
      false
    ),
    {
      activityVisible: true,
      statusText: 'Codex is responding'
    }
  );
  assert.deepEqual(
    conversationActivityPresentation({ kind: 'idle' }, false, false, false),
    {
      activityVisible: false,
      statusText: ''
    }
  );
});

test('keeps visible text for transitions and states that need attention', () => {
  assert.deepEqual(
    conversationActivityPresentation(
      { kind: 'running', turnId: 'turn-1' },
      true,
      false,
      false
    ),
    {
      activityVisible: false,
      statusText: 'Respond to the request above to continue.'
    }
  );
  assert.deepEqual(
    conversationActivityPresentation(
      { kind: 'running', turnId: 'turn-1' },
      false,
      false,
      true
    ),
    {
      activityVisible: false,
      statusText: 'Stopping the active turn…'
    }
  );
  assert.deepEqual(
    conversationActivityPresentation({ kind: 'unavailable', message: 'Disconnected' }, false, false, false),
    {
      activityVisible: false,
      statusText: 'Disconnected'
    }
  );
  assert.deepEqual(
    conversationActivityPresentation({ kind: 'starting' }, false, false, false),
    {
      activityVisible: false,
      statusText: 'Starting a new turn…'
    }
  );
});
