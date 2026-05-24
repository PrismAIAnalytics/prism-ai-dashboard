#!/usr/bin/env node
// snapshot-tickets.js — write a daily ticket-summary snapshot to reports/ (T-038).
//
// Hits /api/tickets/summary on the running dashboard (Railway production by
// default — same instance the cron runs on) and writes the result to
// reports/ticket-snapshot-YYYY-MM-DD.json. Idempotent: same-day re-runs
// overwrite that day's file. Excludes category=dev_insight from byCategory
// breakdown per the T-036c tile rule (those are auto-extracted friction
// signals, not actionable tickets).
//
// Scheduled via Railway scheduler (operational, out-of-band of the repo
// diff): nightly at ~03:00 UTC (≈ 11 PM ET) so the snapshot reflects the
// end-of-day state, not mid-day churn. The 14-day burndown viz in T-050
// (Phase 4) consumes the last 14 daily files.
//
// Usage:
//   node scripts/snapshot-tickets.js                    # live: write today's snapshot
//   node scripts/snapshot-tickets.js --dry-run          # log what would be written, no file
//   node scripts/snapshot-tickets.js --date=YYYY-MM-DD  # override date (backfill)
//   node scripts/snapshot-tickets.js --url=<base>       # override dashboard URL
//
// Env required (loaded from Development/dashboard/.env):
//   API_KEY         — Bearer token for /api/* (same as the rest of the dashboard)
//   DASHBOARD_URL   — optional; defaults to http://localhost:3000 (same Railway instance)
//
// Exit codes:
//   0 — snapshot written (or dry-run completed)
//   1 — fetch failed / file write failed / config missing
//
// Per the leverage brief PRISM-Vault/Admin/Leverage-Briefs/T-038.md.

const fs = require('fs');
const path = require('path');

// ─── .env loader (mirrors sync-briefs.js:43-60) ─────────────────────────────
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

// ─── Config ──────────────────────────────────────────────────────────────────
const DRY_RUN = process.argv.includes('--dry-run');
const DATE_FLAG = process.argv.find(a => a.startsWith('--date='));
const URL_FLAG = process.argv.find(a => a.startsWith('--url='));

const DASHBOARD_URL = (
  URL_FLAG ? URL_FLAG.slice('--url='.length) :
  (process.env.DASHBOARD_URL || 'http://localhost:3000')
).replace(/\/$/, '');

const REPORTS_DIR = path.resolve(path.join(__dirname, '..', 'reports'));
const EXCLUDED_CATEGORIES = new Set(['dev_insight']);

// ─── Date resolution ─────────────────────────────────────────────────────────
function resolveDate() {
  if (DATE_FLAG) {
    const d = DATE_FLAG.slice('--date='.length);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
      throw new Error(`Invalid --date value: ${safeForLog(d)} (expected YYYY-MM-DD)`);
    }
    return d;
  }
  // Single new Date() call — avoids midnight-straddle case
  return new Date().toISOString().slice(0, 10);
}

// ─── Log-injection safety (mirrors sync-briefs.js:448-450) ──────────────────
function safeForLog(s) {
  return String(s).replace(/[\r\n]/g, '\\n');
}

// ─── Filter dev_insight + shape the snapshot payload ────────────────────────
function buildSnapshot(date, summary, sourceHeader) {
  // /api/tickets/summary returns these keys (per server.js): byStatus,
  // byPriority, byType, byCategory, overdue, completedThisWeek, total, open.
  // Some fields may not exist when running against legacy mode.
  const byStatus = Array.isArray(summary.byStatus) ? summary.byStatus : [];
  const byPriority = Array.isArray(summary.byPriority) ? summary.byPriority : [];
  const byType = Array.isArray(summary.byType) ? summary.byType : [];
  const byCategoryRaw = Array.isArray(summary.byCategory) ? summary.byCategory : [];

  // Filter dev_insight from byCategory; also subtract its count from `total`
  // and `open` so the snapshot's headline numbers reflect actionable tickets
  // only. dev_insight count is preserved in a separate field for diagnostic
  // continuity.
  let devInsightTotal = 0;
  const byCategory = [];
  for (const row of byCategoryRaw) {
    const cat = String(row.category || row.name || '').toLowerCase();
    if (EXCLUDED_CATEGORIES.has(cat)) {
      devInsightTotal += Number(row.count || 0);
      continue;
    }
    byCategory.push(row);
  }

  const total = Math.max(0, Number(summary.total || 0) - devInsightTotal);
  const open = Math.max(0, Number(summary.open || 0) - devInsightTotal);

  return {
    schema_version: 1,
    date,
    captured_at: new Date().toISOString(),
    source: sourceHeader || 'unknown',  // notion | sqlite-fallback | unknown
    counts: {
      total,
      open,
      overdue: Number(summary.overdue || 0),
      completed_this_week: Number(summary.completedThisWeek || 0),
    },
    byStatus,
    byPriority,
    byType,
    byCategory,  // dev_insight excluded
    excluded: {
      dev_insight_count: devInsightTotal,
    },
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const date = resolveDate();
  const outPath = path.join(REPORTS_DIR, `ticket-snapshot-${date}.json`);

  console.log(`Mode:           ${DRY_RUN ? 'DRY RUN' : 'WRITE'}`);
  console.log(`Date:           ${safeForLog(date)}`);
  console.log(`Dashboard URL:  ${safeForLog(DASHBOARD_URL)}`);
  console.log(`Output:         ${path.relative(path.join(__dirname, '..'), outPath)}`);
  console.log('');

  // Fail-fast: ensure reports/ exists. The Dockerfile COPY now ships an empty
  // reports/ dir into the image; locally it always exists.
  if (!fs.existsSync(REPORTS_DIR)) {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
    console.log(`Created reports/ directory.`);
  }

  // Fetch
  process.stdout.write('Fetching /api/tickets/summary... ');
  const t0 = Date.now();
  const r = await fetch(`${DASHBOARD_URL}/api/tickets/summary`, {
    headers: { 'Authorization': `Bearer ${process.env.API_KEY || ''}` },
  });
  const elapsed = Date.now() - t0;
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    console.error(`FAILED (${r.status}) ${elapsed}ms`);
    console.error(body.slice(0, 200));
    process.exit(1);
  }
  const sourceHeader = r.headers.get('x-source') || 'unknown';
  const body = await r.json();
  console.log(`OK (${elapsed}ms · X-Source: ${safeForLog(sourceHeader)})`);

  if (!body || body.ok !== true) {
    console.error('Bad summary response:', JSON.stringify(body).slice(0, 200));
    process.exit(1);
  }

  const snapshot = buildSnapshot(date, body, sourceHeader);

  console.log('');
  console.log('Snapshot:');
  console.log(`  total:               ${snapshot.counts.total} (excl. ${snapshot.excluded.dev_insight_count} dev_insight)`);
  console.log(`  open:                ${snapshot.counts.open}`);
  console.log(`  overdue:             ${snapshot.counts.overdue}`);
  console.log(`  completed this week: ${snapshot.counts.completed_this_week}`);
  console.log(`  byStatus:            ${snapshot.byStatus.length} entries`);
  console.log(`  byPriority:          ${snapshot.byPriority.length} entries`);
  console.log(`  byCategory:          ${snapshot.byCategory.length} entries (dev_insight excluded)`);

  // Build the canonical one-liner the brief specifies; emitted last so Railway
  // cron logs always end with a grep-friendly summary regardless of the rest.
  const statusCount = (k) => {
    const row = snapshot.byStatus.find(r => (r.status || r.name) === k);
    return row ? Number(row.count || 0) : 0;
  };
  const summaryLine = [
    `snapshot ${snapshot.date}`,
    `${snapshot.counts.open} open`,
    `${statusCount('in_progress')} in_progress`,
    `${statusCount('review')} review`,
  ];

  if (DRY_RUN) {
    console.log('');
    console.log('[dry-run] No file written.');
    summaryLine.push('dry-run');
    console.log(summaryLine.join(' · '));
    return;
  }

  // Atomic write: write to .tmp then rename. Prevents readers (T-050 burndown
  // viz when it ships) from seeing a partial file.
  const tmpPath = `${outPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpPath, outPath);

  const size = fs.statSync(outPath).size;
  console.log('');
  console.log(`Wrote ${size} bytes to ${path.relative(path.join(__dirname, '..'), outPath)}`);
  summaryLine.push(`written ${size}B`);

  // Phase B (2026-05-24) — write past-due-backlog report for the Daily Agenda
  // panel. Separate file so consumers can read just the rows without parsing
  // the full snapshot. Failure here doesn't fail the summary snapshot job.
  try {
    const pdbCount = await writePastDueBacklog(date);
    summaryLine.push(`past-due-backlog ${pdbCount}`);
  } catch (e) {
    console.error(`[past-due-backlog] WARN: ${e.message}`);
    summaryLine.push(`past-due-backlog FAIL`);
  }

  console.log(summaryLine.join(' · '));
}

// ─── Phase B: past-due Backlog report ───────────────────────────────────────
async function writePastDueBacklog(date) {
  const outPath = path.join(REPORTS_DIR, `past-due-backlog-${date}.json`);
  process.stdout.write('Fetching /api/tickets for past-due Backlog set... ');
  const t0 = Date.now();
  const r = await fetch(`${DASHBOARD_URL}/api/tickets`, {
    headers: { 'Authorization': `Bearer ${process.env.API_KEY || ''}` },
  });
  const elapsed = Date.now() - t0;
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`fetch failed (${r.status}) ${elapsed}ms: ${body.slice(0, 200)}`);
  }
  const j = await r.json();
  if (!j || j.ok !== true || !Array.isArray(j.tickets)) {
    throw new Error('bad tickets response: ' + JSON.stringify(j).slice(0, 200));
  }
  console.log(`OK (${elapsed}ms, ${j.tickets.length} tickets)`);

  const today = date; // 'YYYY-MM-DD'
  const PRIO_ORDER = { urgent: 0, high: 1, medium: 2, low: 3 };
  const rows = j.tickets
    .filter(t => t.status === 'backlog' && t.due_date && t.due_date < today && t.category !== 'dev_insight')
    .map(t => ({
      ticket_key:     t.ticket_key,
      title:          t.title,
      due_date:       t.due_date,
      days_overdue:   Math.max(0, Math.floor((Date.parse(today) - Date.parse(t.due_date)) / 86400000)),
      priority:       t.priority || 'medium',
      notion_page_id: t.notion_page_id || null,
      ticket_id:      t.id,
    }))
    .sort((a, b) => {
      const pa = PRIO_ORDER[a.priority] ?? 9;
      const pb = PRIO_ORDER[b.priority] ?? 9;
      if (pa !== pb) return pa - pb;
      return b.days_overdue - a.days_overdue; // older overdue first within priority
    });

  const report = {
    schema_version: 1,
    date,
    captured_at: new Date().toISOString(),
    count: rows.length,
    tickets: rows,
  };

  if (DRY_RUN) {
    console.log(`  past-due Backlog: ${rows.length} ticket${rows.length === 1 ? '' : 's'} (dry-run, no file written)`);
    return rows.length;
  }

  const tmp = `${outPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(report, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, outPath);
  const size = fs.statSync(outPath).size;
  console.log(`  Wrote ${size}B past-due-backlog (${rows.length} tickets) to ${path.relative(path.join(__dirname, '..'), outPath)}`);
  return rows.length;
}

main().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
