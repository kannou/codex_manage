import type { Memento } from 'vscode';

const TURN_BOOKMARKS_KEY = 'codexThreadManager.turnBookmarks';
const MAX_ID_LENGTH = 512;

interface StoredConversationBookmark {
  readonly threadId: string;
  readonly turnId: string;
  // Turn bookmarks written before message-level bookmarking do not have an item ID.
  readonly itemId?: string;
}

export interface ConversationBookmark {
  readonly turnId: string;
  readonly itemId?: string;
}

export interface TurnBookmarkStorage {
  getBookmarks(threadId: string): readonly ConversationBookmark[];
  setBookmarked(
    threadId: string,
    turnId: string,
    itemId: string,
    bookmarked: boolean,
    removeLegacyTurnBookmark?: boolean
  ): Promise<void>;
}

export class TurnBookmarkStore implements TurnBookmarkStorage {
  public constructor(private readonly state: Memento) {}

  public getBookmarks(threadId: string): readonly ConversationBookmark[] {
    return this.read()
      .filter((bookmark) => bookmark.threadId === threadId)
      .map(({ turnId, itemId }) => ({
        turnId,
        ...(itemId ? { itemId } : {})
      }));
  }

  public async setBookmarked(
    threadId: string,
    turnId: string,
    itemId: string,
    bookmarked: boolean,
    removeLegacyTurnBookmark = false
  ): Promise<void> {
    if (!isValidId(threadId) || !isValidId(turnId) || !isValidId(itemId)) return;
    const current = this.read();
    const remaining = current.filter(
      (bookmark) => bookmark.threadId !== threadId ||
        bookmark.turnId !== turnId ||
        bookmark.itemId !== itemId && !(removeLegacyTurnBookmark && bookmark.itemId === undefined)
    );
    if (!bookmarked && remaining.length === current.length) return;
    await this.state.update(
      TURN_BOOKMARKS_KEY,
      bookmarked ? [{ threadId, turnId, itemId }, ...remaining] : remaining
    );
  }

  private read(): StoredConversationBookmark[] {
    const value = this.state.get<unknown>(TURN_BOOKMARKS_KEY, []);
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    const result: StoredConversationBookmark[] = [];
    for (const item of value) {
      if (!isObject(item) || !isValidId(item.threadId) || !isValidId(item.turnId)) continue;
      if (item.itemId !== undefined && !isValidId(item.itemId)) continue;
      const key = `${item.threadId}\0${item.turnId}\0${item.itemId ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({
        threadId: item.threadId,
        turnId: item.turnId,
        ...(item.itemId ? { itemId: item.itemId } : {})
      });
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
