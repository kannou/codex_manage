import type { ConversationExecutionViewModel } from './protocol';

export interface ConversationActivityPresentation {
  readonly activityVisible: boolean;
  readonly statusText: string;
}

export function conversationActivityPresentation(
  execution: ConversationExecutionViewModel | undefined,
  waitingForInput: boolean,
  pendingSend: boolean,
  pendingStop: boolean
): ConversationActivityPresentation {
  if (waitingForInput) {
    return {
      activityVisible: false,
      statusText: 'Respond to the request above to continue.'
    };
  }
  if (pendingStop) {
    return { activityVisible: false, statusText: 'Stopping the active turn…' };
  }
  if (pendingSend) {
    return { activityVisible: false, statusText: 'Sending message…' };
  }

  switch (execution?.kind) {
    case 'idle':
      return { activityVisible: false, statusText: '' };
    case 'resuming':
      return { activityVisible: false, statusText: 'Resuming conversation…' };
    case 'starting':
      return { activityVisible: false, statusText: 'Starting a new turn…' };
    case 'running':
      return { activityVisible: true, statusText: 'Codex is responding' };
    case 'stopping':
      return { activityVisible: false, statusText: 'Stopping the active turn…' };
    case 'unavailable':
      return { activityVisible: false, statusText: execution.message };
    default:
      return { activityVisible: false, statusText: 'Loading conversation…' };
  }
}
