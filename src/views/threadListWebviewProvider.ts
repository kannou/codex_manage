import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import {
  ConversationCoordinator,
  type ConversationCoordinatorLogger,
  type ConversationViewConnection
} from '../conversation/conversationCoordinator';
import {
  isThreadsWebviewMessage,
  restoreThreadsWebviewState,
  type ReduceMotionPreference
} from '../webview/threads/protocol';

export interface ThreadListWebviewProviderOptions {
  readonly extensionUri: vscode.Uri;
  readonly coordinator: ConversationCoordinator;
  readonly readReduceMotion?: () => ReduceMotionPreference;
  readonly logger: ConversationCoordinatorLogger;
}

export class ThreadListWebviewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private readonly viewDisposables: vscode.Disposable[] = [];
  private connection: ConversationViewConnection | undefined;

  public constructor(private readonly options: ThreadListWebviewProviderOptions) {}

  public resolveWebviewView(
    view: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext<unknown>
  ): void {
    this.disposeViewListeners();
    this.connection?.dispose();
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      enableForms: false,
      enableCommandUris: false,
      localResourceRoots: [webviewRoot(this.options.extensionUri)]
    };
    view.webview.html = this.html(view.webview);
    const restoredState = restoreThreadsWebviewState(context.state);
    const connection = this.options.coordinator.attachPresentation({
      postMessage: (message) => { void view.webview.postMessage(message); },
      isVisible: () => view.visible,
      setUnreadCount: (count) => this.setUnreadCount(view, count)
    }, restoredState.screen === 'conversation' ? restoredState.selectedThreadId ?? undefined : undefined);
    this.connection = connection;
    this.viewDisposables.push(
      view.webview.onDidReceiveMessage((message: unknown) => {
        if (!isThreadsWebviewMessage(message)) {
          this.options.logger.appendLine('[threads] Ignored an invalid Webview message.');
          return;
        }
        connection.handleMessage(message);
      }),
      view.onDidChangeVisibility(() => connection.visibilityChanged()),
      view.onDidDispose(() => {
        if (this.view !== view) return;
        this.dispose();
      })
    );
  }

  public dispose(): void {
    this.connection?.dispose();
    this.connection = undefined;
    this.view = undefined;
    this.disposeViewListeners();
  }

  private setUnreadCount(view: vscode.WebviewView, count: number): void {
    if (count === 0) {
      // Replace the previous activity with a hidden zero badge before clearing it.
      view.badge = { value: 0, tooltip: 'No completed conversations to review' };
      view.badge = undefined;
    } else {
      view.badge = {
        value: count,
        tooltip: count === 1
          ? '1 completed conversation to review'
          : `${count} completed conversations to review`
      };
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(18).toString('base64');
    const root = webviewRoot(this.options.extensionUri);
    const script = webview.asWebviewUri(vscode.Uri.joinPath(root, 'threads.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(root, 'threads.css'));
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"
  >
  <link rel="stylesheet" href="${escapeAttribute(style.toString())}">
  <title>Codex Threads</title>
</head>
<body data-reduce-motion="${this.reduceMotionPreference()}">
  <main id="app" aria-live="polite" aria-busy="true">Loading threads…</main>
  <script nonce="${nonce}" src="${escapeAttribute(script.toString())}"></script>
</body>
</html>`;
  }

  private reduceMotionPreference(): ReduceMotionPreference {
    return this.options.readReduceMotion?.() ?? 'auto';
  }

  private disposeViewListeners(): void {
    while (this.viewDisposables.length > 0) {
      this.viewDisposables.pop()?.dispose();
    }
  }
}

function webviewRoot(extensionUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
}

function escapeAttribute(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return character;
    }
  });
}
