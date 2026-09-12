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

test('limits reload and location toggle bindings to the focused conversation', async () => {
  const manifest = JSON.parse(await readFile('package.json', 'utf8'));
  for (const [name, key] of [['reloadConversation', 'r'], ['toggleConversationLocation', 'm']]) {
    const command = `codexThreadManager.${name}`;
    assert.deepEqual(manifest.contributes.keybindings.find((entry) => entry.command === command), {
      command, key: `ctrl+alt+${key}`, mac: `cmd+alt+${key}`,
      when: 'codexThreadManager.conversationFocused'
    });
    assert.equal(manifest.contributes.commands.find((entry) => entry.command === command)?.enablement,
      'codexThreadManager.conversationFocused');
  }
});

test('contributes configurable conversation scrolling on Ctrl+PageUp/PageDown', async () => {
  const manifest = JSON.parse(await readFile('package.json', 'utf8'));
  for (const [direction, key] of [['Up', 'pageup'], ['Down', 'pagedown']]) {
    assert.deepEqual(manifest.contributes.keybindings.find((entry) => entry.command === `codexThreadManager.scrollConversation${direction}`), {
      command: `codexThreadManager.scrollConversation${direction}`, key: `ctrl+${key}`, mac: `ctrl+${key}`,
      when: 'codexThreadManager.conversationFocused'
    });
  }
  const setting = manifest.contributes.configuration.properties['codexThreadManager.conversationScrollAmount'];
  assert.equal(setting.type, 'integer');
  assert.equal(setting.default, 400);
  assert.equal(setting.minimum, 1);
  assert.equal(setting.maximum, 10000);
});
