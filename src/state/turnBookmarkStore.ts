import type { Memento } from 'vscode';

const TURN_BOOKMARKS_KEY = 'codexThreadManager.turnBookmarks';
const MAX_ID_LENGTH = 512;

interface TurnBookmark {
  readonly threadId: string;
  readonly turnId: string;
}

export interface TurnBookmarkStorage {
  getBookmarkedTurnIds(threadId: string): readonly string[];
  setBookmarked(threadId: string, turnId: string, bookmarked: boolean): Promise<void>;
}

export class TurnBookmarkStore implements TurnBookmarkStorage {
  public constructor(private readonly state: Memento) {}

  public getBookmarkedTurnIds(threadId: string): readonly string[] {
    return this.read()
      .filter((bookmark) => bookmark.threadId === threadId)
      .map((bookmark) => bookmark.turnId);
  }

  public async setBookmarked(
    threadId: string,
    turnId: string,
    bookmarked: boolean
  ): Promise<void> {
    if (!isValidId(threadId) || !isValidId(turnId)) return;
    const current = this.read();
    const remaining = current.filter(
      (bookmark) => bookmark.threadId !== threadId || bookmark.turnId !== turnId
    );
    if (!bookmarked && remaining.length === current.length) return;
    await this.state.update(
      TURN_BOOKMARKS_KEY,
      bookmarked ? [{ threadId, turnId }, ...remaining] : remaining
    );
  }

  private read(): TurnBookmark[] {
    const value = this.state.get<unknown>(TURN_BOOKMARKS_KEY, []);
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    const result: TurnBookmark[] = [];
    for (const item of value) {
      if (!isObject(item) || !isValidId(item.threadId) || !isValidId(item.turnId)) continue;
      const key = `${item.threadId}\0${item.turnId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ threadId: item.threadId, turnId: item.turnId });
    }
    return result;
  }
}

function isValidId(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && value.length <= MAX_ID_LENGTH;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
