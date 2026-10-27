import { randomBytes } from 'node:crypto';

const AUTHOR = /^[a-z0-9][a-z0-9-]*$/;
const EVENT_FILE = /^(\d{8}T\d{9}Z)-([0-9a-f]{6})-([a-z0-9][a-z0-9-]*)\.yaml$/;

export interface EventName {
  id: string;
  at: Date;
  author: string;
}

export function validateAuthor(author: string): void {
  if (!AUTHOR.test(author)) {
    throw new Error(`Invalid author "${author}": use lower-case letters, digits and dashes.`);
  }
}

export function eventFileName(at: Date, author: string): string {
  validateAuthor(author);
  const stamp = at.toISOString().replace(/[-:]/g, '').replace('.', '');
  return `${stamp}-${randomBytes(3).toString('hex')}-${author}.yaml`;
}

export function parseEventFileName(fileName: string): EventName | undefined {
  const match = EVENT_FILE.exec(fileName);
  if (!match) {
    return undefined;
  }
  const [, stamp, , author] = match;
  const iso =
    `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T` +
    `${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}.${stamp.slice(15, 18)}Z`;
  return { id: fileName.slice(0, -'.yaml'.length), at: new Date(iso), author };
}
