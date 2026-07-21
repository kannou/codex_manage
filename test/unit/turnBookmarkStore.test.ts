import assert from 'node:assert/strict';
import test from 'node:test';
import type { Memento } from 'vscode';
import { TurnBookmarkStore } from '../../src/state/turnBookmarkStore';

class MemoryMemento {
  private readonly values = new Map<string, unknown>();
  public get<T>(key: string, fallback?: T): T | undefined {
    return (this.values.has(key) ? this.values.get(key) : fallback) as T | undefined;
  }
  public async update(key: string, value: unknown): Promise<void> { this.values.set(key, value); }
  public keys(): readonly string[] { return [...this.values.keys()]; }
  public set(key: string, value: unknown): void { this.values.set(key, value); }
}

test('persists turn bookmarks independently by thread and toggles them off', async () => {
  const state = new MemoryMemento();
  const store = new TurnBookmarkStore(state as Memento);
  await store.toggle('thread-a', 'turn-1');
  await store.toggle('thread-a', 'turn-2');
  await store.toggle('thread-b', 'turn-1');
  assert.deepEqual(store.getTurnIds('thread-a'), ['turn-1', 'turn-2']);
  assert.deepEqual(store.getTurnIds('thread-b'), ['turn-1']);
  await store.toggle('thread-a', 'turn-1');
  assert.deepEqual(new TurnBookmarkStore(state as Memento).getTurnIds('thread-a'), ['turn-2']);
});

test('sanitizes malformed and duplicate stored turn IDs', () => {
  const state = new MemoryMemento();
  state.set('codexThreadManager.turnBookmarks', { thread: ['turn-1', '', 4, 'turn-1'] });
  assert.deepEqual(new TurnBookmarkStore(state as Memento).getTurnIds('thread'), ['turn-1']);
});
