import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

export function createRepo(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'lrv-'));
  run(root, 'init', '-q', '-b', 'main');
  run(root, 'config', 'user.email', 'test@example.com');
  run(root, 'config', 'user.name', 'Test');
  run(root, 'config', 'core.autocrlf', 'false');
  return root;
}

export function run(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

export function write(root: string, file: string, lines: string[]): void {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), lines.join('\n') + '\n');
}

export function commitAll(root: string, message = 'commit'): void {
  run(root, 'add', '-A');
  run(root, 'commit', '-q', '-m', message);
}

export function numbered(count: number, prefix = 'line'): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`);
}
