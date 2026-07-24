import type { Thread } from '../codex/protocol/generated/v2/Thread';
import type { ThreadItem } from '../codex/protocol/generated/v2/ThreadItem';
import type { Turn } from '../codex/protocol/generated/v2/Turn';
import type { ConversationNotification } from '../codex/protocol/guards';

type ItemLifecycle = 'unknown' | 'started' | 'completed';

interface ItemState {
  readonly turnId: string;
  readonly lifecycle: ItemLifecycle;
}

/**
 * Host-owned conversation state. Raw protocol values never cross the Webview
 * boundary; ConversationSession exposes only the sanitized ViewModel.
 */
export interface ConversationReducerState {
  readonly thread: Thread;
  readonly items: ReadonlyMap<string, ItemState>;
  readonly hiddenTransientActivityIds: ReadonlySet<string>;
  readonly lingeringCompletedActivityIds: ReadonlySet<string>;
  readonly needsResync: boolean;
}

export function createConversationReducerState(thread: Thread): ConversationReducerState {
  const items = new Map<string, ItemState>();
  const turnIds = new Set<string>();
  let needsResync = false;
  let activeTurns = 0;

  for (const turn of thread.turns) {
    if (turnIds.has(turn.id)) {
      needsResync = true;
    }
    turnIds.add(turn.id);
    if (turn.status === 'inProgress') {
      activeTurns += 1;
    }
    for (const item of turn.items) {
      const owner = items.get(item.id);
      if (owner && owner.turnId !== turn.id) {
        needsResync = true;
        continue;
      }
      items.set(item.id, {
        turnId: turn.id,
        lifecycle: isTerminalTurn(turn) ? 'completed' : 'unknown'
      });
    }
  }

  const activityVisibility = deriveActivityVisibility(thread);
  return {
    thread,
    items,
    ...activityVisibility,
    needsResync: needsResync ||
      activeTurns > 1 ||
      (activeTurns > 0 && thread.status.type !== 'active')
  };
}

export function hydrateConversationReducer(
  state: ConversationReducerState,
  thread: Thread
): ConversationReducerState {
  if (thread.id !== state.thread.id) {
    return markNeedsResync(state);
  }
  return createConversationReducerState(thread);
}

export function reduceConversationNotification(
  state: ConversationReducerState,
  notification: ConversationNotification
): ConversationReducerState {
  if (notification.params.threadId !== state.thread.id) {
    return state;
  }

  switch (notification.method) {
    case 'turn/started':
      return reduceTurnStarted(state, notification.params.turn);
    case 'turn/completed':
      return reduceTurnCompleted(state, notification.params.turn);
    case 'item/started':
      return reduceItemStarted(
        state,
        notification.params.turnId,
        notification.params.item
      );
    case 'item/completed':
      return reduceItemCompleted(
        state,
        notification.params.turnId,
        notification.params.item
      );
    case 'item/agentMessage/delta':
      return reduceAgentMessageDelta(
        state,
        notification.params.turnId,
        notification.params.itemId,
        notification.params.delta
      );
    case 'item/reasoning/summaryPartAdded':
      return reduceReasoningSummaryUpdate(
        state,
        notification.params.turnId,
        notification.params.itemId,
        notification.params.summaryIndex,
        null
      );
    case 'item/reasoning/summaryTextDelta':
      return reduceReasoningSummaryUpdate(
        state,
        notification.params.turnId,
        notification.params.itemId,
        notification.params.summaryIndex,
        notification.params.delta
      );
    case 'thread/status/changed': {
      const thread = { ...state.thread, status: notification.params.status };
      const inconsistent = notification.params.status.type !== 'active' &&
        hasInProgressConversationTurn(state);
      return {
        ...state,
        thread,
        needsResync: state.needsResync || inconsistent
      };
    }
    case 'error':
      return notification.params.willRetry ? state : markNeedsResync(state);
  }
}

export function reduceTurnStartResponse(
  state: ConversationReducerState,
  turn: Turn
): ConversationReducerState {
  return reduceTurnStarted(state, turn);
}

export function activeConversationTurnId(state: ConversationReducerState): string | null {
  const active = state.thread.turns.filter((turn) => turn.status === 'inProgress');
  return active.length === 1 ? active[0]?.id ?? null : null;
}

export function hasInProgressConversationTurn(state: ConversationReducerState): boolean {
  return state.thread.turns.some((turn) => turn.status === 'inProgress');
}

export function isConversationBusy(state: ConversationReducerState): boolean {
  return state.thread.status.type === 'active' || hasInProgressConversationTurn(state);
}

function reduceTurnStarted(
  state: ConversationReducerState,
  incoming: Turn
): ConversationReducerState {
  const existing = findTurn(state.thread, incoming.id);
  if (existing && isTerminalTurn(existing)) {
    return state;
  }
  if (hasForeignItemOwner(state, incoming.id, incoming.items)) {
    return markNeedsResync(state);
  }

  const merged = existing ? mergeStartedTurn(existing, incoming) : incoming;
  const items = replaceTurnItemStates(state.items, incoming.id, merged.items, 'started');
  const thread = upsertTurn(state.thread, merged);
  const activeCount = thread.turns.filter((turn) => turn.status === 'inProgress').length;
  const existingItems = new Map(existing?.items.map((item) => [item.id, item]) ?? []);
  const startsNextActivity = incoming.items.some((item) =>
    isNewVisibleActivity(item, existingItems.get(item.id))
  );
  return {
    thread,
    items,
    ...(startsNextActivity ? hideLingeringCompletedActivities(state) : activityVisibility(state)),
    needsResync: state.needsResync || incoming.status !== 'inProgress' || activeCount > 1
  };
}

function reduceTurnCompleted(
  state: ConversationReducerState,
  incoming: Turn
): ConversationReducerState {
  const existing = findTurn(state.thread, incoming.id);
  if (
    existing &&
    isTerminalTurn(existing) &&
    existing.itemsView === 'full' &&
    incoming.itemsView !== 'full'
  ) {
    return state;
  }
  if (hasForeignItemOwner(state, incoming.id, incoming.items)) {
    return markNeedsResync(state);
  }

  const completed = existing && incoming.itemsView !== 'full'
    ? mergePartialCompletedTurn(existing, incoming)
    : incoming;
  return {
    thread: upsertTurn(state.thread, completed),
    items: replaceTurnItemStates(state.items, incoming.id, completed.items, 'completed'),
    hiddenTransientActivityIds: new Set(),
    lingeringCompletedActivityIds: new Set(),
    needsResync: state.needsResync || !isTerminalTurn(incoming)
  };
}

function reduceItemStarted(
  state: ConversationReducerState,
  turnId: string,
  incoming: ThreadItem
): ConversationReducerState {
  const owner = state.items.get(incoming.id);
  if (owner && owner.turnId !== turnId) {
    return markNeedsResync(state);
  }

  const turn = findTurn(state.thread, turnId);
  if (turn && (isTerminalTurn(turn) || owner?.lifecycle === 'completed')) {
    return state;
  }

  const target = turn ?? placeholderTurn(turnId);
  const current = target.items.find((item) => item.id === incoming.id);
  const merged = current ? mergeStartedItem(current, incoming) : incoming;
  const conflict = Boolean(current && current.type !== incoming.type);
  const updatedTurn = upsertItem(target, merged);
  const items = new Map(state.items);
  items.set(incoming.id, { turnId, lifecycle: 'started' });
  return {
    thread: upsertTurn(state.thread, updatedTurn),
    items,
    ...(isNewVisibleActivity(incoming, current)
      ? hideLingeringCompletedActivities(state)
      : activityVisibility(state)),
    needsResync: state.needsResync || conflict
  };
}

function reduceItemCompleted(
  state: ConversationReducerState,
  turnId: string,
  incoming: ThreadItem
): ConversationReducerState {
  const owner = state.items.get(incoming.id);
  if (owner && owner.turnId !== turnId) {
    return markNeedsResync(state);
  }

  const turn = findTurn(state.thread, turnId);
  if (turn && isTerminalTurn(turn)) {
    return state;
  }

  const target = turn ?? placeholderTurn(turnId);
  const current = target.items.find((item) => item.id === incoming.id);
  if (current && current.type !== incoming.type) {
    return markNeedsResync(state);
  }
  const items = new Map(state.items);
  items.set(incoming.id, { turnId, lifecycle: 'completed' });
  const startsNextActivity = isNewVisibleActivity(incoming, current);
  let visibility = startsNextActivity
    ? hideLingeringCompletedActivities(state)
    : activityVisibility(state);
  if (isTransientActivity(incoming)) {
    const hiddenIds = new Set(visibility.hiddenTransientActivityIds);
    const lingeringIds = new Set(visibility.lingeringCompletedActivityIds);
    if (isSuccessfulTransientActivity(incoming)) {
      if (owner?.lifecycle !== 'completed') {
        hiddenIds.delete(incoming.id);
        lingeringIds.add(incoming.id);
      }
    } else {
      hiddenIds.delete(incoming.id);
      lingeringIds.delete(incoming.id);
    }
    visibility = {
      hiddenTransientActivityIds: hiddenIds,
      lingeringCompletedActivityIds: lingeringIds
    };
  }
  return {
    thread: upsertTurn(state.thread, upsertItem(target, incoming)),
    items,
    ...visibility,
    needsResync: state.needsResync
  };
}

function reduceAgentMessageDelta(
  state: ConversationReducerState,
  turnId: string,
  itemId: string,
  delta: string
): ConversationReducerState {
  const owner = state.items.get(itemId);
  if (owner && owner.turnId !== turnId) {
    return markNeedsResync(state);
  }

  const turn = findTurn(state.thread, turnId);
  if (turn && (isTerminalTurn(turn) || owner?.lifecycle === 'completed')) {
    return state;
  }

  const target = turn ?? placeholderTurn(turnId);
  const current = target.items.find((item) => item.id === itemId);
  if (current && current.type !== 'agentMessage') {
    return markNeedsResync(state);
  }

  const message: ThreadItem = current
    ? { ...current, text: `${current.text}${delta}` }
    : {
      type: 'agentMessage',
      id: itemId,
      text: delta,
      phase: null,
      memoryCitation: null
    };
  const items = new Map(state.items);
  items.set(itemId, { turnId, lifecycle: 'started' });
  return {
    thread: upsertTurn(state.thread, upsertItem(target, message)),
    items,
    ...(delta.trim().length > 0
      ? hideLingeringCompletedActivities(state)
      : activityVisibility(state)),
    needsResync: state.needsResync
  };
}

function reduceReasoningSummaryUpdate(
  state: ConversationReducerState,
  turnId: string,
  itemId: string,
  summaryIndex: number,
  delta: string | null
): ConversationReducerState {
  const owner = state.items.get(itemId);
  if (owner && owner.turnId !== turnId) {
    return markNeedsResync(state);
  }

  const turn = findTurn(state.thread, turnId);
  if (turn && (isTerminalTurn(turn) || owner?.lifecycle === 'completed')) {
    return state;
  }

  const target = turn ?? placeholderTurn(turnId);
  const current = target.items.find((item) => item.id === itemId);
  if (current && current.type !== 'reasoning') {
    return markNeedsResync(state);
  }

  const summary = current?.type === 'reasoning' ? [...current.summary] : [];
  if (summaryIndex > summary.length) {
    return markNeedsResync(state);
  }
  if (summaryIndex === summary.length) {
    summary.push('');
  }
  if (delta !== null) {
    summary[summaryIndex] = `${summary[summaryIndex] ?? ''}${delta}`;
  }

  const reasoning: ThreadItem = current?.type === 'reasoning'
    ? { ...current, summary }
    : { type: 'reasoning', id: itemId, summary, content: [] };
  const items = new Map(state.items);
  items.set(itemId, { turnId, lifecycle: 'started' });
  return {
    thread: upsertTurn(state.thread, upsertItem(target, reasoning)),
    items,
    ...(isNewVisibleActivity(reasoning, current)
      ? hideLingeringCompletedActivities(state)
      : activityVisibility(state)),
    needsResync: state.needsResync
  };
}

function deriveActivityVisibility(thread: Thread): Pick<
  ConversationReducerState,
  'hiddenTransientActivityIds' | 'lingeringCompletedActivityIds'
> {
  const activeTurns = thread.turns.filter((turn) => turn.status === 'inProgress');
  if (activeTurns.length !== 1) {
    return {
      hiddenTransientActivityIds: new Set(),
      lingeringCompletedActivityIds: new Set()
    };
  }

  const items = activeTurns[0]?.items ?? [];
  const completedIds = new Set(
    items.filter(isStoredSuccessfulTransientActivity).map((item) => item.id)
  );
  let lingeringId: string | undefined;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item && isVisibleActivity(item)) {
      if (completedIds.has(item.id)) {
        lingeringId = item.id;
      }
      break;
    }
  }
  if (lingeringId) {
    completedIds.delete(lingeringId);
  }
  return {
    hiddenTransientActivityIds: completedIds,
    lingeringCompletedActivityIds: lingeringId ? new Set([lingeringId]) : new Set()
  };
}

function activityVisibility(
  state: ConversationReducerState
): Pick<
  ConversationReducerState,
  'hiddenTransientActivityIds' | 'lingeringCompletedActivityIds'
> {
  return {
    hiddenTransientActivityIds: state.hiddenTransientActivityIds,
    lingeringCompletedActivityIds: state.lingeringCompletedActivityIds
  };
}

function hideLingeringCompletedActivities(
  state: ConversationReducerState
): Pick<
  ConversationReducerState,
  'hiddenTransientActivityIds' | 'lingeringCompletedActivityIds'
> {
  if (state.lingeringCompletedActivityIds.size === 0) {
    return activityVisibility(state);
  }
  const hiddenIds = new Set(state.hiddenTransientActivityIds);
  for (const id of state.lingeringCompletedActivityIds) {
    hiddenIds.add(id);
  }
  return {
    hiddenTransientActivityIds: hiddenIds,
    lingeringCompletedActivityIds: new Set()
  };
}

function isNewVisibleActivity(
  incoming: ThreadItem,
  current: ThreadItem | undefined
): boolean {
  return isVisibleActivity(incoming) && (!current || !isVisibleActivity(current));
}

function isVisibleActivity(item: ThreadItem): boolean {
  if (item.type === 'userMessage') {
    return false;
  }
  if (item.type === 'agentMessage') {
    return item.text.trim().length > 0;
  }
  if (item.type === 'reasoning') {
    return item.summary.some((part) => part.trim().length > 0);
  }
  return true;
}

function isTransientActivity(item: ThreadItem): boolean {
  return [
    'commandExecution',
    'fileChange',
    'mcpToolCall',
    'dynamicToolCall',
    'webSearch',
    'imageView',
    'imageGeneration',
    'sleep'
  ].includes(item.type);
}

function isSuccessfulTransientActivity(item: ThreadItem): boolean {
  switch (item.type) {
    case 'commandExecution':
    case 'fileChange':
      return item.status === 'completed';
    case 'mcpToolCall':
      return item.status === 'completed' && item.error === null;
    case 'dynamicToolCall':
      return item.status === 'completed' && item.success !== false;
    case 'webSearch':
    case 'imageView':
    case 'sleep':
      return true;
    case 'imageGeneration': {
      const status = item.status.toLowerCase();
      return !['fail', 'error', 'declin', 'interrupt', 'cancel'].some((value) =>
        status.includes(value)
      );
    }
    default:
      return false;
  }
}

function isStoredSuccessfulTransientActivity(item: ThreadItem): boolean {
  if (item.type === 'imageGeneration') {
    return ['completed', 'success', 'succeeded'].includes(item.status.toLowerCase());
  }
  return item.type !== 'webSearch' &&
    item.type !== 'imageView' &&
    item.type !== 'sleep' &&
    isSuccessfulTransientActivity(item);
}

function mergeStartedTurn(existing: Turn, incoming: Turn): Turn {
  const incomingById = new Map(incoming.items.map((item) => [item.id, item]));
  const existingById = new Map(existing.items.map((item) => [item.id, item]));
  const order = [
    ...incoming.items.map((item) => item.id),
    ...existing.items.map((item) => item.id).filter((id) => !incomingById.has(id))
  ];
  return {
    ...incoming,
    items: order.flatMap((id) => {
      const current = existingById.get(id);
      const next = incomingById.get(id);
      if (current && next) {
        return [mergeStartedItem(current, next)];
      }
      return next ? [next] : current ? [current] : [];
    })
  };
}

function mergeStartedItem(current: ThreadItem, incoming: ThreadItem): ThreadItem {
  if (current.type !== incoming.type) {
    return current;
  }
  if (current.type === 'agentMessage' && incoming.type === 'agentMessage') {
    if (current.text.startsWith(incoming.text)) {
      return current;
    }
    if (incoming.text.startsWith(current.text)) {
      return incoming;
    }
    return current;
  }
  if (current.type === 'reasoning' && incoming.type === 'reasoning') {
    const length = Math.max(current.summary.length, incoming.summary.length);
    const summary = Array.from({ length }, (_, index) => {
      const currentPart = current.summary[index] ?? '';
      const incomingPart = incoming.summary[index] ?? '';
      if (currentPart.startsWith(incomingPart)) {
        return currentPart;
      }
      return incomingPart.startsWith(currentPart) ? incomingPart : currentPart;
    });
    return { ...incoming, summary };
  }
  return current;
}

function mergePartialCompletedTurn(existing: Turn, incoming: Turn): Turn {
  const incomingById = new Map(incoming.items.map((item) => [item.id, item]));
  const existingById = new Map(existing.items.map((item) => [item.id, item]));
  const order = [
    ...incoming.items.map((item) => item.id),
    ...existing.items.map((item) => item.id).filter((id) => !incomingById.has(id))
  ];
  return {
    ...incoming,
    items: order.flatMap((id) => {
      const current = existingById.get(id);
      const next = incomingById.get(id);
      if (current?.type === 'agentMessage' && next?.type === 'agentMessage') {
        return [mergeStartedItem(current, next)];
      }
      return next ? [next] : current ? [current] : [];
    })
  };
}

function replaceTurnItemStates(
  source: ReadonlyMap<string, ItemState>,
  turnId: string,
  turnItems: readonly ThreadItem[],
  lifecycle: ItemLifecycle
): ReadonlyMap<string, ItemState> {
  const items = new Map(
    [...source].filter(([, value]) => value.turnId !== turnId)
  );
  for (const item of turnItems) {
    const previous = source.get(item.id);
    const nextLifecycle = lifecycle === 'started' &&
      previous?.turnId === turnId &&
      previous.lifecycle === 'completed'
      ? 'completed'
      : lifecycle;
    items.set(item.id, { turnId, lifecycle: nextLifecycle });
  }
  return items;
}

function hasForeignItemOwner(
  state: ConversationReducerState,
  turnId: string,
  items: readonly ThreadItem[]
): boolean {
  return items.some((item) => {
    const owner = state.items.get(item.id);
    return owner !== undefined && owner.turnId !== turnId;
  });
}

function upsertTurn(thread: Thread, turn: Turn): Thread {
  const index = thread.turns.findIndex((candidate) => candidate.id === turn.id);
  if (index < 0) {
    return { ...thread, turns: [...thread.turns, turn] };
  }
  const turns = [...thread.turns];
  turns[index] = turn;
  return { ...thread, turns };
}

function upsertItem(turn: Turn, item: ThreadItem): Turn {
  const index = turn.items.findIndex((candidate) => candidate.id === item.id);
  if (index < 0) {
    return { ...turn, items: [...turn.items, item] };
  }
  const items = [...turn.items];
  items[index] = item;
  return { ...turn, items };
}

function findTurn(thread: Thread, turnId: string): Turn | undefined {
  return thread.turns.find((turn) => turn.id === turnId);
}

function placeholderTurn(turnId: string): Turn {
  return {
    id: turnId,
    items: [],
    itemsView: 'full',
    status: 'inProgress',
    error: null,
    startedAt: null,
    completedAt: null,
    durationMs: null
  };
}

function isTerminalTurn(turn: Turn): boolean {
  return turn.status !== 'inProgress';
}

function markNeedsResync(state: ConversationReducerState): ConversationReducerState {
  return state.needsResync ? state : { ...state, needsResync: true };
}
