// closeMergedTask.test.js — T-094
//
// Locks the post-merge close-out transform that releases the WIP=1 lock at
// merge time. The bug this prevents: a stale In Progress row carried on `main`
// after a feature PR squash-merges, because the close-out couldn't be bundled
// into the same PR (the squash SHA doesn't exist until after merge). Recurred
// 4× (T-059 / T-088 / T-090 / T-093) before this Action existed.
//
// Pure unit tests over closeMergedTask() — no filesystem, no git, no network.
// Run with `npm test`.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { closeMergedTask } = require('../scripts/close-merged-task');

// Minimal, realistic TASKS.md skeleton: an In Progress table with one claimed
// row and a Done This Week table with one prior row. Mirrors the real file's
// 5-column In Progress / 4-column Done shapes.
function fixture({ inProgressRow } = {}) {
  const ip = inProgressRow === undefined
    ? '| T-094 | Post-merge close-out Action | chore/post-merge-closeout-action | Claude Code | 2026-05-30 |'
    : inProgressRow;
  return [
    '# TASKS.md',
    '',
    '---',
    '',
    '## In Progress',
    '',
    '| Task ID | Title | Branch | Owner | Started |',
    '|---------|-------|--------|-------|---------|',
    ip,
    '',
    '---',
    '',
    '## Up Next (priority order)',
    '',
    '| ID | Title | Why it matters | Owner candidate |',
    '|----|-------|----------------|-----------------|',
    '| T-022 | Some upcoming task | because | Claude Code |',
    '',
    '---',
    '',
    '## Done This Week',
    '',
    '| ID | Title | Closed | Notes |',
    '|----|-------|--------|-------|',
    '| T-093 | Brand-pass diagram | 2026-05-30 | Merged via PR #79 as `5310832` (squash). |',
    '',
    '---',
    '',
    '## Conventions',
    '',
    '- **WIP = 1.**',
    '',
  ].join('\n');
}

const EMPTY_ROW = '| _(none)_ | | | | |';

// ─── Happy path ──────────────────────────────────────────────────────────────

test('closes the single In Progress row and clears the lock to the placeholder', () => {
  const res = closeMergedTask({ tasksMd: fixture(), pr: '95', sha: 'abc1234', date: '2026-05-31' });
  assert.strictEqual(res.result, 'closed');
  assert.strictEqual(res.tid, 'T-094');

  const lines = res.newContent.split('\n');
  // In Progress now holds the placeholder, not the T-094 row.
  assert.ok(lines.includes(EMPTY_ROW), 'In Progress placeholder restored');
  assert.ok(!res.newContent.includes('| T-094 | Post-merge close-out Action | chore/post-merge-closeout-action'),
    'old In Progress row removed');
});

test('new Done row carries tid, title, date, PR number and squash SHA', () => {
  const res = closeMergedTask({ tasksMd: fixture(), pr: '95', sha: 'abc1234', date: '2026-05-31' });
  assert.match(res.doneRow, /^\| T-094 \| Post-merge close-out Action \| 2026-05-31 \|/);
  assert.match(res.doneRow, /PR #95 as `abc1234` \(squash\)/);
  assert.match(res.doneRow, /sync-tasks\.js` NOT run \(T-091 DO-NOT-RUN-LIVE\)/);
});

test('new Done row is inserted at the TOP of Done This Week (newest-first)', () => {
  const res = closeMergedTask({ tasksMd: fixture(), pr: '95', sha: 'abc1234', date: '2026-05-31' });
  const lines = res.newContent.split('\n');
  const newIdx = lines.findIndex((l) => l.startsWith('| T-094 |') && l.includes('2026-05-31'));
  const priorIdx = lines.findIndex((l) => l.startsWith('| T-093 |'));
  assert.ok(newIdx !== -1 && priorIdx !== -1);
  assert.ok(newIdx < priorIdx, 'T-094 row precedes the prior T-093 row');
});

test('does not disturb unrelated sections (Up Next / Conventions preserved)', () => {
  const res = closeMergedTask({ tasksMd: fixture(), pr: '95', sha: 'abc1234', date: '2026-05-31' });
  assert.ok(res.newContent.includes('| T-022 | Some upcoming task | because | Claude Code |'));
  assert.ok(res.newContent.includes('- **WIP = 1.**'));
});

// ─── Branch cross-check (the no-ticket-override safety) ────────────────────────

test('closes when expect-branch matches the In Progress row Branch cell', () => {
  const res = closeMergedTask({
    tasksMd: fixture(), expectBranch: 'chore/post-merge-closeout-action',
    pr: '95', sha: 'abc1234', date: '2026-05-31',
  });
  assert.strictEqual(res.result, 'closed');
});

test('refuses to close when expect-branch does NOT match (no-ticket/override merge)', () => {
  const res = closeMergedTask({
    tasksMd: fixture(), expectBranch: 'fix/some-unrelated-hotfix',
    pr: '96', sha: 'def5678', date: '2026-05-31',
  });
  assert.strictEqual(res.result, 'noop-mismatch');
  assert.strictEqual(res.newContent, fixture(), 'TASKS.md left byte-for-byte unchanged');
  assert.ok(res.warnings.length > 0);
});

test('refuses to close on expect-tid mismatch', () => {
  const res = closeMergedTask({ tasksMd: fixture(), expectTid: 'T-999', date: '2026-05-31' });
  assert.strictEqual(res.result, 'noop-mismatch');
});

// ─── Fail-safe no-ops ──────────────────────────────────────────────────────────

test('no-op when In Progress holds the empty placeholder (lock already free)', () => {
  const res = closeMergedTask({ tasksMd: fixture({ inProgressRow: EMPTY_ROW }), pr: '95', sha: 'abc', date: '2026-05-31' });
  assert.strictEqual(res.result, 'noop-empty');
  assert.strictEqual(res.newContent, fixture({ inProgressRow: EMPTY_ROW }));
});

test('no-op (refuse to guess) when In Progress holds more than one T-row', () => {
  const two = [
    '| T-094 | First | task/a | Claude Code | 2026-05-30 |',
    '| T-095 | Second | task/b | Claude Code | 2026-05-30 |',
  ].join('\n');
  const res = closeMergedTask({ tasksMd: fixture({ inProgressRow: two }), date: '2026-05-31' });
  assert.strictEqual(res.result, 'noop-multiple');
  assert.deepStrictEqual(res.tids, ['T-094', 'T-095']);
});

// ─── Idempotency / re-run safety ───────────────────────────────────────────────

test('running twice is safe — second pass is a clean no-op (loop guard backstop)', () => {
  const first = closeMergedTask({ tasksMd: fixture(), pr: '95', sha: 'abc1234', date: '2026-05-31' });
  assert.strictEqual(first.result, 'closed');
  const second = closeMergedTask({ tasksMd: first.newContent, pr: '95', sha: 'abc1234', date: '2026-05-31' });
  assert.strictEqual(second.result, 'noop-empty');
  assert.strictEqual(second.newContent, first.newContent);
});

// ─── Input hardening ───────────────────────────────────────────────────────────

test('errors when date is missing', () => {
  const res = closeMergedTask({ tasksMd: fixture() });
  assert.strictEqual(res.result, 'error');
});

test('escapes pipes in title so the Done table stays well-formed', () => {
  const piped = '| T-094 | Title with \\| pipe | task/x | Claude Code | 2026-05-30 |';
  const res = closeMergedTask({ tasksMd: fixture({ inProgressRow: piped }), pr: '95', sha: 'abc', date: '2026-05-31' });
  assert.strictEqual(res.result, 'closed');
  // The inserted Done row must have exactly 4 cells (pipe in title escaped, not splitting).
  const cells = res.doneRow.split('|').slice(1, -1);
  assert.strictEqual(cells.length, 4, `expected 4 cells, got ${cells.length}: ${res.doneRow}`);
});
