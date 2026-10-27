import { FSWatcher, mkdirSync, watch } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { LocatedThread, Review, Status, canEdit, reviewRoot } from '@local-review/core';
import { ReviewComment, displayName } from './reviewComment';

const DEBOUNCE_MS = 200;

const STATUS_LABELS: Record<Status, string> = {
  draft: '📝 Draft · not sent to the builder yet',
  open: '🔴 Open',
  addressed: '🟡 Addressed',
  disputed: '🟠 Disputed',
  resolved: '✅ Resolved',
};

const STATUSES_SHOWING_WHO: Status[] = ['addressed', 'disputed', 'resolved'];

export interface SessionHost {
  readonly controller: vscode.CommentController;
  readonly extensionUri: vscode.Uri;
  author(): string;
  reportError(error: unknown): void;
  onThreadsChanged(): void;
}

export class ReviewSession implements vscode.Disposable {
  private review: Review;
  private readonly host: SessionHost;
  private readonly threads = new Map<string, vscode.CommentThread>();
  private readonly ids = new Map<vscode.CommentThread, string>();
  private readonly replying = new Set<string>();
  private readonly watchers: FSWatcher[] = [];
  private files = new Set<string>();
  private located: LocatedThread[] = [];
  private timer: NodeJS.Timeout | undefined;
  private headTimer: NodeJS.Timeout | undefined;
  private refreshing: Promise<void> = Promise.resolve();

  private constructor(review: Review, host: SessionHost) {
    this.review = review;
    this.host = host;
  }

  static async create(folder: vscode.WorkspaceFolder, host: SessionHost): Promise<ReviewSession | undefined> {
    let review: Review;
    try {
      review = await Review.open(folder.uri.fsPath);
    } catch {
      return undefined;
    }
    const session = new ReviewSession(review, host);
    session.watch();
    await session.refresh();
    return session;
  }

  get root(): string {
    return this.review.repo.root;
  }

  get branch(): string {
    return this.review.repo.branch;
  }

  get snapshot(): readonly LocatedThread[] {
    return this.located;
  }

  commentThread(id: string): vscode.CommentThread {
    const thread = this.threads.get(id);
    if (!thread) {
      throw new Error(`Thread ${id} is no longer in the review.`);
    }
    return thread;
  }

  async reveal(id: string): Promise<void> {
    const thread = this.commentThread(id);
    const range = thread.range ?? new vscode.Range(0, 0, 0, 0);
    await vscode.window.showTextDocument(thread.uri, { selection: new vscode.Range(range.start, range.start), preserveFocus: false });
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
  }

  contains(uri: vscode.Uri): boolean {
    if (uri.scheme !== 'file') {
      return false;
    }
    const relative = path.relative(this.root, uri.fsPath);
    return !relative.startsWith('..') && !path.isAbsolute(relative) && !relative.split(path.sep).includes('.git');
  }

  owns(thread: vscode.CommentThread): boolean {
    return this.ids.has(thread);
  }

  idOf(thread: vscode.CommentThread): string {
    const id = this.ids.get(thread);
    if (id === undefined) {
      throw new Error('This thread is not part of the local review.');
    }
    return id;
  }

  scheduleRefresh(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.refresh(), DEBOUNCE_MS);
  }

  refresh(): Promise<void> {
    this.refreshing = this.refreshing.then(() => this.load()).catch(error => this.host.reportError(error));
    return this.refreshing;
  }

  async createThread(reply: vscode.CommentReply): Promise<void> {
    const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === reply.thread.uri.toString());
    const range = reply.thread.range;
    if (range === undefined) {
      throw new Error('A new comment needs a line.');
    }
    await this.review.add(this.host.author(), {
      file: reply.thread.uri.fsPath,
      startLine: range.start.line + 1,
      endLine: range.end.line + 1,
      body: reply.text,
      content: document?.getText(),
    });
    reply.thread.dispose();
    await this.refresh();
  }

  async update(thread: vscode.CommentThread, update: { body?: string; status?: Status }): Promise<void> {
    const id = this.idOf(thread);
    await this.review.update(this.host.author(), id, update);
    if (update.body !== undefined) {
      this.replying.delete(id);
    }
    await this.refresh();
  }

  startReply(thread: vscode.CommentThread): void {
    this.replying.add(this.idOf(thread));
    thread.canReply = true;
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
  }

  cancelReply(thread: vscode.CommentThread): void {
    this.replying.delete(this.idOf(thread));
    thread.canReply = false;
  }

  async edit(comment: ReviewComment, body: string): Promise<void> {
    await this.review.edit(this.host.author(), this.idOf(comment.thread), comment.commentId, body);
    await this.refresh();
  }

  async delete(thread: vscode.CommentThread): Promise<void> {
    await this.review.delete(this.host.author(), this.idOf(thread));
    await this.refresh();
  }

  async publishAll(): Promise<number> {
    const author = this.host.author();
    const drafts = (await this.review.threads(author)).filter(thread => thread.status === 'draft');
    for (const draft of drafts) {
      await this.review.update(author, draft.id, { status: 'open' });
    }
    await this.refresh();
    return drafts.length;
  }

  async clear(): Promise<void> {
    await this.review.clear(this.host.author());
    await this.refresh();
  }

  onFileChanged(uri: vscode.Uri): void {
    if (this.contains(uri) && this.files.has(path.relative(this.root, uri.fsPath).split(path.sep).join('/'))) {
      this.scheduleRefresh();
    }
  }

  dispose(): void {
    clearTimeout(this.timer);
    clearTimeout(this.headTimer);
    this.watchers.forEach(watcher => watcher.close());
    this.removeAll();
  }

  private watch(): void {
    const root = reviewRoot(this.review.repo.commonDir);
    mkdirSync(root, { recursive: true });
    this.watchers.push(watch(root, { recursive: true }, () => this.scheduleRefresh()));
    this.watchers.push(
      watch(this.review.repo.gitDir, (_event, fileName) => {
        if (fileName === 'HEAD') {
          this.onHeadChanged();
        }
      }),
    );
  }

  private onHeadChanged(): void {
    clearTimeout(this.headTimer);
    this.headTimer = setTimeout(() => {
      Review.open(this.root)
        .then(review => {
          if (review.repo.branch !== this.review.repo.branch) {
            this.removeAll();
          }
          this.review = review;
          return this.refresh();
        })
        .catch(error => this.host.reportError(error));
    }, DEBOUNCE_MS);
  }

  private async load(): Promise<void> {
    const author = this.host.author();
    const located = await this.review.locatedThreads(author);
    const seen = new Set<string>();
    for (const thread of located) {
      seen.add(thread.id);
      this.show(thread, author);
    }
    for (const [id, thread] of this.threads) {
      if (!seen.has(id)) {
        this.remove(id, thread);
      }
    }
    this.files = new Set(located.flatMap(thread => [thread.file, thread.location.file]));
    this.located = located;
    this.host.onThreadsChanged();
  }

  private show(located: LocatedThread, author: string): void {
    const uri = vscode.Uri.file(path.join(this.root, located.location.file));
    const range = new vscode.Range(located.location.startLine - 1, 0, located.location.endLine - 1, 0);
    let thread = this.threads.get(located.id);
    if (thread && thread.uri.toString() !== uri.toString()) {
      this.remove(located.id, thread);
      thread = undefined;
    }
    if (!thread) {
      thread = this.host.controller.createCommentThread(uri, range, []);
      this.threads.set(located.id, thread);
      this.ids.set(thread, located.id);
    }
    const target = thread;
    if (this.isEditing(target)) {
      return;
    }
    target.range = range;
    target.comments = located.comments
      .filter(comment => comment.body !== undefined)
      .map(comment => new ReviewComment(comment, target, canEdit(author, located, comment), this.host.extensionUri));
    target.label = threadLabel(located);
    target.contextValue = located.status;
    target.state = located.status === 'resolved' ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
    target.canReply = this.replying.has(located.id);
  }

  private isEditing(thread: vscode.CommentThread): boolean {
    return thread.comments.some(comment => comment.mode === vscode.CommentMode.Editing);
  }

  private remove(id: string, thread: vscode.CommentThread): void {
    this.threads.delete(id);
    this.replying.delete(id);
    this.ids.delete(thread);
    thread.dispose();
  }

  private removeAll(): void {
    for (const [id, thread] of [...this.threads]) {
      this.remove(id, thread);
    }
  }
}

function threadLabel(thread: LocatedThread): string {
  const parts = [STATUS_LABELS[thread.status]];
  const setBy = [...thread.comments].reverse().find(comment => comment.status !== undefined)?.author;
  if (setBy !== undefined && STATUSES_SHOWING_WHO.includes(thread.status)) {
    parts.push(displayName(setBy));
  }
  if (thread.location.outdated) {
    parts.push('⚠ outdated');
  }
  return parts.join(' · ');
}
