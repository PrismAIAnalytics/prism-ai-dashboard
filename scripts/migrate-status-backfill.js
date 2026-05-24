#!/usr/bin/env node
// migrate-status-backfill.js — one-time reclassification of legacy `Not started`
// tickets in the Notion Tickets DB into Backlog or To Do per Phase 2D close-out.
//
// Phase 2D added three new Status options (Backlog, To Do, Review) on 2026-05-24,
// closing the gap where the dashboard's 5-column Kanban couldn't round-trip
// through Notion's 4-option schema. Until this script runs, every legacy ticket
// looks like `Not started` in Notion — indistinguishable from a fresh proposal.
//
// Classification rules (in order):
//   0a. Dashboard mirror has status='done' OR completed_date set → SKIP
//       (already done, just never marked Done in Notion — bulk-promotion
//       would dump these into To Do as noise. Cross-references local
//       prism.db via notion_page_id. If prism.db is missing, this rule is
//       skipped with a warning — the script falls back to date-only logic.)
//   0b. Source = "TASKS.md" OR T-ID set (T-###) → SKIP
//       (engineering tickets owned by sync-tasks.js — don't double-write).
//       Dashboard Ticket ID alone is NOT a skip signal — almost every legacy
//       ticket has one from notion-sync.js back-references.
//   1. Source matches /^cowork:approved-/ → To Do
//      (explicit approval signal in the source tag)
//   2. due_date in the future → Backlog
//      (proposals, not yet actionable)
//   3. due_date past by ≤14 days → To Do
//      (actionable overdue work, recent enough to still be live)
//   4. due_date past by >14 days → Backlog
//      (likely shipped-but-not-closed or stale; hold for manual triage
//       in the Phase B "Past-due in Backlog" panel)
//   5. no due_date, no approval signal → Backlog
//      (still a proposal awaiting approval)
//
// Usage:
//   node scripts/migrate-status-backfill.js              # dry-run, cap 50
//   node scripts/migrate-status-backfill.js --apply      # actually write
//   node scripts/migrate-status-backfill.js --cap 200    # higher cap
//   node scripts/migrate-status-backfill.js --apply --cap 25
//
// Env required: NOTION_API_KEY (and NOTION_TICKETS_DB_ID, defaults to canonical).
// Loaded from Development/dashboard/.env (same loader as sync-tasks.js).
//
// Output: reports/status-backfill-YYYY-MM-DD.json with before/after per ticket.
//
// Safety:
//   - dry-run by default — no writes happen without --apply
//   - per-batch cap (default 50) to bound blast radius per run
//   - 400ms delay between PATCH calls to stay under Notion's ~3 req/sec ceiling
//   - script exits non-zero on any PATCH failure so callers can detect partial state

'use strict';

const fs = require('fs');
const path = require('path');

// Optional require — script still works without better-sqlite3 (Rule 0a falls
// back to a warning) so it can run in environments without the dashboard's
// native build chain.
let Database = null;
try { Database = require('better-sqlite3'); } catch { /* handled at runtime */ }

// ─── Lightweight .env loader (mirrors sync-tasks.js) ───────────────────────
try {
  const envPath = path.join(__dirname, '..', '.env');
  const envFile = fs.readFileSync(envPath, 'utf8');
  for (const line of envFile.split('\n')) {
    const trimmed = line.replace(/\r$/, '');
    const m = trimmed.match(/^\s*([^#=]+?)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) {
      let val = m[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      process.env[m[1]] = val;
    }
  }
} catch (e) {
  if (e.code !== 'ENOENT') console.warn('[.env] Failed to load:', e.message);
}

// ─── Config ────────────────────────────────────────────────────────────────
const APPLY = process.argv.includes('--apply');
// Accept both --cap=200 and --cap 200 forms.
function parseCap() {
  const args = process.argv;
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--cap=')) return parseInt(args[i].split('=')[1], 10);
    if (args[i] === '--cap' && i + 1 < args.length) return parseInt(args[i + 1], 10);
  }
  return 50;
}
const CAP = parseCap();
const RATE_LIMIT_DELAY_MS = 400;

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

// Past-due tickets older than this fall into "likely shipped-but-not-closed
// or stale" and get held in Backlog rather than promoted to To Do.
const RECENT_OVERDUE_DAYS = 14;

const PRISM_DB_PATH = path.join(__dirname, '..', 'prism.db');
const DB_ID = process.env.NOTION_TICKETS_DB_ID || 'b3b42787-e56b-4807-afcc-ee172df50cb9';
const API_KEY = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN;

if (!API_KEY) {
  console.error('FATAL: NOTION_API_KEY (or NOTION_TOKEN) not set. Add it to Development/dashboard/.env or your shell env.');
  process.exit(1);
}
if (!Number.isFinite(CAP) || CAP <= 0) {
  console.error(`FATAL: --cap must be a positive integer (got ${CAP_FLAG || '50'})`);
  process.exit(1);
}

// ─── Notion API helpers ────────────────────────────────────────────────────
async function notionFetch(p, opts = {}) {
  const r = await fetch(`${NOTION_API}${p}`, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    const err = new Error(`Notion ${opts.method || 'GET'} ${p}: ${r.status} ${body.slice(0, 300)}`);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

// Fetch every page in the Tickets DB whose Status is "Not started".
async function fetchNotStartedPages() {
  const pages = [];
  let cursor = null;
  do {
    const body = {
      filter: { property: 'Status', status: { equals: 'Not started' } },
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    };
    const resp = await notionFetch(`/databases/${DB_ID}/query`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    pages.push(...(resp.results || []));
    cursor = resp.has_more ? resp.next_cursor : null;
  } while (cursor);
  return pages;
}

function readProp(props, key, type) {
  const p = props[key];
  if (!p) return null;
  switch (type) {
    case 'title':     return p.title?.[0]?.plain_text || '';
    case 'rich_text': return p.rich_text?.[0]?.plain_text || '';
    case 'date':      return p.date?.start || null;
    case 'status':    return p.status?.name || null;
    case 'select':    return p.select?.name || null;
    default:          return null;
  }
}

function todayIso() {
  return new Date().toISOString().split('T')[0];
}

// Load dashboard-side "already done" set keyed by notion_page_id. Returns a
// Map<notion_page_id, { status, completed_date, ticket_key }> for fast lookup.
// Empty map if prism.db is missing or unreadable — caller falls back to
// date-only logic with a warning.
function loadDashboardDoneSet() {
  if (!Database) {
    console.warn('[backfill] better-sqlite3 not available — skipping dashboard cross-reference (Rule 0a disabled).');
    return new Map();
  }
  if (!fs.existsSync(PRISM_DB_PATH)) {
    console.warn(`[backfill] ${PRISM_DB_PATH} not found — skipping dashboard cross-reference (Rule 0a disabled).`);
    return new Map();
  }
  try {
    const db = new Database(PRISM_DB_PATH, { readonly: true, fileMustExist: true });
    const rows = db.prepare(
      `SELECT notion_page_id, status, completed_date, ticket_key
       FROM tickets
       WHERE notion_page_id IS NOT NULL
         AND (status = 'done' OR completed_date IS NOT NULL)`
    ).all();
    db.close();
    const m = new Map();
    for (const r of rows) m.set(r.notion_page_id, r);
    return m;
  } catch (err) {
    console.warn(`[backfill] prism.db read failed (${err.message}) — Rule 0a disabled.`);
    return new Map();
  }
}

// ─── Classification ────────────────────────────────────────────────────────
function classify({ dueDate, source, tId, dashboardDone }, today) {
  // Rule 0a: dashboard mirror says it's done
  if (dashboardDone) {
    const tail = dashboardDone.ticket_key ? ` (${dashboardDone.ticket_key})` : '';
    return { status: null, reason: `dashboard mirror status=${dashboardDone.status}${dashboardDone.completed_date ? `, completed ${dashboardDone.completed_date}` : ''}${tail} — shipped but Notion never updated` };
  }

  // Rule 0b: skip engineering tickets owned by sync-tasks.js
  if (source === 'TASKS.md' || (tId && /^T-\d/.test(tId))) {
    return { status: null, reason: 'engineering ticket (TASKS.md / T-### owned by sync-tasks.js)' };
  }

  // Rule 1: explicit approval signal
  if (source && /^cowork:approved-/.test(source)) {
    return { status: 'To Do', reason: `source matches approved pattern (${source})` };
  }

  // Rule 2-4: due date-based classification
  if (dueDate) {
    const dueMs = Date.parse(dueDate);
    const todayMs = Date.parse(today);
    const daysOverdue = Math.floor((todayMs - dueMs) / 86400000);
    if (daysOverdue < 0) {
      return { status: 'Backlog', reason: `due ${dueDate} in future — proposal, not yet actionable` };
    }
    if (daysOverdue <= RECENT_OVERDUE_DAYS) {
      return { status: 'To Do', reason: `${daysOverdue}d overdue (≤${RECENT_OVERDUE_DAYS}d window) — actionable` };
    }
    return { status: 'Backlog', reason: `${daysOverdue}d overdue (>${RECENT_OVERDUE_DAYS}d) — likely shipped-not-closed or stale; hold for manual triage` };
  }

  // Rule 5: no signal
  return { status: 'Backlog', reason: 'no due date, no approval signal — proposal' };
}

// ─── Apply path ────────────────────────────────────────────────────────────
async function patchStatus(pageId, newStatus) {
  return notionFetch(`/pages/${pageId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      properties: { Status: { status: { name: newStatus } } },
    }),
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const today = todayIso();
  console.log(`Mode:      ${APPLY ? 'APPLY (writes will happen)' : 'DRY RUN (no writes)'}`);
  console.log(`DB:        ${DB_ID}`);
  console.log(`Cap:       ${CAP} ticket${CAP === 1 ? '' : 's'} per run`);
  console.log(`Today:     ${today}`);
  console.log('');

  console.log('Loading dashboard "already done" set from prism.db ...');
  const dashboardDoneByPage = loadDashboardDoneSet();
  console.log(`Found ${dashboardDoneByPage.size} dashboard tickets already marked done/completed.\n`);

  console.log('Fetching every Notion ticket with Status = "Not started" ...');
  const pages = await fetchNotStartedPages();
  console.log(`Found ${pages.length} legacy Not-started ticket${pages.length === 1 ? '' : 's'}.\n`);

  const allDecisions = pages.map(page => {
    const props = page.properties || {};
    const title = readProp(props, 'Ticket', 'title') || '(untitled)';
    const dueDate = readProp(props, 'Due Date', 'date');
    const source = readProp(props, 'Source', 'rich_text');
    const priority = readProp(props, 'Priority', 'select');
    const tId = readProp(props, 'T-ID', 'rich_text');
    const dashboardTicketId = readProp(props, 'Dashboard Ticket ID', 'rich_text');
    const dashboardDone = dashboardDoneByPage.get(page.id);
    const decision = classify({ dueDate, source, tId, dashboardDone }, today);
    return {
      pageId: page.id,
      title: title.slice(0, 80),
      from: 'Not started',
      to: decision.status,
      reason: decision.reason,
      dueDate,
      source,
      priority,
      tId,
      dashboardTicketId,
      url: page.url,
    };
  });

  // Partition: skipped (Rule 0) vs actionable
  const skipped = allDecisions.filter(d => d.to === null);
  const decisions = allDecisions.filter(d => d.to !== null);

  if (skipped.length > 0) {
    const byReason = { dashboardDone: 0, engineering: 0 };
    for (const s of skipped) {
      if (s.reason.startsWith('dashboard mirror')) byReason.dashboardDone++;
      else if (s.reason.startsWith('engineering')) byReason.engineering++;
    }
    console.log(`Skipped ${skipped.length} ticket${skipped.length === 1 ? '' : 's'}:`);
    if (byReason.dashboardDone > 0) console.log(`  ${byReason.dashboardDone} already done in dashboard (Rule 0a)`);
    if (byReason.engineering > 0) console.log(`  ${byReason.engineering} engineering tickets owned by sync-tasks.js (Rule 0b)`);
    console.log('');
  }

  // Sort: To Do candidates first (more urgent), then by priority then by title.
  const priorityOrder = { Urgent: 0, High: 1, Medium: 2, Low: 3 };
  decisions.sort((a, b) => {
    if (a.to !== b.to) return a.to === 'To Do' ? -1 : 1;
    const pa = priorityOrder[a.priority] ?? 99;
    const pb = priorityOrder[b.priority] ?? 99;
    if (pa !== pb) return pa - pb;
    return a.title.localeCompare(b.title);
  });

  const inThisRun = decisions.slice(0, CAP);
  const deferred = decisions.slice(CAP);

  const summary = {
    total_fetched: allDecisions.length,
    skipped_engineering: skipped.length,
    actionable: decisions.length,
    inThisRun: inThisRun.length,
    deferred: deferred.length,
    by_target: {
      'To Do': decisions.filter(d => d.to === 'To Do').length,
      'Backlog': decisions.filter(d => d.to === 'Backlog').length,
    },
  };

  console.log('Classification summary:');
  console.log(`  ${summary.by_target['To Do']} → To Do`);
  console.log(`  ${summary.by_target['Backlog']} → Backlog`);
  if (deferred.length > 0) {
    console.log(`  (${deferred.length} deferred to next run — exceeds --cap ${CAP})`);
  }
  console.log('');

  console.log('Top of in-this-run set (first 10):');
  for (const d of inThisRun.slice(0, 10)) {
    console.log(`  [${d.to}] ${d.title} (${d.priority || 'no priority'}) — ${d.reason}`);
  }
  console.log('');

  // Apply path
  const results = [];
  if (APPLY) {
    console.log(`Applying ${inThisRun.length} status changes with ${RATE_LIMIT_DELAY_MS}ms delay between calls ...`);
    for (let i = 0; i < inThisRun.length; i++) {
      const d = inThisRun[i];
      try {
        await patchStatus(d.pageId, d.to);
        results.push({ ...d, applied: true, error: null });
        process.stdout.write(`  [${i + 1}/${inThisRun.length}] ${d.title.slice(0, 60)} → ${d.to} ✓\n`);
      } catch (err) {
        results.push({ ...d, applied: false, error: err.message });
        process.stderr.write(`  [${i + 1}/${inThisRun.length}] ${d.title.slice(0, 60)} → ${d.to} ✗ ${err.message}\n`);
      }
      if (i < inThisRun.length - 1) await sleep(RATE_LIMIT_DELAY_MS);
    }
    const failed = results.filter(r => !r.applied).length;
    console.log(`\nApply done — ${results.length - failed} applied, ${failed} failed.`);
  } else {
    for (const d of inThisRun) results.push({ ...d, applied: false, error: null });
  }

  // Write report
  const reportsDir = path.join(__dirname, '..', 'reports');
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
  const reportPath = path.join(reportsDir, `status-backfill-${today}.json`);
  const report = {
    generated_at: new Date().toISOString(),
    mode: APPLY ? 'apply' : 'dry-run',
    cap: CAP,
    today,
    summary,
    in_this_run: results,
    deferred: deferred.map(d => ({ pageId: d.pageId, title: d.title, to: d.to, reason: d.reason })),
    skipped: skipped.map(d => ({ pageId: d.pageId, title: d.title, reason: d.reason })),
  };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nReport written: ${path.relative(process.cwd(), reportPath)}`);

  // Exit non-zero on apply failures so CI / wrappers can detect
  if (APPLY) {
    const failed = results.filter(r => !r.applied).length;
    if (failed > 0) process.exit(1);
  }
}

main().catch(e => {
  console.error('FATAL:', e.message);
  if (e.stack) console.error(e.stack);
  process.exit(1);
});
