import * as path from 'node:path';
import { AnchorResolver, captureAnchor, toRepoPath } from './anchor';
import { validateAuthor } from './events';
import { openRepo } from './git';
import { REVIEWER, canSee, checkCanSee, checkCreate, checkEdit, checkStatusChange, isHuman } from './rules';
import {
  appendEvent,
  branchDir,
  createThread,
  deleteBranchReview,
  deleteThread,
  moveBranchReview,
  readThread,
  readThreads,
} from './store';
import { deriveThread } from './thread';
import { Location, RepoContext, Status, Thread } from './types';

export interface NewThread {
  file: string;
  startLine: number;
  endLine: number;
  body: string;
  status?: Status;
  content?: string;
}

export interface ThreadUpdate {
  body?: string;
  status?: Status;
}

export interface LocatedThread extends Thread {
  location: Location;
}

export class Review {
  readonly repo: RepoContext;
  readonly dir: string;

  private constructor(repo: RepoContext) {
    this.repo = repo;
    this.dir = branchDir(repo.commonDir, repo.branch);
  }

  static async open(cwd: string): Promise<Review> {
    return new Review(await openRepo(cwd));
  }

  async threads(author: string): Promise<Thread[]> {
    return (await readThreads(this.dir)).map(deriveThread).filter(thread => canSee(author, thread));
  }

  async locatedThreads(author: string): Promise<LocatedThread[]> {
    const resolver = new AnchorResolver(this.repo);
    const threads = await this.threads(author);
    return Promise.all(threads.map(async thread => ({ ...thread, location: await resolver.resolve(thread.file, thread.anchor) })));
  }

  async thread(author: string, id: string): Promise<Thread> {
    const stored = await readThread(this.threadDir(id)).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    });
    if (!stored) {
      throw new Error(`Thread ${id} not found on branch ${this.repo.branch}.`);
    }
    const thread = deriveThread(stored);
    checkCanSee(author, thread);
    return thread;
  }

  async locate(thread: Thread): Promise<Location> {
    return new AnchorResolver(this.repo).resolve(thread.file, thread.anchor);
  }

  async add(author: string, newThread: NewThread): Promise<Thread> {
    validateAuthor(author);
    const status = newThread.status ?? (author === REVIEWER ? 'draft' : 'open');
    checkCreate(author, status);
    const file = toRepoPath(this.repo, newThread.file);
    const anchor = await captureAnchor(this.repo, file, newThread.startLine, newThread.endLine, newThread.content);
    const id = await createThread(this.dir, { file, anchor }, author, { body: newThread.body, status });
    return this.thread(author, id);
  }

  async update(author: string, id: string, update: ThreadUpdate): Promise<Thread> {
    validateAuthor(author);
    const thread = await this.thread(author, id);
    if (update.status !== undefined) {
      checkStatusChange(author, thread, update.status);
    }
    await appendEvent(this.threadDir(id), author, update);
    return this.thread(author, id);
  }

  async edit(author: string, id: string, commentId: string, body: string): Promise<Thread> {
    validateAuthor(author);
    const thread = await this.thread(author, id);
    const comment = thread.comments.find(candidate => candidate.id === commentId);
    if (!comment) {
      throw new Error(`Comment ${commentId} not found in thread ${id}.`);
    }
    checkEdit(author, thread, comment);
    await appendEvent(this.threadDir(id), author, { body, edits: commentId });
    return this.thread(author, id);
  }

  async delete(author: string, id: string): Promise<void> {
    if (!isHuman(author)) {
      throw new Error(`Only the human can delete threads.`);
    }
    await this.thread(author, id);
    await deleteThread(this.threadDir(id));
  }

  async clear(author: string): Promise<void> {
    if (!isHuman(author)) {
      throw new Error(`Only the human can clear a review.`);
    }
    await deleteBranchReview(this.dir);
  }

  async moveFrom(fromBranch: string, toBranch: string): Promise<void> {
    await moveBranchReview(branchDir(this.repo.commonDir, fromBranch), branchDir(this.repo.commonDir, toBranch));
  }

  private threadDir(id: string): string {
    if (!/^[0-9a-f]{6}$/.test(id)) {
      throw new Error(`Invalid thread id "${id}".`);
    }
    return path.join(this.dir, id);
  }
}
