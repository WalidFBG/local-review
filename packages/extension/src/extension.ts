import * as vscode from 'vscode';
import { STATUSES, Status } from '@local-review/core';
import { ReviewComment } from './reviewComment';
import { ReviewSession, SessionHost } from './reviewSession';
import { ThreadsTree, isThreadNode } from './threadsTree';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const extension = new LocalReviewExtension(context);
  context.subscriptions.push(extension);
  await extension.start();
}

class LocalReviewExtension implements SessionHost, vscode.Disposable {
  readonly controller = vscode.comments.createCommentController('localReview', 'Local Review');
  private readonly sessions = new Map<string, ReviewSession>();
  private readonly output = vscode.window.createOutputChannel('Local Review');
  private readonly tree = new ThreadsTree(() => this.allSessions());
  private readonly treeView = vscode.window.createTreeView('localReview.threads', { treeDataProvider: this.tree });
  private readonly context: vscode.ExtensionContext;
  readonly extensionUri: vscode.Uri;
  private lastError: string | undefined;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.extensionUri = context.extensionUri;
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: document =>
        this.sessionFor(document.uri) ? [new vscode.Range(0, 0, Math.max(0, document.lineCount - 1), 0)] : [],
    };
  }

  async start(): Promise<void> {
    this.registerCommands();
    const subscriptions = this.context.subscriptions;
    const fileWatcher = vscode.workspace.createFileSystemWatcher('**/*');
    subscriptions.push(
      this.controller,
      this.output,
      this.treeView,
      fileWatcher,
      fileWatcher.onDidChange(uri => this.onFileChanged(uri)),
      fileWatcher.onDidCreate(uri => this.onFileChanged(uri)),
      fileWatcher.onDidDelete(uri => this.onFileChanged(uri)),
      vscode.workspace.onDidSaveTextDocument(document => this.onFileChanged(document.uri)),
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.syncFolders()),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('localReview.author')) {
          this.sessions.forEach(session => session.scheduleRefresh());
        }
      }),
    );
    await this.syncFolders();
  }

  author(): string {
    return vscode.workspace.getConfiguration('localReview').get<string>('author', 'human');
  }

  reportError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.output.appendLine(`[${new Date().toISOString()}] ${message}`);
    if (message !== this.lastError) {
      this.lastError = message;
      void vscode.window.showErrorMessage(`Local Review: ${message}`);
    }
  }

  onThreadsChanged(): void {
    this.lastError = undefined;
    this.tree.refresh();
    const needsYou = this.tree.needsYouCount();
    this.treeView.badge = needsYou > 0 ? { value: needsYou, tooltip: `${needsYou} thread(s) need you` } : undefined;
    this.treeView.description = this.allSessions().map(session => session.branch).join(', ');
  }

  private allSessions(): ReviewSession[] {
    return [...new Set(this.sessions.values())];
  }

  dispose(): void {
    new Set(this.sessions.values()).forEach(session => session.dispose());
    this.sessions.clear();
  }

  private async syncFolders(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    for (const [key, session] of [...this.sessions]) {
      if (!folders.some(folder => folder.uri.toString() === key)) {
        this.sessions.delete(key);
        if (![...this.sessions.values()].includes(session)) {
          session.dispose();
        }
      }
    }
    for (const folder of folders) {
      const key = folder.uri.toString();
      if (this.sessions.has(key)) {
        continue;
      }
      const session = await ReviewSession.create(folder, this);
      if (!session) {
        continue;
      }
      const existing = [...this.sessions.values()].find(candidate => candidate.root === session.root);
      if (existing) {
        session.dispose();
        this.sessions.set(key, existing);
      } else {
        this.sessions.set(key, session);
      }
    }
    this.onThreadsChanged();
  }

  private sessionFor(uri: vscode.Uri): ReviewSession | undefined {
    return this.allSessions().find(session => session.contains(uri));
  }

  private threadArgument(argument: unknown): { session: ReviewSession; thread: vscode.CommentThread } {
    if (isThreadNode(argument)) {
      return { session: argument.session, thread: argument.session.commentThread(argument.thread.id) };
    }
    const thread = argument as vscode.CommentThread;
    return { session: this.sessionOwning(thread), thread };
  }

  private sessionOwning(thread: vscode.CommentThread): ReviewSession {
    const session = this.allSessions().find(candidate => candidate.owns(thread));
    if (!session) {
      throw new Error('This thread is not part of the local review.');
    }
    return session;
  }

  private onFileChanged(uri: vscode.Uri): void {
    this.sessionFor(uri)?.onFileChanged(uri);
  }

  private registerCommands(): void {
    const register = (command: string, handler: (...args: any[]) => Promise<void>) =>
      this.context.subscriptions.push(
        vscode.commands.registerCommand(command, async (...args: any[]) => {
          try {
            await handler(...args);
          } catch (error) {
            this.reportError(error);
          }
        }),
      );

    register('localReview.createThread', async (reply: vscode.CommentReply) => {
      const session = this.sessionFor(reply.thread.uri);
      if (!session) {
        throw new Error('This file is not in a git repository with a local review.');
      }
      await session.createThread(reply);
    });
    register('localReview.reply', async (reply: vscode.CommentReply) =>
      this.sessionOwning(reply.thread).update(reply.thread, { body: reply.text }),
    );
    register('localReview.startReply', async (thread: vscode.CommentThread) => this.sessionOwning(thread).startReply(thread));
    register('localReview.cancelReply', async (reply: vscode.CommentReply) =>
      this.sessionOwning(reply.thread).cancelReply(reply.thread),
    );
    register('localReview.publish', async (argument: unknown) => {
      const { session, thread } = this.threadArgument(argument);
      await session.update(thread, { status: 'open' });
    });
    register('localReview.resolve', async (argument: unknown) => {
      const { session, thread } = this.threadArgument(argument);
      await session.update(thread, { status: 'resolved' });
    });
    register('localReview.reopen', async (argument: unknown) => {
      const { session, thread } = this.threadArgument(argument);
      await session.update(thread, { status: 'open' });
    });
    register('localReview.setStatus', async (thread: vscode.CommentThread) => {
      const choices = STATUSES.filter(status => status !== 'draft' && status !== thread.contextValue);
      const status = await vscode.window.showQuickPick(choices, { placeHolder: 'New status' });
      if (status !== undefined) {
        await this.sessionOwning(thread).update(thread, { status: status as Status });
      }
    });
    register('localReview.deleteThread', async (thread: vscode.CommentThread) => {
      const answer = await vscode.window.showWarningMessage('Delete this thread and all its replies?', { modal: true }, 'Delete');
      if (answer === 'Delete') {
        await this.sessionOwning(thread).delete(thread);
      }
    });
    register('localReview.editComment', async (comment: ReviewComment) => {
      comment.body = comment.savedBody;
      comment.mode = vscode.CommentMode.Editing;
      comment.thread.comments = [...comment.thread.comments];
    });
    register('localReview.cancelEdit', async (comment: ReviewComment) => {
      comment.mode = vscode.CommentMode.Preview;
      comment.thread.comments = [...comment.thread.comments];
      this.sessionOwning(comment.thread).scheduleRefresh();
    });
    register('localReview.saveComment', async (comment: ReviewComment) => {
      const body = typeof comment.body === 'string' ? comment.body : comment.body.value;
      comment.mode = vscode.CommentMode.Preview;
      comment.thread.comments = [...comment.thread.comments];
      await this.sessionOwning(comment.thread).edit(comment, body);
    });
    register('localReview.publishAll', async () => {
      let published = 0;
      for (const session of new Set(this.sessions.values())) {
        published += await session.publishAll();
      }
      void vscode.window.showInformationMessage(`Published ${published} draft${published === 1 ? '' : 's'}.`);
    });
    register('localReview.clearBranch', async () => {
      const sessions = this.allSessions();
      const session =
        sessions.length === 1
          ? sessions[0]
          : (
              await vscode.window.showQuickPick(
                sessions.map(candidate => ({ label: candidate.branch, description: candidate.root, session: candidate })),
                { placeHolder: 'Which review?' },
              )
            )?.session;
      if (!session) {
        return;
      }
      const answer = await vscode.window.showWarningMessage(
        `Delete every review thread on ${session.branch}?`,
        { modal: true },
        'Delete',
      );
      if (answer === 'Delete') {
        await session.clear();
      }
    });
    register('localReview.reveal', async (id: string) => {
      const session = this.allSessions().find(candidate => candidate.snapshot.some(thread => thread.id === id));
      if (!session) {
        throw new Error(`Thread ${id} is no longer in the review.`);
      }
      await session.reveal(id);
    });
    register('localReview.refresh', async () => {
      this.lastError = undefined;
      await Promise.all(this.allSessions().map(session => session.refresh()));
    });
  }
}
