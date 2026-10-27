export const STATUSES = ['draft', 'open', 'addressed', 'disputed', 'resolved'] as const;

export type Status = (typeof STATUSES)[number];

export interface Anchor {
  startLine: number;
  endLine: number;
  commit: string | null;
  dirty: boolean;
  snippet: string;
}

export interface ThreadRecord {
  file: string;
  anchor: Anchor;
}

export interface EventRecord {
  body?: string;
  status?: Status;
  edits?: string;
}

export interface StoredEvent extends EventRecord {
  id: string;
  at: Date;
  author: string;
}

export interface StoredThread {
  id: string;
  dir: string;
  record: ThreadRecord;
  events: StoredEvent[];
}

export interface Comment {
  id: string;
  author: string;
  at: Date;
  body?: string;
  status?: Status;
  editedAt?: Date;
  editedBy?: string;
}

export interface Thread {
  id: string;
  file: string;
  anchor: Anchor;
  status: Status;
  createdBy: string;
  createdAt: Date;
  comments: Comment[];
}

export interface Location {
  file: string;
  startLine: number;
  endLine: number;
  outdated: boolean;
}

export interface RepoContext {
  root: string;
  gitDir: string;
  commonDir: string;
  branch: string;
}
