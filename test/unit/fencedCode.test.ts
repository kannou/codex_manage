import assert from 'node:assert/strict';
import test from 'node:test';
import { extractFencedCodeBlocks } from '../../src/conversation/fencedCode';

test('extracts fenced code exactly in display order', () => {
  assert.deepEqual(extractFencedCodeBlocks(
    'Before\r\n```ts\r\nconst greeting = "こんにちは";\r\n  return greeting;\r\n```\r\n```\r\nsecond\r\n```'
  ), [
    'const greeting = "こんにちは";\n  return greeting;',
    'second'
  ]);
});

test('keeps an unterminated fenced block copyable', () => {
  assert.deepEqual(extractFencedCodeBlocks('```sh\nprintf "ok"'), ['printf "ok"']);
});
