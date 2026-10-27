import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { parse, stringify } from 'yaml';
import { eventFileName, parseEventFileName } from './events';
import { Anchor, EventRecord, STATUSES, Status, StoredEvent, StoredThread, ThreadRecord } from './types';

const THREAD_FILE = 'thread.yaml';

export function reviewRoot(commonDir: string): string {
  return path.join(commonDir, 'review');
}

export function branchDir(commonDir: string, branch: string): string {
  return path.join(reviewRoot(commonDir), encodeURIComponent(branch));
}

export async function createThread(
  dir: string,
  record: ThreadRecord,
  author: string,
  firstEvent: EventRecord,
): Promise<string> {
  validateThreadRecord(record, 'new thread');
  validateEvent(firstEvent, 'new thread');
  await fs.mkdir(dir, { recursive: true });
  const id = await createThreadFolder(dir);
  const threadDir = path.join(dir, id);
  await appendEvent(threadDir, author, firstEvent);
  await writeExclusive(path.join(threadDir, THREAD_FILE), stringify(record));
  return id;
}

export async function appendEvent(threadDir: string, author: string, event: EventRecord, at = new Date()): Promise<string> {
  validateEvent(event, threadDir);
  const content = stringify(withoutUndefined(event));
  for (;;) {
    const fileName = eventFileName(at, author);
    try {
      await writeExclusive(path.join(threadDir, fileName), content);
      return fileName.slice(0, -'.yaml'.length);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }
  }
}

export async function readThreads(dir: string): Promise<StoredThread[]> {
  const entries = await readDirOrEmpty(dir);
  const threads: StoredThread[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const thread = await readThread(path.join(dir, entry.name));
    if (thread) {
      threads.push(thread);
    }
  }
  return threads.sort((a, b) => a.events[0].id.localeCompare(b.events[0].id));
}

export async function readThread(threadDir: string): Promise<StoredThread | undefined> {
  const names = (await fs.readdir(threadDir)).filter(name => !name.startsWith('.'));
  if (!names.includes(THREAD_FILE)) {
    return undefined;
  }
  const record = parse(await fs.readFile(path.join(threadDir, THREAD_FILE), 'utf8'));
  validateThreadRecord(record, threadDir);
  const events: StoredEvent[] = [];
  for (const name of names.filter(name => name !== THREAD_FILE).sort()) {
    const eventName = parseEventFileName(name);
    if (!eventName) {
      throw new Error(`Unrecognised file in review thread: ${path.join(threadDir, name)}`);
    }
    const event = parse(await fs.readFile(path.join(threadDir, name), 'utf8'));
    validateEvent(event, path.join(threadDir, name));
    events.push({ ...event, ...eventName });
  }
  if (events.length === 0) {
    throw new Error(`Review thread has no events: ${threadDir}`);
  }
  return { id: path.basename(threadDir), dir: threadDir, record, events };
}

export async function deleteThread(threadDir: string): Promise<void> {
  await fs.rm(threadDir, { recursive: true });
}

export async function deleteBranchReview(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

export async function moveBranchReview(fromDir: string, toDir: string): Promise<void> {
  if (await exists(toDir)) {
    throw new Error(`A review already exists at ${toDir}`);
  }
  await fs.rename(fromDir, toDir);
}

async function createThreadFolder(dir: string): Promise<string> {
  for (;;) {
    const id = randomBytes(3).toString('hex');
    try {
      await fs.mkdir(path.join(dir, id));
      return id;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }
  }
}

async function writeExclusive(file: string, content: string): Promise<void> {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(4).toString('hex')}.tmp`);
  await fs.writeFile(temporary, content, { flag: 'wx' });
  try {
    await fs.link(temporary, file);
  } finally {
    await fs.unlink(temporary);
  }
}

async function readDirOrEmpty(dir: string) {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function withoutUndefined(event: EventRecord): EventRecord {
  return Object.fromEntries(Object.entries(event).filter(([, value]) => value !== undefined));
}

function validateThreadRecord(value: unknown, source: string): asserts value is ThreadRecord {
  const record = value as ThreadRecord;
  if (typeof record?.file !== 'string' || record.file.length === 0) {
    throw new Error(`Invalid thread record in ${source}: missing file.`);
  }
  validateAnchor(record.anchor, source);
}

function validateAnchor(value: unknown, source: string): asserts value is Anchor {
  const anchor = value as Anchor;
  const valid =
    Number.isInteger(anchor?.startLine) &&
    Number.isInteger(anchor.endLine) &&
    anchor.startLine >= 1 &&
    anchor.endLine >= anchor.startLine &&
    (anchor.commit === null || typeof anchor.commit === 'string') &&
    typeof anchor.dirty === 'boolean' &&
    typeof anchor.snippet === 'string';
  if (!valid) {
    throw new Error(`Invalid anchor in ${source}.`);
  }
}

function validateEvent(value: unknown, source: string): asserts value is EventRecord {
  const event = value as EventRecord;
  if (typeof event !== 'object' || event === null) {
    throw new Error(`Invalid event in ${source}: not an object.`);
  }
  const unknownKeys = Object.keys(event).filter(key => !['body', 'status', 'edits'].includes(key));
  if (unknownKeys.length > 0) {
    throw new Error(`Invalid event in ${source}: unknown field(s) ${unknownKeys.join(', ')}.`);
  }
  if (event.body !== undefined && (typeof event.body !== 'string' || event.body.trim().length === 0)) {
    throw new Error(`Invalid event in ${source}: body must be non-empty text.`);
  }
  if (event.status !== undefined && !STATUSES.includes(event.status as Status)) {
    throw new Error(`Invalid event in ${source}: unknown status "${event.status}".`);
  }
  if (event.edits !== undefined && (typeof event.edits !== 'string' || event.body === undefined || event.status !== undefined)) {
    throw new Error(`Invalid event in ${source}: an edit needs a body and no status.`);
  }
  if (event.body === undefined && event.status === undefined) {
    throw new Error(`Invalid event in ${source}: needs a body or a status.`);
  }
}
