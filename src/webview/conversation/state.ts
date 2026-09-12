export interface ConversationWebviewState {
  readonly version: 1;
  readonly threadId: string;
  readonly title: string;
}

export function isConversationWebviewState(value: unknown): value is ConversationWebviewState {
  return (
    isObject(value) &&
    value.version === 1 &&
    isBoundedId(value.threadId) &&
    typeof value.title === 'string' && value.title.length <= 512
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512;
}
