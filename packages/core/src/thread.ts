import { Comment, Status, StoredThread, Thread } from './types';

export function deriveThread(stored: StoredThread): Thread {
  const comments: Comment[] = [];
  const commentsById = new Map<string, Comment>();
  let status: Status | undefined;

  for (const event of stored.events) {
    if (event.edits !== undefined) {
      const target = commentsById.get(event.edits);
      if (!target) {
        throw new Error(`Thread ${stored.id}: event ${event.id} edits unknown comment ${event.edits}.`);
      }
      target.body = event.body;
      target.editedAt = event.at;
      target.editedBy = event.author;
      continue;
    }
    const comment: Comment = { id: event.id, author: event.author, at: event.at, body: event.body, status: event.status };
    comments.push(comment);
    commentsById.set(comment.id, comment);
    if (event.status !== undefined) {
      status = event.status;
    }
  }

  if (status === undefined) {
    throw new Error(`Thread ${stored.id} has no status.`);
  }

  return {
    id: stored.id,
    file: stored.record.file,
    anchor: stored.record.anchor,
    status,
    createdBy: comments[0].author,
    createdAt: comments[0].at,
    comments,
  };
}
