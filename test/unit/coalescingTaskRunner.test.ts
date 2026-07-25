import assert from 'node:assert/strict';
import test from 'node:test';
import { createCoalescingTaskRunner } from '../../src/common/coalescingTaskRunner';

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function deferred(): Deferred {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: () => resolvePromise?.() };
}

test('coalesces overlapping work into one trailing run and preserves error notification intent', async () => {
  const pending: Deferred[] = [];
  const notifications: boolean[] = [];
  const runner = createCoalescingTaskRunner(async (notifyOnError) => {
    notifications.push(notifyOnError);
    const task = deferred();
    pending.push(task);
    await task.promise;
  });

  const first = runner.run(false);
  await Promise.resolve();
  assert.deepEqual(notifications, [false]);

  const second = runner.run(false);
  const manual = runner.run(true);
  assert.equal(second, first);
  assert.equal(manual, first);
  assert.equal(pending.length, 1);

  pending[0]?.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(notifications, [false, true]);
  assert.equal(pending.length, 2);

  pending[1]?.resolve();
  await Promise.all([first, second, manual]);

  const later = runner.run(false);
  await Promise.resolve();
  assert.deepEqual(notifications, [false, true, false]);
  pending[2]?.resolve();
  await later;
});
