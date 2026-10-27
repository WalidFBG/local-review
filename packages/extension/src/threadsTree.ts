import * as path from 'node:path';
import * as vscode from 'vscode';
import { LocatedThread, Status } from '@local-review/core';
import { displayName } from './reviewComment';
import { ReviewSession } from './reviewSession';

interface Section {
  kind: 'section';
  title: string;
  statuses: Status[];
  expanded: boolean;
}

interface FileNode {
  kind: 'file';
  section: Section;
  session: ReviewSession;
  file: string;
}

export interface ThreadNode {
  kind: 'thread';
  session: ReviewSession;
  thread: LocatedThread;
}

type Node = Section | FileNode | ThreadNode;

const SECTIONS: Section[] = [
  { kind: 'section', title: 'Needs your approval', statuses: ['draft'], expanded: true },
  { kind: 'section', title: 'Waiting for you', statuses: ['addressed', 'disputed'], expanded: true },
  { kind: 'section', title: 'With the builder', statuses: ['open'], expanded: true },
  { kind: 'section', title: 'Resolved', statuses: ['resolved'], expanded: false },
];

const STATUS_ICONS: Record<Status, vscode.ThemeIcon> = {
  draft: new vscode.ThemeIcon('edit', new vscode.ThemeColor('charts.purple')),
  open: new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.red')),
  addressed: new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.yellow')),
  disputed: new vscode.ThemeIcon('question', new vscode.ThemeColor('charts.orange')),
  resolved: new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('charts.green')),
};

const PREVIEW_LENGTH = 90;

export function isThreadNode(value: unknown): value is ThreadNode {
  return typeof value === 'object' && value !== null && (value as Node).kind === 'thread';
}

export class ThreadsTree implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly sessions: () => ReviewSession[];

  constructor(sessions: () => ReviewSession[]) {
    this.sessions = sessions;
  }

  refresh(): void {
    this.changed.fire();
  }

  needsYouCount(): number {
    return this.threads().filter(({ thread }) => ['draft', 'addressed', 'disputed'].includes(thread.status)).length;
  }

  getChildren(node?: Node): Node[] {
    if (node === undefined) {
      return SECTIONS.filter(section => this.inSection(section).length > 0);
    }
    if (node.kind === 'section') {
      const files = new Map<string, FileNode>();
      for (const { session, thread } of this.inSection(node)) {
        const key = `${session.root}\0${thread.location.file}`;
        if (!files.has(key)) {
          files.set(key, { kind: 'file', section: node, session, file: thread.location.file });
        }
      }
      return [...files.values()].sort((a, b) => a.file.localeCompare(b.file));
    }
    if (node.kind === 'file') {
      return this.inSection(node.section)
        .filter(({ session, thread }) => session === node.session && thread.location.file === node.file)
        .sort((a, b) => a.thread.location.startLine - b.thread.location.startLine);
    }
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'section') {
      const item = new vscode.TreeItem(
        node.title,
        node.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.id = `section:${node.title}`;
      item.description = `${this.inSection(node).length}`;
      return item;
    }
    if (node.kind === 'file') {
      const item = new vscode.TreeItem(path.posix.basename(node.file), vscode.TreeItemCollapsibleState.Expanded);
      item.id = `file:${node.section.title}:${node.session.root}:${node.file}`;
      item.resourceUri = vscode.Uri.file(path.join(node.session.root, node.file));
      item.description = path.posix.dirname(node.file) === '.' ? '' : path.posix.dirname(node.file);
      return item;
    }
    return this.threadItem(node);
  }

  private threadItem({ thread }: ThreadNode): vscode.TreeItem {
    const firstComment = thread.comments.find(comment => comment.body !== undefined);
    const item = new vscode.TreeItem(preview(firstComment?.body ?? ''), vscode.TreeItemCollapsibleState.None);
    item.id = `thread:${thread.id}`;
    item.iconPath = STATUS_ICONS[thread.status];
    const { startLine, endLine } = thread.location;
    item.description = (startLine === endLine ? `L${startLine}` : `L${startLine}-${endLine}`) + (thread.location.outdated ? ' · outdated' : '');
    item.tooltip = tooltip(thread);
    item.contextValue = thread.status;
    item.command = { command: 'localReview.reveal', title: 'Go to Thread', arguments: [thread.id] };
    return item;
  }

  private threads(): ThreadNode[] {
    return this.sessions().flatMap(session => session.snapshot.map(thread => ({ kind: 'thread' as const, session, thread })));
  }

  private inSection(section: Section): ThreadNode[] {
    return this.threads().filter(({ thread }) => section.statuses.includes(thread.status));
  }
}

function preview(body: string): string {
  const firstLine = body.trim().split(/\r?\n/)[0].replace(/[`*_]/g, '');
  return firstLine.length > PREVIEW_LENGTH ? `${firstLine.slice(0, PREVIEW_LENGTH - 1)}…` : firstLine;
}

function tooltip(thread: LocatedThread): vscode.MarkdownString {
  const comments = thread.comments.filter(comment => comment.body !== undefined);
  const first = comments[0];
  const markdown = new vscode.MarkdownString(`**${displayName(first.author)}** · ${thread.status}\n\n${first.body}`);
  const latest = comments[comments.length - 1];
  if (comments.length > 1) {
    markdown.appendMarkdown(`\n\n---\n\n**${displayName(latest.author)}** (latest of ${comments.length - 1} replies)\n\n${latest.body}`);
  }
  return markdown;
}
