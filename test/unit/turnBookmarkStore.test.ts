import assert from 'node:assert/strict';
import test from 'node:test';
import type { Memento } from 'vscode';
import { TurnBookmarkStore } from '../../src/state/turnBookmarkStore';

class MemoryMemento {
  private readonly values = new Map<string, unknown>();
  public readonly updates: unknown[] = [];

  public get<T>(key: string, defaultValue?: T): T | undefined {
    return (this.values.has(key) ? this.values.get(key) : defaultValue) as T | undefined;
  }

  public async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
    this.updates.push(value);
  }

  public keys(): readonly string[] {
    return [...this.values.keys()];
  }

  public set(key: string, value: unknown): void {
    this.values.set(key, value);
  }
}

test('stores bookmarks independently by thread and restores them', async () => {
  const state = new MemoryMemento();
  const store = new TurnBookmarkStore(state as Memento);
  await store.setBookmarked('thread-a', 'turn-1', true);
  await store.setBookmarked('thread-b', 'turn-1', true);
  await store.setBookmarked('thread-a', 'turn-2', true);

  assert.deepEqual(store.getBookmarkedTurnIds('thread-a'), ['turn-2', 'turn-1']);
  assert.deepEqual(store.getBookmarkedTurnIds('thread-b'), ['turn-1']);
  assert.deepEqual(
    new TurnBookmarkStore(state as Memento).getBookmarkedTurnIds('thread-a'),
    ['turn-2', 'turn-1']
  );
});

test('sanitizes corrupt state and removes one bookmark', async () => {
  const state = new MemoryMemento();
  state.set('codexThreadManager.turnBookmarks', [
    { threadId: 'thread-a', turnId: 'turn-1' },
    { threadId: 'thread-a', turnId: 'turn-1' },
    { threadId: '', turnId: 'turn-2' },
    { threadId: 'thread-a', turnId: 42 }
  ]);
  const store = new TurnBookmarkStore(state as Memento);

  assert.deepEqual(store.getBookmarkedTurnIds('thread-a'), ['turn-1']);
  await store.setBookmarked('thread-a', 'turn-1', false);
  assert.deepEqual(store.getBookmarkedTurnIds('thread-a'), []);
});

test('does not write for missing removals or invalid IDs', async () => {
  const state = new MemoryMemento();
  const store = new TurnBookmarkStore(state as Memento);
  await store.setBookmarked('thread-a', 'turn-missing', false);
  await store.setBookmarked('', 'turn-1', true);
  await store.setBookmarked('thread-a', 'x'.repeat(513), true);
  assert.equal(state.updates.length, 0);
});
