import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyComposerSuggestion,
  findComposerSuggestionTrigger,
  suggestionScrollDelta
} from '../../src/webview/threads/suggestions';

test('finds file and Skill triggers at the start or a word boundary', () => {
  assert.deepEqual(findComposerSuggestionTrigger('@src', 4), {
    kind: 'file',
    marker: '@',
    query: 'src',
    start: 0,
    end: 4
  });
  assert.deepEqual(findComposerSuggestionTrigger('確認して $レビュー', 10), {
    kind: 'skill',
    marker: '$',
    query: 'レビュー',
    start: 5,
    end: 10
  });
  assert.deepEqual(findComposerSuggestionTrigger('Use (@main', 10), {
    kind: 'file',
    marker: '@',
    query: 'main',
    start: 5,
    end: 10
  });
});

test('re-evaluates the trigger at the caret without matching email-like text or selections', () => {
  assert.equal(findComposerSuggestionTrigger('mail@example.com', 16), undefined);
  assert.equal(findComposerSuggestionTrigger('Use @src now', 12), undefined);
  assert.equal(findComposerSuggestionTrigger('Use @src', 4), undefined);
  assert.equal(findComposerSuggestionTrigger('Use @src', 4, 8), undefined);
  assert.equal(findComposerSuggestionTrigger('Use @src$test', 13), undefined);
});

test('removes only the selected trigger and preserves surrounding plain text', () => {
  const trigger = findComposerSuggestionTrigger('Check @src please', 10);
  assert.ok(trigger);
  assert.deepEqual(applyComposerSuggestion('Check @src please', trigger), {
    text: 'Check  please',
    caret: 6
  });
  const parenthesized = findComposerSuggestionTrigger('Use (@main) now', 10);
  assert.ok(parenthesized);
  assert.deepEqual(applyComposerSuggestion('Use (@main) now', parenthesized), {
    text: 'Use () now',
    caret: 5
  });
  assert.equal(
    applyComposerSuggestion('Check @source please', trigger),
    undefined
  );
});

test('scrolls only when the selected suggestion leaves the visible candidate area', () => {
  assert.equal(suggestionScrollDelta(100, 300, 120, 160), 0);
  assert.equal(suggestionScrollDelta(100, 300, 70, 110), -30);
  assert.equal(suggestionScrollDelta(100, 300, 280, 340), 40);
});
