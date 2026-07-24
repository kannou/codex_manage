import type { ConversationViewModel } from '../../conversation/conversationViewModel';

export interface ConversationLatestState {
  readonly marker: string | undefined;
  readonly hasUnseenActivity: boolean;
}

export interface ConversationLatestUpdate {
  readonly state: ConversationLatestState;
  readonly followLatest: boolean;
}

export function createConversationLatestState(): ConversationLatestState {
  return { marker: undefined, hasUnseenActivity: false };
}

export function updateConversationLatest(
  state: ConversationLatestState,
  model: ConversationViewModel,
  initialRender: boolean,
  nearBottom: boolean
): ConversationLatestUpdate {
  const marker = latestActivityMarker(model);
  const followLatest = initialRender || nearBottom;
  return {
    state: {
      marker,
      hasUnseenActivity: followLatest
        ? false
        : state.hasUnseenActivity || (
          state.marker !== undefined &&
          state.marker !== marker
        )
    },
    followLatest
  };
}

export function markConversationLatestSeen(
  state: ConversationLatestState
): ConversationLatestState {
  return state.hasUnseenActivity
    ? { ...state, hasUnseenActivity: false }
    : state;
}

function latestActivityMarker(model: ConversationViewModel): string {
  const turn = model.turns[model.turns.length - 1];
  if (!turn) {
    return '';
  }
  return JSON.stringify([
    turn.id,
    turn.status,
    turn.itemsView,
    turn.errorMessage,
    turn.workDetails,
    turn.changedFiles.map((file) => [file.id, file.change]),
    turn.items.map((item) => item.kind === 'message'
      ? [item.id, item.role, item.text.length]
      : [
        item.id,
        item.activityKind,
        item.title.length,
        item.status,
        item.detail?.length ?? 0
      ])
  ]);
}
