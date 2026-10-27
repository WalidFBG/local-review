import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findSnippet, mapRange, parseHunks } from '../src/anchor';
import { Review } from '../src/review';
import { commitAll, createRepo, numbered, run, write } from './helpers';

test('hunks above the range shift it and hunks below leave it alone', () => {
  const hunks = [
    { oldStart: 2, oldCount: 0, newCount: 3 },
    { oldStart: 4, oldCount: 2, newCount: 1 },
    { oldStart: 40, oldCount: 5, newCount: 0 },
  ];
  assert.deepEqual(mapRange(10, 12, hunks), { startLine: 12, endLine: 14, overlaps: false });
});

test('a hunk touching the range overlaps it', () => {
  assert.equal(mapRange(10, 12, [{ oldStart: 12, oldCount: 1, newCount: 1 }]).overlaps, true);
  assert.equal(mapRange(10, 12, [{ oldStart: 8, oldCount: 3, newCount: 0 }]).overlaps, true);
  assert.equal(mapRange(10, 12, [{ oldStart: 10, oldCount: 0, newCount: 2 }]).overlaps, true);
  assert.equal(mapRange(10, 12, [{ oldStart: 12, oldCount: 0, newCount: 2 }]).overlaps, false);
  assert.equal(mapRange(10, 12, [{ oldStart: 9, oldCount: 0, newCount: 2 }]).overlaps, false);
});

test('hunk headers without counts default to one line', () => {
  assert.deepEqual(parseHunks('@@ -5 +5,2 @@\n-a\n+b\n+c\n@@ -9,0 +11 @@\n+d'), [
    { oldStart: 5, oldCount: 1, newCount: 2 },
    { oldStart: 9, oldCount: 0, newCount: 1 },
  ]);
});

test('snippet search picks the match nearest the old line', () => {
  const lines = ['a', 'x', 'y', 'b', 'x', 'y', 'c'];
  assert.equal(findSnippet(lines, 'x\ny', 6), 5);
  assert.equal(findSnippet(lines, 'x\ny', 1), 2);
  assert.equal(findSnippet(lines, 'z', 1), undefined);
});

async function threadOn(root: string, startLine: number, endLine: number) {
  const review = await Review.open(root);
  await review.add('human', { file: 'src/a.txt', startLine, endLine, body: 'Look here.' });
  return review;
}

async function location(review: Review) {
  const [thread] = await review.locatedThreads('human');
  return thread.location;
}

test('a committed thread follows lines inserted above it', async () => {
  const root = createRepo();
  write(root, 'src/a.txt', numbered(20));
  commitAll(root);
  const review = await threadOn(root, 10, 11);

  write(root, 'src/a.txt', ['new 1', 'new 2', ...numbered(20)]);

  assert.deepEqual(await location(review), { file: 'src/a.txt', startLine: 12, endLine: 13, outdated: false });
});

test('a committed thread is outdated when its lines change', async () => {
  const root = createRepo();
  write(root, 'src/a.txt', numbered(20));
  commitAll(root);
  const review = await threadOn(root, 10, 11);

  const lines = numbered(20);
  lines[10] = 'changed';
  write(root, 'src/a.txt', lines);

  assert.deepEqual(await location(review), { file: 'src/a.txt', startLine: 10, endLine: 11, outdated: true });
});

test('a committed thread still maps after further commits', async () => {
  const root = createRepo();
  write(root, 'src/a.txt', numbered(20));
  commitAll(root);
  const review = await threadOn(root, 10, 10);

  write(root, 'src/a.txt', ['new', ...numbered(20)]);
  commitAll(root, 'insert');

  assert.deepEqual(await location(review), { file: 'src/a.txt', startLine: 11, endLine: 11, outdated: false });
});

test('a thread follows a renamed file', async () => {
  const root = createRepo();
  write(root, 'src/a.txt', numbered(20));
  commitAll(root);
  const review = await threadOn(root, 5, 6);

  run(root, 'mv', 'src/a.txt', 'src/b.txt');

  assert.deepEqual(await location(review), { file: 'src/b.txt', startLine: 5, endLine: 6, outdated: false });
});

test('a thread on a deleted file is outdated', async () => {
  const root = createRepo();
  write(root, 'src/a.txt', numbered(20));
  commitAll(root);
  const review = await threadOn(root, 5, 6);

  run(root, 'rm', '-q', 'src/a.txt');

  assert.equal((await location(review)).outdated, true);
});

test('a dirty anchor is found again by its snippet', async () => {
  const root = createRepo();
  write(root, 'src/a.txt', numbered(20));
  commitAll(root);
  write(root, 'src/a.txt', ['uncommitted', ...numbered(20)]);
  const review = await threadOn(root, 11, 11);
  const [thread] = await review.threads('human');
  assert.equal(thread.anchor.dirty, true);

  write(root, 'src/a.txt', ['uncommitted', 'more', ...numbered(20)]);

  assert.deepEqual(await location(review), { file: 'src/a.txt', startLine: 12, endLine: 12, outdated: false });
});

test('a thread on an untracked file uses its snippet', async () => {
  const root = createRepo();
  write(root, 'README.md', ['readme']);
  commitAll(root);
  write(root, 'src/a.txt', numbered(5));
  const review = await threadOn(root, 3, 3);

  write(root, 'src/a.txt', ['top', ...numbered(5)]);

  assert.deepEqual(await location(review), { file: 'src/a.txt', startLine: 4, endLine: 4, outdated: false });
});

test('anchoring works before the first commit', async () => {
  const root = createRepo();
  write(root, 'src/a.txt', numbered(5));
  const review = await threadOn(root, 2, 3);
  const [thread] = await review.threads('human');

  assert.equal(thread.anchor.commit, null);
  assert.deepEqual(await location(review), { file: 'src/a.txt', startLine: 2, endLine: 3, outdated: false });
});
