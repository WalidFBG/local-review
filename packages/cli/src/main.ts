#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Comment, LocatedThread, Review, STATUSES, Status, Thread } from '@local-review/core';

const BOOLEAN_FLAGS = new Set(['json', 'all', 'yes', 'help']);

const USAGE = `lrv: local review threads for the current branch

  lrv add <file> <start>[-<end>] (--body <text> | --body-file <path|->) [--status draft|open]
  lrv list [--status <s>[,<s>...]] [--json]
  lrv show <id> [--json]
  lrv reply <id> (--body <text> | --body-file <path|->) [--status <s>]
  lrv status <id> <status>
  lrv edit <id> <comment id> (--body <text> | --body-file <path|->)
  lrv publish (<id>... | --all)
  lrv delete <id>
  lrv clear --yes
  lrv move <old branch> <new branch>

Every command needs an author: --author <name>, or the LRV_AUTHOR environment variable.
Agents use reviewer or builder; any other name has the human's rights. Statuses: ${STATUSES.join(', ')}.`;

interface Arguments {
  positional: string[];
  flags: Map<string, string | true>;
}

function parseArguments(argv: string[]): Arguments {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (!argument.startsWith('--')) {
      positional.push(argument);
      continue;
    }
    const name = argument.slice(2);
    if (BOOLEAN_FLAGS.has(name)) {
      flags.set(name, true);
      continue;
    }
    const value = argv[++index];
    if (value === undefined) {
      throw new Error(`--${name} needs a value.`);
    }
    flags.set(name, value);
  }
  return { positional, flags };
}

function flag(args: Arguments, name: string): string | undefined {
  const value = args.flags.get(name);
  return value === true ? undefined : value;
}

function required(args: Arguments, index: number, name: string): string {
  const value = args.positional[index];
  if (value === undefined) {
    throw new Error(`Missing <${name}>.\n\n${USAGE}`);
  }
  return value;
}

function parseStatus(value: string): Status {
  if (!STATUSES.includes(value as Status)) {
    throw new Error(`Unknown status "${value}". Use one of: ${STATUSES.join(', ')}.`);
  }
  return value as Status;
}

function body(args: Arguments, isRequired: boolean): string | undefined {
  const text = flag(args, 'body');
  const file = flag(args, 'body-file');
  if (text !== undefined && file !== undefined) {
    throw new Error('Use --body or --body-file, not both.');
  }
  if (file !== undefined) {
    return readFileSync(file === '-' ? 0 : file, 'utf8').trimEnd();
  }
  if (text === undefined && isRequired) {
    throw new Error('A comment needs --body or --body-file.');
  }
  return text;
}

function parseLines(value: string): { startLine: number; endLine: number } {
  const match = /^(\d+)(?:-(\d+))?$/.exec(value);
  if (!match) {
    throw new Error(`Invalid line range "${value}"; use e.g. 52 or 52-54.`);
  }
  const startLine = Number(match[1]);
  return { startLine, endLine: match[2] === undefined ? startLine : Number(match[2]) };
}

function summary(thread: LocatedThread): string {
  const { location } = thread;
  const lines = location.startLine === location.endLine ? `${location.startLine}` : `${location.startLine}-${location.endLine}`;
  const firstLine = thread.comments.find(comment => comment.body !== undefined)?.body?.split(/\r?\n/)[0] ?? '';
  const outdated = location.outdated ? ' (outdated)' : '';
  return `${thread.id}  ${thread.status.padEnd(9)}  ${location.file}:${lines}${outdated}  ${thread.createdBy}: ${firstLine}`;
}

function describeComment(comment: Comment): string {
  const heading = [`[${comment.id}]`, comment.author, comment.at.toISOString()];
  if (comment.status !== undefined) {
    heading.push(`-> ${comment.status}`);
  }
  if (comment.editedBy !== undefined) {
    heading.push(`(edited by ${comment.editedBy})`);
  }
  const text = comment.body === undefined ? '' : `\n${indent(comment.body)}`;
  return `${heading.join('  ')}${text}`;
}

function describe(thread: LocatedThread): string {
  const header = summary(thread);
  const snippet = thread.location.outdated ? `\nOriginal code:\n${indent(thread.anchor.snippet)}\n` : '';
  return `${header}\n${snippet}\n${thread.comments.map(describeComment).join('\n\n')}`;
}

function indent(text: string): string {
  return text
    .split(/\r?\n/)
    .map(line => `    ${line}`)
    .join('\n');
}

function toJson(thread: LocatedThread): object {
  return {
    id: thread.id,
    status: thread.status,
    file: thread.location.file,
    startLine: thread.location.startLine,
    endLine: thread.location.endLine,
    outdated: thread.location.outdated,
    originalFile: thread.file,
    snippet: thread.anchor.snippet,
    createdBy: thread.createdBy,
    createdAt: thread.createdAt.toISOString(),
    comments: thread.comments.map(comment => ({
      id: comment.id,
      author: comment.author,
      at: comment.at.toISOString(),
      body: comment.body ?? null,
      status: comment.status ?? null,
      editedBy: comment.editedBy ?? null,
    })),
  };
}

async function located(review: Review, thread: Thread): Promise<LocatedThread> {
  return { ...thread, location: await review.locate(thread) };
}

async function print(review: Review, thread: Thread, args: Arguments): Promise<void> {
  const result = await located(review, thread);
  console.log(args.flags.has('json') ? JSON.stringify(toJson(result), null, 2) : summary(result));
}

async function main(argv: string[]): Promise<void> {
  const args = parseArguments(argv);
  const command = args.positional.shift();
  if (command === undefined || args.flags.has('help')) {
    console.log(USAGE);
    return;
  }
  const author = flag(args, 'author') ?? process.env.LRV_AUTHOR;
  if (author === undefined || author.length === 0) {
    throw new Error('No author: pass --author <name> (reviewer, builder, or your own name), or set LRV_AUTHOR.');
  }
  const review = await Review.open(process.cwd());

  switch (command) {
    case 'add': {
      const file = required(args, 0, 'file');
      const lines = parseLines(required(args, 1, 'start-end'));
      const status = flag(args, 'status');
      const thread = await review.add(author, {
        file,
        ...lines,
        body: body(args, true)!,
        status: status === undefined ? undefined : parseStatus(status),
      });
      await print(review, thread, args);
      return;
    }
    case 'list': {
      const statusFilter = flag(args, 'status')?.split(',').map(parseStatus);
      const threads = (await review.locatedThreads(author)).filter(thread =>
        statusFilter === undefined ? thread.status !== 'draft' : statusFilter.includes(thread.status),
      );
      if (args.flags.has('json')) {
        console.log(JSON.stringify(threads.map(toJson), null, 2));
      } else if (threads.length === 0) {
        console.log(`No threads on ${review.repo.branch}.`);
      } else {
        threads.forEach(thread => console.log(summary(thread)));
      }
      return;
    }
    case 'show': {
      const thread = await located(review, await review.thread(author, required(args, 0, 'id')));
      console.log(args.flags.has('json') ? JSON.stringify(toJson(thread), null, 2) : describe(thread));
      return;
    }
    case 'reply': {
      const status = flag(args, 'status');
      const thread = await review.update(author, required(args, 0, 'id'), {
        body: body(args, true),
        status: status === undefined ? undefined : parseStatus(status),
      });
      await print(review, thread, args);
      return;
    }
    case 'status': {
      const thread = await review.update(author, required(args, 0, 'id'), { status: parseStatus(required(args, 1, 'status')) });
      await print(review, thread, args);
      return;
    }
    case 'edit': {
      const thread = await review.edit(author, required(args, 0, 'id'), required(args, 1, 'comment id'), body(args, true)!);
      await print(review, thread, args);
      return;
    }
    case 'publish': {
      const ids = args.flags.has('all')
        ? (await review.threads(author)).filter(thread => thread.status === 'draft').map(thread => thread.id)
        : args.positional;
      if (ids.length === 0) {
        throw new Error(args.flags.has('all') ? 'No drafts to publish.' : 'Name the threads to publish, or use --all.');
      }
      for (const id of ids) {
        await print(review, await review.update(author, id, { status: 'open' }), args);
      }
      return;
    }
    case 'delete': {
      const id = required(args, 0, 'id');
      await review.delete(author, id);
      console.log(`Deleted thread ${id}.`);
      return;
    }
    case 'clear': {
      if (!args.flags.has('yes')) {
        throw new Error(`This deletes every thread on ${review.repo.branch}. Run again with --yes.`);
      }
      await review.clear(author);
      console.log(`Cleared the review on ${review.repo.branch}.`);
      return;
    }
    case 'move': {
      const from = required(args, 0, 'old branch');
      const to = required(args, 1, 'new branch');
      await review.moveFrom(from, to);
      console.log(`Moved the review from ${from} to ${to}.`);
      return;
    }
    default:
      throw new Error(`Unknown command "${command}".\n\n${USAGE}`);
  }
}

main(process.argv.slice(2)).catch(error => {
  console.error(`lrv: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
