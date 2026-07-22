import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('contributes the conversation prompt focus command and platform keybindings', async () => {
  const manifest = JSON.parse(await readFile('package.json', 'utf8'));
  assert.equal(
    manifest.contributes.commands.some((entry) => (
      entry.command === 'codexThreadManager.focusConversationPrompt' &&
      entry.title === 'Focus Conversation Prompt' &&
      entry.category === 'Codex Thread Manager'
    )),
    true
  );
  assert.deepEqual(
    manifest.contributes.keybindings.find((entry) => (
      entry.command === 'codexThreadManager.focusConversationPrompt'
    )),
    {
      command: 'codexThreadManager.focusConversationPrompt',
      key: 'ctrl+alt+enter',
      mac: 'cmd+alt+enter',
      when: 'codexThreadManager.conversationOpen'
    }
  );
});
