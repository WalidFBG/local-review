import * as vscode from 'vscode';
import { Comment } from '@local-review/core';

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

  constructor(comment: Comment, thread: vscode.CommentThread, editable: boolean) {
    this.commentId = comment.id;
    this.thread = thread;
    this.savedBody = comment.body ?? '';
    this.body = comment.body === undefined ? statusOnly(comment) : new vscode.MarkdownString(comment.body);
    this.author = { name: comment.author };
    this.label = label(comment);
    this.timestamp = comment.at;
    this.contextValue = editable ? 'editable' : undefined;
  }
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
    parts.push(`edited by ${comment.editedBy}`);
  }
  return parts.length > 0 ? parts.join(' · ') : undefined;
}
