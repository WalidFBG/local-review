import { Comment, Status, Thread } from './types';

export const REVIEWER = 'reviewer';
export const BUILDER = 'builder';

export function isHuman(author: string): boolean {
  return author !== REVIEWER && author !== BUILDER;
}

export function checkCreate(author: string, status: Status): void {
  const allowed: Status[] = author === REVIEWER ? ['draft'] : author === BUILDER ? ['open'] : ['draft', 'open'];
  if (!allowed.includes(status)) {
    throw new Error(`${author} cannot create a ${status} thread; allowed: ${allowed.join(', ')}.`);
  }
}

export function canSee(author: string, thread: Thread): boolean {
  return !(author === BUILDER && thread.status === 'draft');
}

export function checkCanSee(author: string, thread: Thread): void {
  if (!canSee(author, thread)) {
    throw new Error(`Thread ${thread.id} not found.`);
  }
}

export function checkStatusChange(author: string, thread: Thread, to: Status): void {
  checkCanSee(author, thread);
  if (thread.status === to) {
    throw new Error(`Thread ${thread.id} is already ${to}.`);
  }
  if (to === 'draft') {
    throw new Error(`A thread cannot be moved back to draft.`);
  }
  if (thread.status === 'draft') {
    if (!isHuman(author) || to !== 'open') {
      throw new Error(`Only the human can change a draft, and only by publishing it (thread ${thread.id}).`);
    }
    return;
  }
  const allowedRoles: Record<Exclude<Status, 'draft'>, string> = {
    open: 'reviewer or human',
    addressed: 'builder or human',
    disputed: 'builder or human',
    resolved: 'reviewer or human',
  };
  const allowed =
    isHuman(author) ||
    (author === REVIEWER && (to === 'open' || to === 'resolved')) ||
    (author === BUILDER && (to === 'addressed' || to === 'disputed'));
  if (!allowed) {
    throw new Error(`${author} cannot set thread ${thread.id} to ${to}; only the ${allowedRoles[to]} can.`);
  }
}

export function checkEdit(author: string, thread: Thread, comment: Comment): void {
  checkCanSee(author, thread);
  if (comment.body === undefined) {
    throw new Error(`Comment ${comment.id} has no text to edit.`);
  }
  if (!canEdit(author, thread, comment)) {
    throw new Error(`${author} cannot edit ${comment.author}'s comment ${comment.id}.`);
  }
}

export function canEdit(author: string, thread: Thread, comment: Comment): boolean {
  if (!canSee(author, thread) || comment.body === undefined) {
    return false;
  }
  return comment.author === author || (isHuman(author) && thread.status === 'draft');
}
