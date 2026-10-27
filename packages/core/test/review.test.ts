import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { test } from 'node:test';
import { parseEventFileName, eventFileName } from '../src/events';
import { Review } from '../src/review';
import { commitAll, createRepo, numbered, run, write } from './helpers';

async function setUp() {
  const root = createRepo();
  write(root, 'src/a.txt', numbered(20));
  commitAll(root);
  return { root, review: await Review.open(root) };
}

test('event file names round-trip their time and author', () => {
  const at = new Date('2026-10-27T11:22:40.123Z');
  const parsed = parseEventFileName(eventFileName(at, 'reviewer'));
  assert.equal(parsed?.at.toISOString(), at.toISOString());
  assert.equal(parsed?.author, 'reviewer');
});

test('invalid authors are rejected', async () => {
  const { review } = await setUp();
  await assert.rejects(review.add('Bad Name', { file: 'src/a.txt', startLine: 1, endLine: 1, body: 'x' }), /Invalid author/);
});

test('the full draft, publish, address and resolve cycle', async () => {
  const { review } = await setUp();
  const draft = await review.add('reviewer', { file: 'src/a.txt', startLine: 3, endLine: 4, body: 'Rename this.' });
  assert.equal(draft.status, 'draft');
  assert.deepEqual(await review.threads('builder'), []);
  await assert.rejects(review.thread('builder', draft.id), /not found/);

  const published = await review.update('human', draft.id, { status: 'open' });
  assert.equal(published.status, 'open');
  assert.equal((await review.threads('builder')).length, 1);

  await assert.rejects(review.update('builder', draft.id, { status: 'resolved' }), /cannot set/);
  const addressed = await review.update('builder', draft.id, { body: 'Done in abc123.', status: 'addressed' });
  assert.equal(addressed.status, 'addressed');

  const resolved = await review.update('reviewer', draft.id, { status: 'resolved' });
  assert.equal(resolved.status, 'resolved');
  assert.deepEqual(
    resolved.comments.map(comment => [comment.author, comment.status ?? null]),
    [['reviewer', 'draft'], ['human', 'open'], ['builder', 'addressed'], ['reviewer', 'resolved']],
  );
});

test('only the human can change a draft', async () => {
  const { review } = await setUp();
  const draft = await review.add('reviewer', { file: 'src/a.txt', startLine: 1, endLine: 1, body: 'x' });
  await assert.rejects(review.update('reviewer', draft.id, { status: 'open' }), /Only the human/);
  await assert.rejects(review.update('human', draft.id, { status: 'resolved' }), /Only the human/);
  await assert.rejects(review.add('reviewer', { file: 'src/a.txt', startLine: 1, endLine: 1, body: 'x', status: 'open' }), /cannot create/);
});

test('a reply does not change the status', async () => {
  const { review } = await setUp();
  const thread = await review.add('human', { file: 'src/a.txt', startLine: 1, endLine: 1, body: 'x' });
  await review.update('human', thread.id, { status: 'resolved' });
  const replied = await review.update('reviewer', thread.id, { body: 'One more thing.' });
  assert.equal(replied.status, 'resolved');
  await assert.rejects(review.update('human', thread.id, { status: 'resolved' }), /already resolved/);
});

test('the human edits a reviewer draft, and others only their own comments', async () => {
  const { review } = await setUp();
  const draft = await review.add('reviewer', { file: 'src/a.txt', startLine: 1, endLine: 1, body: 'Too harsh.' });
  const [comment] = draft.comments;

  const edited = await review.edit('human', draft.id, comment.id, 'Gentler.');
  assert.equal(edited.comments[0].body, 'Gentler.');
  assert.equal(edited.comments[0].editedBy, 'human');
  assert.equal(edited.comments.length, 1);

  await review.update('human', draft.id, { status: 'open' });
  await assert.rejects(review.edit('builder', draft.id, comment.id, 'No.'), /cannot edit/);
  await assert.rejects(review.edit('human', draft.id, comment.id, 'Later.'), /cannot edit/);
});

test('concurrent writers never lose an event', async () => {
  const { review } = await setUp();
  const thread = await review.add('human', { file: 'src/a.txt', startLine: 1, endLine: 1, body: 'x' });
  await Promise.all(Array.from({ length: 50 }, (_, index) => review.update('human', thread.id, { body: `reply ${index}` })));
  const reloaded = await review.thread('human', thread.id);
  assert.equal(reloaded.comments.length, 51);
  assert.equal(readdirSync(review.dir + '/' + thread.id).filter(name => name.startsWith('.')).length, 0);
});

test('reviews are per branch and can be moved', async () => {
  const { root, review } = await setUp();
  await review.add('human', { file: 'src/a.txt', startLine: 1, endLine: 1, body: 'x' });

  run(root, 'checkout', '-q', '-b', 'feature/other');
  const other = await Review.open(root);
  assert.equal(other.repo.branch, 'feature/other');
  assert.deepEqual(await other.threads('human'), []);

  await other.moveFrom('main', 'feature/other');
  assert.equal((await other.threads('human')).length, 1);
  assert.deepEqual(await review.threads('human'), []);
});

test('only the human deletes threads', async () => {
  const { review } = await setUp();
  const thread = await review.add('human', { file: 'src/a.txt', startLine: 1, endLine: 1, body: 'x' });
  await assert.rejects(review.delete('reviewer', thread.id), /Only the human/);
  await review.delete('human', thread.id);
  assert.deepEqual(await review.threads('human'), []);
});
