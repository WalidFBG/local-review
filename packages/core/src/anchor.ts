import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { commitExists, fileInCommit, git, gitOrThrow, headCommit } from './git';
import { Anchor, Location, RepoContext } from './types';

export interface Hunk {
  oldStart: number;
  oldCount: number;
  newCount: number;
}

export type MappedRange = { startLine: number; endLine: number; overlaps: boolean };

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function splitLines(content: string): string[] {
  return content.split(/\r?\n/);
}

export function toRepoPath(repo: RepoContext, file: string): string {
  const relative = path.relative(repo.root, path.resolve(repo.root, file));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${file} is outside the repository ${repo.root}.`);
  }
  return relative.split(path.sep).join('/');
}

export async function captureAnchor(
  repo: RepoContext,
  file: string,
  startLine: number,
  endLine: number,
  content?: string,
): Promise<Anchor> {
  const diskContent = await fs.readFile(path.join(repo.root, file), 'utf8');
  const lines = splitLines(content ?? diskContent);
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine || endLine > lines.length) {
    throw new Error(`Lines ${startLine}-${endLine} are outside ${file} (${lines.length} lines).`);
  }
  const commit = await headCommit(repo.root);
  const dirty =
    (content !== undefined && content !== diskContent) ||
    commit === null ||
    !(await fileInCommit(repo.root, commit, file)) ||
    (await git(repo.root, ['diff', '--quiet', commit, '--', file])).exitCode !== 0;
  return { startLine, endLine, commit, dirty, snippet: lines.slice(startLine - 1, endLine).join('\n') };
}

export function parseHunks(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  for (const line of splitLines(diff)) {
    const match = HUNK_HEADER.exec(line);
    if (match) {
      hunks.push({
        oldStart: Number(match[1]),
        oldCount: match[2] === undefined ? 1 : Number(match[2]),
        newCount: match[4] === undefined ? 1 : Number(match[4]),
      });
    }
  }
  return hunks;
}

export function mapRange(startLine: number, endLine: number, hunks: Hunk[]): MappedRange {
  let shift = 0;
  for (const hunk of hunks) {
    if (hunk.oldCount === 0) {
      if (hunk.oldStart < startLine) {
        shift += hunk.newCount;
      } else if (hunk.oldStart < endLine) {
        return { startLine: startLine + shift, endLine: endLine + shift, overlaps: true };
      }
      continue;
    }
    const hunkEnd = hunk.oldStart + hunk.oldCount - 1;
    if (hunkEnd < startLine) {
      shift += hunk.newCount - hunk.oldCount;
    } else if (hunk.oldStart <= endLine) {
      return { startLine: startLine + shift, endLine: endLine + shift, overlaps: true };
    }
  }
  return { startLine: startLine + shift, endLine: endLine + shift, overlaps: false };
}

export function findSnippet(lines: string[], snippet: string, nearLine: number): number | undefined {
  const target = splitLines(snippet);
  let best: number | undefined;
  for (let start = 0; start + target.length <= lines.length; start++) {
    if (target.every((line, offset) => lines[start + offset] === line)) {
      const candidate = start + 1;
      if (best === undefined || Math.abs(candidate - nearLine) < Math.abs(best - nearLine)) {
        best = candidate;
      }
    }
  }
  return best;
}

export class AnchorResolver {
  private readonly repo: RepoContext;
  private readonly contents = new Map<string, Promise<string[] | undefined>>();
  private readonly renames = new Map<string, Promise<Map<string, string>>>();

  constructor(repo: RepoContext) {
    this.repo = repo;
  }

  async resolve(file: string, anchor: Anchor): Promise<Location> {
    if (!anchor.dirty && anchor.commit !== null && (await this.isCommitted(anchor.commit, file))) {
      return this.resolveThroughDiff(file, anchor, anchor.commit);
    }
    return this.resolveBySnippet(file, anchor);
  }

  private async resolveThroughDiff(file: string, anchor: Anchor, commit: string): Promise<Location> {
    let currentFile = file;
    if ((await this.lines(file)) === undefined) {
      const renamed = (await this.renamesSince(commit)).get(file);
      if (renamed === undefined) {
        return { file, startLine: anchor.startLine, endLine: anchor.endLine, outdated: true };
      }
      currentFile = renamed;
    }
    const pathspec = currentFile === file ? [file] : [file, currentFile];
    const diff = await gitOrThrow(this.repo.root, ['diff', '-M', '-U0', '--no-color', '--no-ext-diff', commit, '--', ...pathspec]);
    const mapped = mapRange(anchor.startLine, anchor.endLine, parseHunks(diff));
    return this.clamp({ file: currentFile, startLine: mapped.startLine, endLine: mapped.endLine, outdated: mapped.overlaps });
  }

  private async resolveBySnippet(file: string, anchor: Anchor): Promise<Location> {
    const lines = await this.lines(file);
    if (lines === undefined) {
      return { file, startLine: anchor.startLine, endLine: anchor.endLine, outdated: true };
    }
    const found = findSnippet(lines, anchor.snippet, anchor.startLine);
    if (found === undefined) {
      return this.clamp({ file, startLine: anchor.startLine, endLine: anchor.endLine, outdated: true });
    }
    const length = anchor.endLine - anchor.startLine;
    return { file, startLine: found, endLine: found + length, outdated: false };
  }

  private async clamp(location: Location): Promise<Location> {
    const lines = await this.lines(location.file);
    const lastLine = Math.max(1, lines?.length ?? 1);
    const startLine = Math.min(Math.max(1, location.startLine), lastLine);
    const endLine = Math.min(Math.max(startLine, location.endLine), lastLine);
    return { ...location, startLine, endLine };
  }

  private async isCommitted(commit: string, file: string): Promise<boolean> {
    return (await commitExists(this.repo.root, commit)) && (await fileInCommit(this.repo.root, commit, file));
  }

  private lines(file: string): Promise<string[] | undefined> {
    let cached = this.contents.get(file);
    if (!cached) {
      cached = fs.readFile(path.join(this.repo.root, file), 'utf8').then(
        content => splitLines(content),
        error => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return undefined;
          }
          throw error;
        },
      );
      this.contents.set(file, cached);
    }
    return cached;
  }

  private renamesSince(commit: string): Promise<Map<string, string>> {
    let cached = this.renames.get(commit);
    if (!cached) {
      cached = gitOrThrow(this.repo.root, ['diff', '-M', '--name-status', '--diff-filter=R', '-z', commit]).then(output => {
        const fields = output.split('\0').filter(field => field.length > 0);
        const renames = new Map<string, string>();
        for (let index = 0; index + 2 < fields.length; index += 3) {
          renames.set(fields[index + 1], fields[index + 2]);
        }
        return renames;
      });
      this.renames.set(commit, cached);
    }
    return cached;
  }
}
