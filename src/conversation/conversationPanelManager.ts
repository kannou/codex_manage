import * as vscode from 'vscode';
import type { ConversationCoordinator, ConversationViewConnection } from './conversationCoordinator';
import {
  createConversationWebviewHtml,
  configureConversationWebview,
  conversationWebviewRoot
} from './conversationWebview';
import { isConversationWebviewState } from '../webview/conversation/state';
import { isThreadsWebviewMessage, type ThreadsHostToWebviewMessage } from '../webview/protocol';

export const CONVERSATION_VIEW_TYPE = 'codexThreadManager.conversation';

export interface ConversationThreadReference {
  readonly id: string;
  readonly title: string;
}

export interface ConversationPanelLogger {
  appendLine(value: string): void;
}

export interface ConversationPanelManagerOptions {
  readonly extensionUri: vscode.Uri;
  readonly coordinator: ConversationCoordinator;
  readonly logger: ConversationPanelLogger;
}

export class ConversationPanelManager implements vscode.WebviewPanelSerializer, vscode.Disposable {
  private managed: ManagedConversationPanel | undefined;

  public constructor(private readonly options: ConversationPanelManagerOptions) {}

  public openThread(reference: ConversationThreadReference): void {
    if (this.managed?.threadId === reference.id) {
      this.managed.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      CONVERSATION_VIEW_TYPE,
      reference.title,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        enableForms: false,
        enableCommandUris: false,
        enableFindWidget: true,
        retainContextWhenHidden: true,
        localResourceRoots: [conversationWebviewRoot(this.options.extensionUri)]
      }
    );
    this.attach(panel, reference);
  }

  public focusPrompt(): boolean {
    if (!this.managed) return false;
    this.managed.focusPrompt();
    return true;
  }

  public async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown): Promise<void> {
    if (!isConversationWebviewState(state)) {
      panel.dispose();
      await vscode.window.showWarningMessage(
        'Codex Thread Manager could not restore a conversation tab because its saved state was invalid.'
      );
      return;
    }
    // Only one restored tab may take ownership of the conversation presentation.
    if (this.managed) {
      panel.dispose();
      return;
    }
    this.attach(panel, { id: state.threadId, title: state.title || 'Codex thread' });
  }

  public dispose(): void {
    this.managed?.close();
    this.managed = undefined;
  }

  private attach(panel: vscode.WebviewPanel, reference: ConversationThreadReference): void {
    this.managed?.close();
    const managed = new ManagedConversationPanel(panel, reference, this.options, () => {
      if (this.managed === managed) this.managed = undefined;
    });
    this.managed = managed;
  }
}

class ManagedConversationPanel {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly connection: ConversationViewConnection;
  public readonly threadId: string;
  private webviewFocused = false;
  private pendingPromptFocus = false;

  public constructor(
    private readonly panel: vscode.WebviewPanel,
    reference: ConversationThreadReference,
    private readonly options: ConversationPanelManagerOptions,
    onDispose: () => void
  ) {
    this.threadId = reference.id;
    configureConversationWebview(panel.webview, options.extensionUri);
    panel.title = reference.title;
    panel.webview.html = createConversationWebviewHtml(panel.webview, options.extensionUri, {
      version: 1, threadId: reference.id, title: reference.title
    });
    this.connection = options.coordinator.attachPresentation({
      postMessage: (message) => this.post(message),
      isVisible: () => panel.visible && panel.active,
      setUnreadCount: () => undefined,
      deactivate: () => this.close()
    }, reference.id, reference);
    this.disposables.push(
      panel.webview.onDidReceiveMessage((message: unknown) => {
        if (!isThreadsWebviewMessage(message)) {
          options.logger.appendLine('[conversation] Ignored an invalid Webview message.');
          return;
        }
        if (message.type === 'threads/viewFocus') this.webviewFocused = message.focused;
        this.connection.handleMessage(message);
        this.completePromptFocus();
      }),
      panel.onDidChangeViewState(() => {
        if (!panel.active || !panel.visible) {
          this.webviewFocused = false;
          this.pendingPromptFocus = false;
        }
        this.connection.visibilityChanged();
      }),
      panel.onDidDispose(() => {
        this.connection.dispose();
        while (this.disposables.length) this.disposables.pop()?.dispose();
        onDispose();
      })
    );
  }

  public reveal(): void {
    this.panel.reveal(undefined, false);
  }

  public focusPrompt(): void {
    this.pendingPromptFocus = true;
    if (this.panel.active && this.panel.visible && this.webviewFocused) {
      this.completePromptFocus();
    } else {
      // Wait for the Webview's focus acknowledgement before focusing its input.
      this.reveal();
    }
  }

  private completePromptFocus(): void {
    if (!this.pendingPromptFocus || !this.webviewFocused || !this.panel.active || !this.panel.visible) return;
    this.pendingPromptFocus = false;
    if (!this.options.coordinator.focusConversationPrompt()) this.pendingPromptFocus = true;
  }

  public close(): void {
    this.panel.dispose();
  }

  private post(message: ThreadsHostToWebviewMessage): void {
    if (message.type === 'threads/conversationLoaded' || message.type === 'threads/conversationState' ||
        message.type === 'threads/conversationCreated') {
      this.panel.title = message.state.model.title;
    }
    void this.panel.webview.postMessage(message);
    if (message.type === 'threads/conversationLoaded' || message.type === 'threads/conversationState') {
      this.completePromptFocus();
    }
  }
}
