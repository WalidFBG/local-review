import * as vscode from 'vscode';
import { LocatedThread, Status } from '@local-review/core';
import { displayName } from './reviewComment';
import { ReviewSession } from './reviewSession';

interface Section {
  kind: 'section';
  title: string;
  statuses: Status[];
  expanded: boolean;
  icon: string;
  colour: string;
}

export interface ThreadNode {
  kind: 'thread';
  session: ReviewSession;
  thread: LocatedThread;
}

type Node = Section | ThreadNode;

const SECTIONS: Section[] = [
  { kind: 'section', title: 'Needs your approval', statuses: ['draft'], expanded: true, icon: 'edit', colour: 'charts.purple' },
  { kind: 'section', title: 'Waiting for you', statuses: ['addressed', 'disputed'], expanded: true, icon: 'bell-dot', colour: 'charts.yellow' },
  { kind: 'section', title: 'With the builder', statuses: ['open'], expanded: true, icon: 'tools', colour: 'charts.blue' },
  { kind: 'section', title: 'Resolved', statuses: ['resolved'], expanded: false, icon: 'pass-filled', colour: 'charts.green' },
];

export const TINT_SCHEME = 'local-review-tint';

export class SectionTint implements vscode.FileDecorationProvider {
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== TINT_SCHEME) {
      return undefined;
    }
    const section = SECTIONS.find(candidate => candidate.title === decodeURIComponent(uri.authority));
    return section ? { color: new vscode.ThemeColor(section.colour) } : undefined;
  }
}

function tintUri(section: Section, key: string): vscode.Uri {
  return vscode.Uri.from({ scheme: TINT_SCHEME, authority: encodeURIComponent(section.title), path: `/${key}` });
}

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
      return this.inSection(node).sort(
        (a, b) =>
          a.thread.location.file.localeCompare(b.thread.location.file) ||
          a.thread.location.startLine - b.thread.location.startLine,
      );
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
      item.iconPath = new vscode.ThemeIcon(node.icon, new vscode.ThemeColor(node.colour));
      item.resourceUri = tintUri(node, 'section');
      item.description = `${this.inSection(node).length}`;
      return item;
    }
    return this.threadItem(node);
  }

  private threadItem({ thread }: ThreadNode): vscode.TreeItem {
    const section = SECTIONS.find(candidate => candidate.statuses.includes(thread.status))!;
    const firstComment = thread.comments.find(comment => comment.body !== undefined);
    const item = new vscode.TreeItem(preview(firstComment?.body ?? ''), vscode.TreeItemCollapsibleState.None);
    item.id = `thread:${thread.id}`;
    item.iconPath = new vscode.ThemeIcon('blank');
    item.resourceUri = tintUri(section, thread.id);
    item.description = [thread.status === 'disputed' ? 'disputed' : '', thread.location.outdated ? 'outdated' : '']
      .filter(part => part.length > 0)
      .join(' · ');
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
  const { file, startLine, endLine } = thread.location;
  const lines = startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`;
  const markdown = new vscode.MarkdownString(
    `**${displayName(first.author)}** · ${thread.status} · \`${file}:${lines}\`\n\n${first.body}`,
  );
  const latest = comments[comments.length - 1];
  if (comments.length > 1) {
    markdown.appendMarkdown(`\n\n---\n\n**${displayName(latest.author)}** (latest of ${comments.length - 1} replies)\n\n${latest.body}`);
  }
  return markdown;
}
