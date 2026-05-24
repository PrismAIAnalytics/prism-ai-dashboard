#!/usr/bin/env node
// backfill-comments-to-notion.js — T-027b. One-time migration of SQLite
// `ticket_comments` rows into Notion page comments.
//
// Each SQLite comment is posted as a page-level Notion comment on the
// corresponding ticket page. Author is preserved via the body prefix
// "[<author>] <text>" — see composeCommentBody in services/notionAdapter.js.
//
// Idempotency: writes a JSONL log per run to reports/backfill-comments-log-
// YYYY-MM-DD.jsonl. Subsequent runs read all such logs in reports/ and skip
// SQLite comment IDs already migrated. Re-running after a partial failure
// resumes where it left off rather than duplicating.
//
// Orphans (SQLite tickets with no notion_page_id) are logged as warnings and
// skipped — there's no Notion target to post to.
//
// Usage:
//   node scripts/backfill-comments-to-notion.js --dry-run
//   node scripts/backfill-comments-to-notion.js --limit=N
//   node scripts/backfill-comments-to-notion.js --yes
//
// Pre-flight: needs NOTION_API_KEY in .env. Reads SQLite at DB_PATH (defaults
// to ./prism.db). Run locally against a fresh prod snapshot, NOT directly
// against the Railway-mounted volume.

'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// ─── .env loader (mirrors apply-reconciliation.js) ─────────────────────────
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

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const SKIP_PAUSE = args.includes('--yes');
const LIMIT_FLAG = args.find(a => a.startsWith('--limit='));
const LIMIT = LIMIT_FLAG ? parseInt(LIMIT_FLAG.split('=')[1], 10) : Infinity;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'prism.db');

const NOTION_KEY = process.env.NOTION_API_KEY;
if (!DRY_RUN && !NOTION_KEY) {
  console.error('Missing NOTION_API_KEY (real runs only — dry-run does not need it)');
  process.exit(1);
}

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';
const REQ_INTERVAL_MS = 500;

const today = new Date().toISOString().split('T')[0];
const REPORTS_DIR = path.join(__dirname, '..', 'reports');
const LOG_PATH = path.join(REPORTS_DIR, `backfill-comments-log-${today}.jsonl`);

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Idempotency: load prior-run migrated IDs ──────────────────────────────
function loadAlreadyMigrated() {
  if (!fs.existsSync(REPORTS_DIR)) return new Set();
  const logs = fs.readdirSync(REPORTS_DIR)
    .filter(f => /^backfill-comments-log-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
  const migrated = new Set();
  for (const file of logs) {
    const text = fs.readFileSync(path.join(REPORTS_DIR, file), 'utf8');
    for (const line of text.split('\n').filter(Boolean)) {
      try {
        const entry = JSON.parse(line);
        if (entry.action === 'created' && entry.sqlite_comment_id != null) {
          migrated.add(entry.sqlite_comment_id);
        }
      } catch (e) {
        // Skip malformed lines silently — appended-only file may be mid-write.
      }
    }
  }
  return migrated;
}

// ─── Compose body (must match notionAdapter.composeCommentBody) ────────────
function composeCommentBody(text, author) {
  const tag = author && author !== 'system' ? `[${author}] ` : '';
  return `${tag}${String(text || '')}`;
}

// ─── Notion API (inlined to avoid pulling the full adapter for one call) ───
async function notionCreateComment(pageId, content) {
  const r = await fetch(`${NOTION_API}/comments`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${NOTION_KEY}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      parent: { page_id: pageId },
      rich_text: [{ text: { content } }],
    }),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`notion comment create ${pageId}: ${r.status} ${text.slice(0, 200)}`);
  }
  return r.json();
}

// ─── Main ──────────────────────────────────────────────────────────────────
(async () => {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`SQLite DB not found at ${DB_PATH}`);
    console.error('Set DB_PATH env var or copy a prod snapshot to ./prism.db first.');
    process.exit(1);
  }

  const db = new Database(DB_PATH, { readonly: true });
  const rows = db.prepare(`
    SELECT tc.id AS sqlite_comment_id,
           tc.ticket_id,
           tc.author,
           tc.comment,
           tc.created_at,
           t.notion_page_id,
           t.title
    FROM ticket_comments tc
    LEFT JOIN tickets t ON tc.ticket_id = t.id
    ORDER BY tc.created_at ASC
  `).all();
  db.close();

  console.log(`\nFound ${rows.length} SQLite ticket_comments rows.`);

  const orphans = rows.filter(r => !r.notion_page_id);
  if (orphans.length > 0) {
    console.log(`  ${orphans.length} orphan(s) (parent ticket has no notion_page_id) — will be skipped:`);
    for (const o of orphans.slice(0, 5)) {
      console.log(`    sqlite_id=${o.sqlite_comment_id} ticket_id=${o.ticket_id} author=${o.author}`);
    }
    if (orphans.length > 5) console.log(`    … and ${orphans.length - 5} more`);
  }

  const migrated = loadAlreadyMigrated();
  if (migrated.size > 0) {
    console.log(`  ${migrated.size} already migrated per prior-run logs — will be skipped`);
  }

  const eligible = rows.filter(r => r.notion_page_id && !migrated.has(r.sqlite_comment_id));
  console.log(`  ${eligible.length} eligible for backfill`);

  const plan = eligible.slice(0, LIMIT);
  if (plan.length < eligible.length) {
    console.log(`\n--limit=${LIMIT} → executing first ${plan.length} of ${eligible.length}`);
  }

  if (plan.length === 0) {
    console.log('\nNothing to do. Exiting.');
    return;
  }

  console.log(`\nFirst 3 to migrate:`);
  for (const r of plan.slice(0, 3)) {
    const title = (r.title || '?').slice(0, 30);
    const body = composeCommentBody(r.comment, r.author);
    console.log(`  sqlite_id=${r.sqlite_comment_id} ticket="${title}" author=${r.author} created=${r.created_at}`);
    console.log(`    body: ${body.slice(0, 80)}${body.length > 80 ? '…' : ''}`);
  }

  const estSec = Math.ceil((plan.length * REQ_INTERVAL_MS) / 1000);
  console.log(`\nEstimated runtime: ~${estSec}s (${REQ_INTERVAL_MS}ms throttle per Notion POST)`);

  if (DRY_RUN) {
    console.log('\n[DRY RUN] No Notion calls made. Re-run without --dry-run to execute.');
    return;
  }

  console.log(`\nLog: ${LOG_PATH}`);
  if (!SKIP_PAUSE) {
    console.log('Starting in 5 seconds — Ctrl-C to abort.');
    await sleep(5000);
  }

  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const logStream = fs.createWriteStream(LOG_PATH, { flags: 'a' });

  let ok = 0, fail = 0;
  for (const r of plan) {
    const base = {
      ts: new Date().toISOString(),
      sqlite_comment_id: r.sqlite_comment_id,
      ticket_id: r.ticket_id,
      notion_page_id: r.notion_page_id,
      author: r.author,
      sqlite_created_at: r.created_at,
    };
    try {
      const body = composeCommentBody(r.comment, r.author);
      const notionComment = await notionCreateComment(r.notion_page_id, body);
      logStream.write(JSON.stringify({ ...base, action: 'created', notion_comment_id: notionComment.id }) + '\n');
      console.log(`  ok   sqlite=${r.sqlite_comment_id} → notion=${notionComment.id}`);
      ok++;
    } catch (e) {
      fail++;
      logStream.write(JSON.stringify({ ...base, action: 'error', error: e.message }) + '\n');
      console.log(`  FAIL sqlite=${r.sqlite_comment_id} — ${e.message}`);
    }
    await sleep(REQ_INTERVAL_MS);
  }
  logStream.end();

  console.log(`\nDone. ok=${ok} fail=${fail}`);
  console.log(`Log: ${LOG_PATH}`);
  if (fail > 0) process.exit(1);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
