import assert from 'node:assert/strict';
import test from 'node:test';
import { formatTurnDuration } from '../../src/webview/conversation/duration';

test('formats sub-second and second turn durations without milliseconds', () => {
  assert.equal(formatTurnDuration(0), '<1 sec');
  assert.equal(formatTurnDuration(999), '<1 sec');
  assert.equal(formatTurnDuration(1_000), '1 sec');
  assert.equal(formatTurnDuration(59_999), '59 sec');
});

test('formats minute boundaries and long turns as whole minutes and seconds', () => {
  assert.equal(formatTurnDuration(60_000), '1 min');
  assert.equal(formatTurnDuration(61_999), '1 min 1 sec');
  assert.equal(formatTurnDuration(3_600_000), '60 min');
  assert.equal(formatTurnDuration(359_999_999), '5,999 min 59 sec');
});

test('omits absent and invalid turn durations', () => {
  assert.equal(formatTurnDuration(null), null);
  assert.equal(formatTurnDuration(-1), null);
  assert.equal(formatTurnDuration(Number.NaN), null);
  assert.equal(formatTurnDuration(Number.POSITIVE_INFINITY), null);
  assert.equal(formatTurnDuration(Number.NEGATIVE_INFINITY), null);
});
