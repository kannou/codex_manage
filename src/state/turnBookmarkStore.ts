import type { Memento } from 'vscode';

const TURN_BOOKMARKS_KEY = 'codexThreadManager.turnBookmarks';

type StoredBookmarks = Readonly<Record<string, readonly string[]>>;

export class TurnBookmarkStore {
  public constructor(private readonly state: Memento) {}

  public getTurnIds(threadId: string): readonly string[] {
    const value = this.state.get<unknown>(TURN_BOOKMARKS_KEY, {});
    if (!isRecord(value)) return [];
    const ids = value[threadId];
    if (!Array.isArray(ids)) return [];
    return [...new Set(ids.filter((id): id is string => typeof id === 'string' && Boolean(id.trim())))];
  }

  public async toggle(threadId: string, turnId: string): Promise<void> {
    const stored = this.read();
    const current = this.getTurnIds(threadId);
    const next = current.includes(turnId)
      ? current.filter((id) => id !== turnId)
      : [...current, turnId];
    if (next.length) stored[threadId] = next;
    else delete stored[threadId];
    await this.state.update(TURN_BOOKMARKS_KEY, stored);
  }

  private read(): Record<string, readonly string[]> {
    const value = this.state.get<unknown>(TURN_BOOKMARKS_KEY, {});
    if (!isRecord(value)) return {};
    return { ...(value as StoredBookmarks) };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
