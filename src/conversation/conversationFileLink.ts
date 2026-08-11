import * as vscode from 'vscode';
import {
  resolveConversationFileLink,
  type ConversationWorkspaceFolder
} from './conversationChangedFiles';

export async function openConversationFileLink(
  target: string,
  cwd: string,
  workspaceFolders: readonly ConversationWorkspaceFolder[]
): Promise<boolean> {
  const file = resolveConversationFileLink(target, cwd, workspaceFolders);
  if (!file) return false;
  const selection = file.line === undefined
    ? undefined
    : new vscode.Range(
      file.line - 1,
      (file.column ?? 1) - 1,
      file.line - 1,
      (file.column ?? 1) - 1
    );
  await vscode.window.showTextDocument(
    vscode.Uri.file(file.absolutePath),
    selection ? { selection } : undefined
  );
  return true;
}
