import {
  MAX_SUGGESTION_QUERY_LENGTH,
  type ConversationSuggestionKind
} from './protocol';

export interface ComposerSuggestionTrigger {
  readonly kind: ConversationSuggestionKind;
  readonly marker: '@' | '$';
  readonly query: string;
  readonly start: number;
  readonly end: number;
}

export interface AppliedComposerSuggestion {
  readonly text: string;
  readonly caret: number;
}

export function suggestionScrollDelta(
  viewportTop: number,
  viewportBottom: number,
  itemTop: number,
  itemBottom: number
): number {
  if (itemTop < viewportTop) return itemTop - viewportTop;
  if (itemBottom > viewportBottom) return itemBottom - viewportBottom;
  return 0;
}

export function findComposerSuggestionTrigger(
  text: string,
  selectionStart: number,
  selectionEnd = selectionStart
): ComposerSuggestionTrigger | undefined {
  if (
    selectionStart !== selectionEnd ||
    selectionStart < 1 ||
    selectionStart > text.length
  ) {
    return undefined;
  }
  const lowerBound = Math.max(0, selectionStart - MAX_SUGGESTION_QUERY_LENGTH - 1);
  for (let index = selectionStart - 1; index >= lowerBound; index -= 1) {
    const character = text[index];
    if (character === '@' || character === '$') {
      if (index > 0 && !isSuggestionBoundary(text[index - 1] ?? '')) {
        return undefined;
      }
      const query = text.slice(index + 1, selectionStart);
      if (/[\s@$]/u.test(query)) return undefined;
      return {
        kind: character === '@' ? 'file' : 'skill',
        marker: character,
        query,
        start: index,
        end: selectionStart
      };
    }
    if (/\s/u.test(character ?? '')) return undefined;
  }
  return undefined;
}

export function applyComposerSuggestion(
  text: string,
  trigger: ComposerSuggestionTrigger
): AppliedComposerSuggestion | undefined {
  if (
    trigger.start < 0 ||
    trigger.end > text.length ||
    trigger.start >= trigger.end ||
    text.slice(trigger.start, trigger.end) !== `${trigger.marker}${trigger.query}`
  ) {
    return undefined;
  }
  const before = text.slice(0, trigger.start);
  const after = text.slice(trigger.end);
  return {
    text: `${before}${after}`,
    caret: before.length
  };
}

function isSuggestionBoundary(character: string): boolean {
  return /[\s([{<"'`「『【（]/u.test(character);
}
