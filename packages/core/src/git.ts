import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { RepoContext } from './types';

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function git(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 256 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') {
        reject(error);
        return;
      }
      resolve({ stdout, stderr, exitCode: error ? (error.code as number) : 0 });
    });
  });
}

export async function gitOrThrow(cwd: string, args: string[]): Promise<string> {
  const result = await git(cwd, args);
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${result.exitCode}): ${result.stderr.trim()}`);
  }
  return result.stdout;
}

export async function openRepo(cwd: string): Promise<RepoContext> {
  const output = await gitOrThrow(cwd, [
    'rev-parse',
    '--path-format=absolute',
    '--show-toplevel',
    '--git-dir',
    '--git-common-dir',
  ]);
  const [root, gitDir, commonDir] = output.trim().split(/\r?\n/).map(line => path.resolve(line));
  return { root, gitDir, commonDir, branch: await currentBranch(root) };
}

export async function currentBranch(root: string): Promise<string> {
  const symbolic = await git(root, ['symbolic-ref', '--short', '-q', 'HEAD']);
  if (symbolic.exitCode === 0) {
    return symbolic.stdout.trim();
  }
  const sha = await gitOrThrow(root, ['rev-parse', '--short', 'HEAD']);
  return `detached-${sha.trim()}`;
}

export async function headCommit(root: string): Promise<string | null> {
  const result = await git(root, ['rev-parse', '-q', '--verify', 'HEAD']);
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

export async function commitExists(root: string, commit: string): Promise<boolean> {
  return (await git(root, ['cat-file', '-e', `${commit}^{commit}`])).exitCode === 0;
}

export async function fileInCommit(root: string, commit: string, file: string): Promise<boolean> {
  return (await git(root, ['cat-file', '-e', `${commit}:${file}`])).exitCode === 0;
}
