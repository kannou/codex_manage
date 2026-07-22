import type { ConversationRuntimeSettings } from '../../conversation/conversationSession';

export const conversationPermissionOptions: readonly {
  readonly value: string;
  readonly label: string;
  readonly description: string;
}[] = [
  { value: 'ask', label: 'Ask', description: 'Ask you to approve eligible operations.' },
  { value: 'auto', label: 'Auto', description: 'Let an independent reviewer approve eligible operations for you.' },
  { value: 'full', label: 'Full', description: 'Run without sandbox restrictions or approval prompts.' }
];

export const standardSpeedLabel = 'Standard';

export function runtimeSettingsSummary(runtime: ConversationRuntimeSettings | undefined): string {
  if (!runtime || runtime.status === 'loading') return 'Loading settings…';
  if (runtime.status === 'unavailable') return 'Unavailable';
  const model = stripRuntimeMetadata(
    runtimeOptionLabel(runtime.models, runtime.model) ?? runtime.model ?? 'Model unavailable'
  );
  const effort = effectiveRuntimeLabel(
    runtime.efforts,
    runtime.effort,
    runtime.defaultEffort
  );
  const parts = [model];
  if (effort) parts.push(effort);
  parts.push(isFastRuntime(runtime) ? 'Fast' : standardSpeedLabel);
  const permission = runtimePermissionLabel(runtime);
  if (permission !== 'Ask for approval') parts.push(permission);
  return parts.join(' | ');
}

export function runtimePermissionLabel(
  runtime: Pick<ConversationRuntimeSettings, 'sandbox' | 'approvalPolicy' | 'approvalsReviewer'>
): string {
  if (runtime.sandbox === 'workspace-write' && runtime.approvalPolicy === 'on-request') {
    if (runtime.approvalsReviewer === 'user') return 'Ask for approval';
    if (runtime.approvalsReviewer === 'auto_review') return 'Approve for me';
  }
  if (runtime.sandbox === 'danger-full-access' && runtime.approvalPolicy === 'never') {
    return 'Full access';
  }
  if (runtime.sandbox === 'read-only') return 'Read only';
  return 'Custom permissions';
}

export function defaultRuntimeLabel(
  fallback: string,
  defaultValue: string | null | undefined,
  options: readonly { readonly value: string; readonly label: string }[]
): string {
  if (!defaultValue) return options.length > 0 ? fallback : 'Unavailable';
  return `${fallback} (${runtimeOptionLabel(options, defaultValue) ?? defaultValue})`;
}

function runtimeOptionLabel(
  options: readonly { readonly value: string; readonly label: string }[],
  value: string | null | undefined
): string | undefined {
  return value ? options.find((option) => option.value === value)?.label : undefined;
}

function effectiveRuntimeLabel(
  options: readonly { readonly value: string; readonly label: string }[],
  selectedValue: string | null | undefined,
  defaultValue: string | null | undefined
): string | undefined {
  if (selectedValue) {
    return stripRuntimeMetadata(runtimeOptionLabel(options, selectedValue) ?? runtimeValueLabel(selectedValue));
  }
  if (!defaultValue) return undefined;
  return defaultRuntimeLabel('Default', defaultValue, options);
}

function isFastRuntime(runtime: ConversationRuntimeSettings): boolean {
  const value = runtime.serviceTier;
  if (!value) return false;
  const label = stripRuntimeMetadata(runtimeOptionLabel(runtime.serviceTiers, value) ?? value);
  return value.toLowerCase() === 'fast' || value.toLowerCase() === 'priority' || label.toLowerCase() === 'fast';
}

function stripRuntimeMetadata(label: string): string {
  return label.replace(/\s*\(current, unlisted\)\s*$/iu, '').trim();
}

function runtimeValueLabel(value: string): string {
  return value ? `${value[0]?.toUpperCase() ?? ''}${value.slice(1)}` : value;
}
