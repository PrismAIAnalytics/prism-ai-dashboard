#!/usr/bin/env node
// apply-notion-cleanup.js — Phase 2 of T-021. Reads a triage doc produced by
// notion-tickets-inventory.js with K/A/D decisions filled in, then archives
// the marked Notion pages via the API.
//
// Notion has no hard-delete API. Both A (archive) and D (delete) translate to
// `archived: true`. Archived pages stay restorable from the Notion trash for
// 30 days before Notion permanently removes them.
//
// Usage:
//   node scripts/apply-notion-cleanup.js path/to/triage.md
//   node scripts/apply-notion-cleanup.js path/to/triage.md --dry-run
//   node scripts/apply-notion-cleanup.js path/to/triage.md --limit=5
//
// Flags:
//   --dry-run     : parse decisions, print planned actions, make no Notion calls
//   --limit=N     : execute at most N archives (for sample runs)
//   --yes         : skip the 5-second pre-flight pause
//
// Output:
//   - prints a per-row plan to stdout
//   - on real run, writes reports/cleanup-log-YYYY-MM-DD.jsonl with one
//     {page_id, action, before_archived, ok, error, ts} entry per row
//
// Rollback: each line of the JSONL log identifies a page that was archived.
// To restore, replay the log with the inverse archive flag via the Notion API.

'use strict';

const fs = require('fs');
const path = require('path');

// ─── Lightweight .env loader (mirrors notion-tickets-inventory.js) ─────────
try {
  const envFile = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
  for (const line of envFile.split('\n')) {
    const m = line.replace(/\r$/, '').match(/^\s*([^#=]+?)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) {
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  }
} catch (e) { if (e.code !== 'ENOENT') console.warn('[.env]', e.message); }

// ─── Config ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const TRIAGE_PATH = args.find(a => !a.startsWith('--'));
const DRY_RUN = args.includes('--dry-run');
const SKIP_PAUSE = args.includes('--yes');
const LIMIT_FLAG = args.find(a => a.startsWith('--limit='));
const LIMIT = LIMIT_FLAG ? parseInt(LIMIT_FLAG.split('=')[1], 10) : Infinity;

if (!TRIAGE_PATH) {
  console.error('Usage: node scripts/apply-notion-cleanup.js <triage.md> [--dry-run] [--limit=N] [--yes]');
  process.exit(1);
}
if (!fs.existsSync(TRIAGE_PATH)) {
  console.error(`Triage file not found: ${TRIAGE_PATH}`);
  process.exit(1);
}

const NOTION_KEY = process.env.NOTION_API_KEY;
if (!DRY_RUN && !NOTION_KEY) {
  console.error('Missing NOTION_API_KEY (required for real runs; --dry-run does not need it)');
  process.exit(1);
}

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

const today = new Date().toISOString().split('T')[0];
const REPORTS_DIR = path.join(__dirname, '..', 'reports');
const LOG_PATH = path.join(REPORTS_DIR, `cleanup-log-${today}.jsonl`);

// Notion API soft-limit is ~3 req/sec sustained; stay under at 2/sec.
const REQ_INTERVAL_MS = 500;

// ─── Parser ────────────────────────────────────────────────────────────────
// Decision-bearing rows look like one of:
//   | A | PRISM-21 | ... | [open](https://www.notion.so/...-PAGEID32HEX) |
//   | **K** | PRISM-21 | ... | [open](...) |
// where PAGEID32HEX is the 32-hex Notion page ID at the tail of the URL slug.
//
// We extract: decision (K/A/D, case-insensitive, ** wrapping stripped),
// prism id, title (best-effort from the row), and the 32-hex page id.

function parseTriage(text) {
  const lines = text.split('\n');
  const rows = [];
  // Match a 32-hex sequence (Notion page ID without dashes). The URL slug is
  // something like /Some-Title-32hex; we anchor on -<32hex> or /<32hex>.
  const HEX32_RE = /[/-]([0-9a-f]{32})(?:[?)]|$)/i;
  const PRISM_RE = /\bPRISM-(\d+)\b/;

  for (const raw of lines) {
    if (!raw.includes('|')) continue;
    // Skip header/separator rows
    if (/^\s*\|\s*-+/.test(raw)) continue;
    if (/Decision\s*\|/.test(raw)) continue;
    const cells = raw.split('|').map(s => s.trim());
    if (cells.length < 4) continue;
    const decCell = cells[1] || '';
    const dec = decCell.replace(/\*+/g, '').trim().toUpperCase();
    if (!['K', 'A', 'D'].includes(dec)) continue;
    const prismMatch = raw.match(PRISM_RE);
    const hexMatch = raw.match(HEX32_RE);
    if (!hexMatch) continue;
    const rawHex = hexMatch[1];
    const pageId = `${rawHex.slice(0, 8)}-${rawHex.slice(8, 12)}-${rawHex.slice(12, 16)}-${rawHex.slice(16, 20)}-${rawHex.slice(20, 32)}`;
    rows.push({
      decision: dec,
      prismId: prismMatch ? `PRISM-${prismMatch[1]}` : '?',
      pageId,
      rawLine: raw.trim(),
    });
  }
  return rows;
}

// ─── Notion API ────────────────────────────────────────────────────────────
async function fetchPage(pageId) {
  const r = await fetch(`${NOTION_API}/pages/${pageId}`, {
    headers: {
      Authorization: `Bearer ${NOTION_KEY}`,
      'Notion-Version': NOTION_VERSION,
    },
  });
  if (!r.ok) throw new Error(`fetch ${pageId}: ${r.status} ${await r.text().catch(() => '')}`);
  return r.json();
}

async function archivePage(pageId) {
  const r = await fetch(`${NOTION_API}/pages/${pageId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${NOTION_KEY}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ archived: true }),
  });
  if (!r.ok) throw new Error(`archive ${pageId}: ${r.status} ${await r.text().catch(() => '')}`);
  return r.json();
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Main ──────────────────────────────────────────────────────────────────
(async () => {
  const text = fs.readFileSync(TRIAGE_PATH, 'utf8');
  const rows = parseTriage(text);

  const byDec = rows.reduce((acc, r) => { acc[r.decision] = (acc[r.decision] || 0) + 1; return acc; }, {});
  console.log(`\nParsed ${rows.length} decision rows from ${TRIAGE_PATH}`);
  console.log(`  K (keep):    ${byDec.K || 0}`);
  console.log(`  A (archive): ${byDec.A || 0}`);
  console.log(`  D (delete):  ${byDec.D || 0}  (treated as archive — Notion has no hard delete)`);

  const toArchive = rows.filter(r => r.decision === 'A' || r.decision === 'D');
  const plan = toArchive.slice(0, LIMIT);
  if (plan.length < toArchive.length) {
    console.log(`\n--limit=${LIMIT} → executing first ${plan.length} of ${toArchive.length} archives`);
  }

  if (plan.length === 0) {
    console.log('\nNothing to archive. Exiting.');
    return;
  }

  console.log(`\nPlanned actions (${plan.length} pages):`);
  for (const r of plan) {
    console.log(`  ${r.decision.padEnd(2)} ${r.prismId.padEnd(10)} ${r.pageId}`);
  }

  if (DRY_RUN) {
    console.log('\n[DRY RUN] No Notion calls made.');
    return;
  }

  console.log(`\nLog file: ${LOG_PATH}`);
  if (!SKIP_PAUSE) {
    console.log('Starting in 5 seconds — Ctrl-C to abort.');
    await sleep(5000);
  }

  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const logStream = fs.createWriteStream(LOG_PATH, { flags: 'a' });

  let ok = 0, fail = 0;
  for (const r of plan) {
    let beforeArchived = null;
    let error = null;
    try {
      const before = await fetchPage(r.pageId);
      beforeArchived = !!before.archived;
      if (beforeArchived) {
        // Already archived — skip but log
        logStream.write(JSON.stringify({
          ts: new Date().toISOString(),
          page_id: r.pageId,
          prism_id: r.prismId,
          decision: r.decision,
          action: 'skip-already-archived',
          before_archived: true,
          ok: true,
        }) + '\n');
        console.log(`  skip ${r.prismId} (already archived)`);
        ok++;
        continue;
      }
      await archivePage(r.pageId);
      ok++;
      console.log(`  ok   ${r.prismId}`);
    } catch (e) {
      fail++;
      error = e.message;
      console.log(`  FAIL ${r.prismId} — ${e.message}`);
    }
    logStream.write(JSON.stringify({
      ts: new Date().toISOString(),
      page_id: r.pageId,
      prism_id: r.prismId,
      decision: r.decision,
      action: error ? 'error' : 'archived',
      before_archived: beforeArchived,
      ok: !error,
      error,
    }) + '\n');
    await sleep(REQ_INTERVAL_MS);
  }
  logStream.end();

  console.log(`\nDone. ok=${ok} fail=${fail}`);
  console.log(`Log: ${LOG_PATH}`);
  if (fail > 0) process.exit(1);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
