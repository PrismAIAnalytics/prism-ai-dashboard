#!/usr/bin/env node
// close-merged-task.js — release the WIP=1 lock at merge time (T-094).
//
// WHAT THIS FIXES
// ───────────────
// The WIP=1 lock is the single "In Progress" row in TASKS.md (WORKFLOW.md §3).
// A task claims the lock inside its feature PR, but the close-out edit (move
// the row to "Done This Week" WITH the squash SHA) can't ship in that same PR
// because the squash SHA doesn't exist until AFTER merge. WORKFLOW.md §4's
// workaround — "bundle the close-out into the next task's first commit" — leaves
// `main` carrying a STALE In Progress row whenever there's no next task soon.
// This has recurred at least 4× (T-059, T-088, T-090, T-093).
//
// This script performs the post-merge transform: it moves the single In Progress
// row to the top of Done This Week with the merge metadata, and restores the
// `_(none)_` placeholder. It is invoked by .github/workflows/post-merge-closeout.yml
// (which opens an auto close-out PR — it never pushes to protected main), and is
// also runnable locally as a manual fallback:
//
//   node scripts/close-merged-task.js --pr=79 --sha=5310832 --date=2026-05-30
//   node scripts/close-merged-task.js --dry-run                 # print plan, no write
//   node scripts/close-merged-task.js --expect-branch=task/foo  # cross-check before closing
//
// ⚠️  DOES NOT — and MUST NOT — call scripts/sync-tasks.js. T-091 flags that
//     script DO-NOT-RUN-LIVE (notion-only mass-create risk) until it ships.
//     This script edits the TASKS.md markdown file ONLY. The dashboard + Notion
//     mirrors stay untouched; they are reconciled separately once T-091 lands.
//
// Pure-core design (mirrors scripts/sync-tasks.js): closeMergedTask() is a pure
// string→string transform with no I/O, unit-tested in test/closeMergedTask.test.js.
// The CLI wrapper at the bottom is the only part that touches the filesystem.

'use strict';

const fs = require('fs');
const path = require('path');

const SECTION_IN_PROGRESS = 'In Progress';
const SECTION_DONE = 'Done This Week';
const TID_RE = /^T-\d+[a-z]?$/;
// Matches the canonical empty In Progress row used throughout TASKS.md history.
const PLACEHOLDER_ROW = '| _(none)_ | | | | |';

// ─── Markdown helpers ────────────────────────────────────────────────────────
function splitCells(line) {
  // "| a | b | c |" → ['a','b','c']
  return line.split('|').slice(1, -1).map((c) => c.trim());
}

function escapeCell(value) {
  // Keep inserted text from breaking the table: escape pipes, flatten newlines.
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

// Locate a section's markdown table: returns the separator-row index and the
// data rows (with their absolute line indices) that follow it, stopping at the
// first non-table line / next heading / `---` rule.
function findSectionTable(lines, sectionTitle) {
  let headingIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^##\s+(.*)$/);
    if (m) {
      const title = m[1].trim();
      if (title === sectionTitle || title.startsWith(sectionTitle + ' ')) {
        headingIdx = i;
        break;
      }
    }
  }
  if (headingIdx === -1) return null;

  let sepIdx = -1;
  for (let j = headingIdx + 1; j < lines.length; j++) {
    if (/^##\s/.test(lines[j]) || lines[j].trim() === '---') break; // left the section
    if (/^\|[\s\-:|]+\|$/.test(lines[j].trim())) { sepIdx = j; break; }
  }
  if (sepIdx === -1) return null;

  const dataRows = [];
  for (let j = sepIdx + 1; j < lines.length; j++) {
    if (!lines[j].trim().startsWith('|')) break;
    dataRows.push({ idx: j, cells: splitCells(lines[j]) });
  }
  return { headingIdx, sepIdx, dataRows };
}

// ─── Pure core ───────────────────────────────────────────────────────────────
// Returns one of:
//   { result: 'closed', tid, title, newContent, doneRow, warnings }
//   { result: 'noop-empty' }            In Progress holds no T-row (lock free)
//   { result: 'noop-multiple', tids }   >1 row = WIP=1 violation; refuse to guess
//   { result: 'noop-mismatch', ... }    branch cross-check failed; refuse to guess
//   { result: 'error', message }        TASKS.md shape unexpected (sections missing)
//
// `expectBranch` (the merged PR's head ref) is the safety cross-check: under
// WIP=1 the In Progress row's Branch cell must equal the branch that just
// merged. A mismatch means the merge was something else (e.g. a "no ticket"
// override PR while a real task still holds the lock) — so we DON'T close it.
function closeMergedTask({ tasksMd, expectBranch = null, expectTid = null, pr = null, sha = null, date, note = null }) {
  if (!date) return { result: 'error', message: 'date is required (YYYY-MM-DD)' };

  // Split into \r-free lines but remember the original EOL so write-back
  // preserves it (TASKS.md is CRLF on Windows — joining with '\n' would
  // rewrite every line and blow up the diff). The regexes below rely on lines
  // having no trailing \r, or '$' won't anchor after a heading on CRLF files.
  const eol = tasksMd.includes('\r\n') ? '\r\n' : '\n';
  const lines = tasksMd.split(/\r?\n/);
  const ip = findSectionTable(lines, SECTION_IN_PROGRESS);
  if (!ip) return { result: 'error', message: `"${SECTION_IN_PROGRESS}" section/table not found` };

  const tRows = ip.dataRows.filter((r) => TID_RE.test(r.cells[0] || ''));
  if (tRows.length === 0) return { result: 'noop-empty', tid: null, newContent: tasksMd, warnings: [] };
  if (tRows.length > 1) {
    return {
      result: 'noop-multiple',
      tids: tRows.map((r) => r.cells[0]),
      newContent: tasksMd,
      warnings: [`WIP=1 violation: ${tRows.length} In Progress rows (${tRows.map((r) => r.cells[0]).join(', ')}); refusing to guess which to close.`],
    };
  }

  const row = tRows[0];
  const tid = row.cells[0];
  const title = row.cells[1] || '';
  const rowBranch = (row.cells[2] || '').trim();

  if (expectTid && expectTid !== tid) {
    return {
      result: 'noop-mismatch',
      tid, expectTid, newContent: tasksMd,
      warnings: [`In Progress row is ${tid} but caller expected ${expectTid}; refusing to close.`],
    };
  }
  if (expectBranch) {
    if (!rowBranch || rowBranch !== expectBranch.trim()) {
      return {
        result: 'noop-mismatch',
        tid, rowBranch, expectBranch, newContent: tasksMd,
        warnings: [`In Progress row ${tid} branch "${rowBranch}" != merged PR branch "${expectBranch}"; refusing to close (possible no-ticket / override merge while a task holds the lock).`],
      };
    }
  }

  const done = findSectionTable(lines, SECTION_DONE);
  if (!done) return { result: 'error', message: `"${SECTION_DONE}" section/table not found` };

  // Build the Done This Week note.
  const parts = [];
  const prSha = `${pr ? 'PR #' + pr : 'PR'}${sha ? ' as `' + escapeCell(sha) + '`' : ''}`;
  parts.push(`Auto-closed by the post-merge close-out Action (T-094): merged via ${prSha} (squash) on ${escapeCell(date)}.`);
  parts.push('In Progress row cleared at merge time — closes the recurring WIP=1 close-out gap (see T-059 / T-088 / T-090 / T-093).');
  parts.push('`sync-tasks.js` NOT run (T-091 DO-NOT-RUN-LIVE).');
  if (note) parts.push(escapeCell(note));
  const noteText = parts.join(' ');

  const doneRow = `| ${escapeCell(tid)} | ${escapeCell(title)} | ${escapeCell(date)} | ${noteText} |`;

  // In-place replace the In Progress row (no index shift), then splice the new
  // Done row in after Done's separator. IP section precedes Done in the file, so
  // done.sepIdx stays valid after the in-place replacement above.
  const newLines = lines.slice();
  newLines[row.idx] = PLACEHOLDER_ROW;
  newLines.splice(done.sepIdx + 1, 0, doneRow);

  return { result: 'closed', tid, title, newContent: newLines.join(eol), doneRow, warnings: [] };
}

// ─── CLI wrapper (only part that does I/O) ─────────────────────────────────────
function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

function emitGithubOutput(key, value) {
  const f = process.env.GITHUB_OUTPUT;
  if (!f) return;
  try { fs.appendFileSync(f, `${key}=${value}\n`); } catch { /* non-fatal */ }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = Boolean(args['dry-run'] || args.check);
  const tasksPath = path.join(__dirname, '..', 'TASKS.md');

  const date = args.date || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error(`::error::--date must be YYYY-MM-DD (got "${date}")`);
    process.exit(1);
  }

  const tasksMd = fs.readFileSync(tasksPath, 'utf8');
  const res = closeMergedTask({
    tasksMd,
    expectBranch: typeof args['expect-branch'] === 'string' ? args['expect-branch'] : null,
    expectTid: typeof args['expect-tid'] === 'string' ? args['expect-tid'] : null,
    pr: typeof args.pr === 'string' ? args.pr : null,
    sha: typeof args.sha === 'string' ? args.sha : null,
    date,
    note: typeof args.note === 'string' ? args.note : null,
  });

  for (const w of res.warnings || []) console.warn(`::warning::${w}`);

  if (res.result === 'error') {
    console.error(`::error::${res.message}`);
    process.exit(1);
  }

  if (res.result === 'closed') {
    if (dryRun) {
      console.log(`[dry-run] would close ${res.tid} and append to Done This Week:`);
      console.log(`  ${res.doneRow}`);
    } else {
      fs.writeFileSync(tasksPath, res.newContent);
      console.log(`Closed ${res.tid}: moved In Progress → Done This Week.`);
    }
  } else {
    console.log(`No-op (${res.result})${res.tid ? ' for ' + res.tid : ''}: lock left unchanged.`);
  }

  emitGithubOutput('closed', res.result === 'closed' && !dryRun ? 'true' : 'false');
  emitGithubOutput('tid', res.tid || '');
  console.log(`RESULT: ${res.result}${res.tid ? ' ' + res.tid : ''}`);
}

if (require.main === module) main();

module.exports = { closeMergedTask, findSectionTable, splitCells, escapeCell, PLACEHOLDER_ROW };
