import { AppServerError } from '../common/errors';

export function conversationErrorMessage(error: unknown): string {
  if (error instanceof AppServerError) {
    switch (error.code) {
      case 'cli-not-found':
        return 'Codex CLI was not found. Open the extension settings and configure codexPath.';
      case 'request-timeout':
        return 'Codex App Server timed out while loading this conversation.';
      case 'incompatible-cli':
      case 'protocol-error':
        return 'This Codex CLI returned an incompatible conversation history response.';
      case 'connection-closed':
      case 'process-start-failed':
      case 'disposed':
        return 'The Codex App Server connection is unavailable. Reload the history to reconnect.';
      case 'request-failed':
        return 'Codex App Server could not read this thread.';
    }
  }
  return 'An unexpected error occurred while loading this conversation.';
}
