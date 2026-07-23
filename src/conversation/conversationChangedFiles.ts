import { createHash } from 'node:crypto';
import { posix, win32, type PlatformPath } from 'node:path';
import type { Thread } from '../codex/protocol/generated/v2/Thread';

export type ConversationChangedFileKind = 'Added' | 'Updated' | 'Deleted' | 'Moved';

export interface ConversationChangedFileViewModel {
  readonly id: string;
  readonly path: string;
  readonly change: ConversationChangedFileKind;
  readonly canOpen: boolean;
}

export interface ConversationWorkspaceFolder {
  readonly path: string;
  readonly name?: string;
}

export interface ResolvedConversationChangedFile extends ConversationChangedFileViewModel {
  readonly absolutePath: string;
}

export function resolveConversationChangedFiles(
  thread: Thread,
  workspaceFolders: readonly ConversationWorkspaceFolder[]
): ReadonlyMap<string, readonly ResolvedConversationChangedFile[]> {
  const byTurn = new Map<string, readonly ResolvedConversationChangedFile[]>();
  for (const turn of thread.turns) {
    if (turn.status === 'inProgress' || turn.itemsView !== 'full') continue;
    const files = new Map<string, ResolvedConversationChangedFile>();
    for (const item of turn.items) {
      if (item.type !== 'fileChange') continue;
      for (const change of item.changes) {
        const movePath = change.kind.type === 'update' ? change.kind.move_path : null;
        const moved = Boolean(movePath);
        const targetPath = movePath ?? change.path;
        const resolved = resolveWorkspacePath(targetPath, thread.cwd, workspaceFolders);
        if (!resolved) continue;
        files.set(resolved.key, {
          id: changedFileId(resolved.key),
          path: resolved.displayPath,
          change: moved ? 'Moved' : changeKind(change.kind.type),
          canOpen: change.kind.type !== 'delete',
          absolutePath: resolved.absolutePath
        });
      }
    }
    if (files.size > 0) byTurn.set(turn.id, [...files.values()]);
  }
  return byTurn;
}

interface ResolvedWorkspacePath {
  readonly key: string;
  readonly absolutePath: string;
  readonly displayPath: string;
}

function resolveWorkspacePath(
  rawPath: string,
  cwd: string,
  workspaceFolders: readonly ConversationWorkspaceFolder[]
): ResolvedWorkspacePath | undefined {
  if (!rawPath || rawPath.includes('\0') || rawPath.split(/[\\/]/u).includes('..')) return undefined;
  const pathApi = pathApiFor(rawPath, cwd);
  if (!pathApi.isAbsolute(rawPath) && !pathApi.isAbsolute(cwd)) return undefined;
  const absolutePath = pathApi.normalize(
    pathApi.isAbsolute(rawPath) ? rawPath : pathApi.resolve(cwd, rawPath)
  );
  const matches = workspaceFolders.flatMap((folder) => {
    const folderApi = pathApiFor(folder.path);
    if (folderApi !== pathApi || !folderApi.isAbsolute(folder.path)) return [];
    const folderPath = folderApi.normalize(folder.path);
    const relativePath = folderApi.relative(folderPath, absolutePath);
    if (
      !relativePath ||
      folderApi.isAbsolute(relativePath) ||
      relativePath === '..' ||
      relativePath.startsWith(`..${folderApi.sep}`)
    ) return [];
    return [{ folder, folderPath, relativePath }];
  }).sort((left, right) => right.folderPath.length - left.folderPath.length);
  const match = matches[0];
  if (!match) return undefined;
  const relativePath = match.relativePath.replace(/\\/gu, '/');
  const requestedName = match.folder.name?.trim();
  const folderName = requestedName &&
    requestedName !== '.' &&
    requestedName !== '..' &&
    !/[\\/]/u.test(requestedName)
    ? requestedName
    : pathApi.basename(match.folderPath);
  return {
    key: pathApi === win32 ? absolutePath.toLowerCase() : absolutePath,
    absolutePath,
    displayPath: workspaceFolders.length > 1 ? `${folderName}/${relativePath}` : relativePath
  };
}

function pathApiFor(path: string, fallback = ''): PlatformPath {
  return /^[a-z]:[\\/]/iu.test(path) || path.startsWith('\\\\') ||
    /^[a-z]:[\\/]/iu.test(fallback) || fallback.startsWith('\\\\')
    ? win32
    : posix;
}

function changeKind(kind: 'add' | 'delete' | 'update'): ConversationChangedFileKind {
  switch (kind) {
    case 'add':
      return 'Added';
    case 'delete':
      return 'Deleted';
    case 'update':
      return 'Updated';
  }
}

function changedFileId(normalizedPath: string): string {
  const digest = createHash('sha256').update(normalizedPath).digest('hex').slice(0, 20);
  return `changed-file-${digest}`;
}
