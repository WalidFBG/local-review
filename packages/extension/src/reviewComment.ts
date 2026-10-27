import * as vscode from 'vscode';
import { BUILDER, Comment, REVIEWER } from '@local-review/core';

export class ReviewComment implements vscode.Comment {
  readonly commentId: string;
  readonly thread: vscode.CommentThread;
  readonly savedBody: string;
  body: string | vscode.MarkdownString;
  mode = vscode.CommentMode.Preview;
  readonly author: vscode.CommentAuthorInformation;
  readonly label?: string;
  readonly timestamp: Date;
  readonly contextValue?: string;

  constructor(comment: Comment, thread: vscode.CommentThread, editable: boolean, extensionUri: vscode.Uri) {
    this.commentId = comment.id;
    this.thread = thread;
    this.savedBody = comment.body ?? '';
    this.body = comment.body === undefined ? statusOnly(comment) : new vscode.MarkdownString(comment.body);
    this.author = {
      name: displayName(comment.author),
      iconPath: vscode.Uri.joinPath(extensionUri, 'media', `${avatar(comment.author)}.svg`),
    };
    this.label = label(comment);
    this.timestamp = comment.at;
    this.contextValue = editable ? 'editable' : undefined;
  }
}

function displayName(author: string): string {
  if (author === REVIEWER) {
    return 'Reviewer agent';
  }
  if (author === BUILDER) {
    return 'Builder agent';
  }
  return author;
}

function avatar(author: string): string {
  return author === REVIEWER || author === BUILDER ? author : 'human';
}

function statusOnly(comment: Comment): vscode.MarkdownString {
  return new vscode.MarkdownString(`*Set the status to **${comment.status}**.*`);
}

function label(comment: Comment): string | undefined {
  const parts: string[] = [];
  if (comment.status !== undefined && comment.body !== undefined) {
    parts.push(`→ ${comment.status}`);
  }
  if (comment.editedBy !== undefined) {
    parts.push(`edited by ${displayName(comment.editedBy)}`);
  }
  return parts.length > 0 ? parts.join(' · ') : undefined;
}
