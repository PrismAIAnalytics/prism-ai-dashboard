#!/usr/bin/env node
// backfill-dashboard-ticket-ids.js — one-off cleanup for Notion tickets that
// are missing their `Dashboard Ticket ID` property.
//
// As of 2026-05-24, the chief-of-staff hook (~/.claude/scripts/hooks/lib/notion-ticket.js)
// auto-sets the Dashboard Ticket ID on create — so this script's normal output
// should be "Missing IDs: 0". But it stays in the repo for two cases:
//   1. Historical drift — tickets created before the hook fix landed
//   2. Cowork MCP create path (mcp__notion-create-pages) which can't be
//      patched at the source, so a periodic sweep catches what slips through
//
// The Dashboard Ticket ID is deterministic: NTN-<last-8-hex-of-page-uuid>.
// Mirrors notionAdapter.js:notionPageToTicket so dashboard display + Notion
// property always agree.
//
// Usage:
//   node scripts/backfill-dashboard-ticket-ids.js            # dry-run (default)
//   node scripts/backfill-dashboard-ticket-ids.js --apply    # actually PATCH
//   node scripts/backfill-dashboard-ticket-ids.js --cap 50   # per-run cap
//
// Env required: NOTION_API_KEY (or NOTION_TOKEN). Loaded from
// Development/dashboard/.env if not already set.
//
// Exit codes:
//   0 — clean run (or dry-run completed)
//   1 — config missing, fetch failed, or ≥1 PATCH failure in --apply mode

'use strict';

const fs = require('fs');
const path = require('path');

// ─── .env loader (mirrors sync-tasks.js) ───────────────────────────────────
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
function parseCap() {
  const args = process.argv;
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--cap=')) return parseInt(args[i].split('=')[1], 10);
    if (args[i] === '--cap' && i + 1 < args.length) return parseInt(args[i + 1], 10);
  }
  return 100;
}
const CAP = parseCap();
const RATE_LIMIT_DELAY_MS = 400;

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';
const DB_ID = process.env.NOTION_TICKETS_DB_ID || 'b3b42787-e56b-4807-afcc-ee172df50cb9';
const API_KEY = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN;

if (!API_KEY) {
  console.error('FATAL: NOTION_API_KEY (or NOTION_TOKEN) not set. Add to Development/dashboard/.env or your shell env.');
  process.exit(1);
}
if (!Number.isFinite(CAP) || CAP <= 0) {
  console.error('FATAL: --cap must be a positive integer');
  process.exit(1);
}

// ─── Notion API ────────────────────────────────────────────────────────────
async function notionFetch(p, opts = {}) {
  const r = await fetch(NOTION_API + p, {
    ...opts,
    headers: {
      'Authorization': 'Bearer ' + API_KEY,
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

async function fetchAllPages() {
  const pages = [];
  let cursor = null;
  do {
    const body = { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) };
    const resp = await notionFetch(`/databases/${DB_ID}/query`, { method: 'POST', body: JSON.stringify(body) });
    pages.push(...(resp.results || []));
    cursor = resp.has_more ? resp.next_cursor : null;
  } while (cursor);
  return pages;
}

function dashboardTicketIdForPage(pageId) {
  return 'NTN-' + String(pageId).replace(/-/g, '').slice(-8);
}

function readProp(props, key, type) {
  const p = props[key];
  if (!p) return null;
  switch (type) {
    case 'rich_text': return p.rich_text?.[0]?.plain_text || null;
    case 'number':    return p.number ?? null;
    case 'title':     return p.title?.[0]?.plain_text || null;
    default:          return null;
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Main ──────────────────────────────────────────────────────────────────
async function main() {
  console.log('Mode: ' + (APPLY ? 'APPLY (writes will happen)' : 'DRY RUN'));
  console.log('DB:   ' + DB_ID);
  console.log('Cap:  ' + CAP);
  console.log('');

  process.stdout.write('Fetching all pages... ');
  const t0 = Date.now();
  const all = await fetchAllPages();
  console.log(all.length + ' pages (' + (Date.now() - t0) + 'ms)');

  // Find pages with NO Dashboard Ticket ID. Skip ones with T-ID set (engineering
  // tickets owned by sync-tasks.js) — those use the T-### key, not NTN-####.
  const missing = [];
  for (const p of all) {
    const tid = readProp(p.properties, 'T-ID', 'rich_text');
    const did = readProp(p.properties, 'Dashboard Ticket ID', 'rich_text');
    if (did) continue;
    if (tid) continue; // engineering ticket, not our territory
    const title = readProp(p.properties, 'Ticket', 'title') || '(untitled)';
    missing.push({ id: p.id, title: title.slice(0, 70), expectedKey: dashboardTicketIdForPage(p.id) });
  }

  console.log('Missing IDs: ' + missing.length + (missing.length > CAP ? ' (capped to ' + CAP + ' this run)' : ''));
  if (missing.length === 0) {
    console.log('Nothing to do. Repo is clean — auto-set-on-create is doing its job.');
    return;
  }

  const work = missing.slice(0, CAP);
  console.log('');
  console.log('Sample (first 10):');
  for (const m of work.slice(0, 10)) {
    console.log('  ' + m.expectedKey + ' ← ' + m.title);
  }
  console.log('');

  if (!APPLY) {
    console.log('Dry-run complete. Re-run with --apply to PATCH ' + work.length + ' pages.');
    return;
  }

  console.log('Applying ' + work.length + ' PATCHes (' + RATE_LIMIT_DELAY_MS + 'ms between calls) ...');
  let ok = 0, fail = 0;
  for (let i = 0; i < work.length; i++) {
    const m = work[i];
    try {
      await notionFetch('/pages/' + m.id, {
        method: 'PATCH',
        body: JSON.stringify({
          properties: { 'Dashboard Ticket ID': { rich_text: [{ text: { content: m.expectedKey } }] } },
        }),
      });
      process.stdout.write('  [' + (i + 1) + '/' + work.length + '] ' + m.expectedKey + ' ← ' + m.title + '\n');
      ok++;
    } catch (err) {
      process.stderr.write('  [' + (i + 1) + '/' + work.length + '] FAIL ' + m.expectedKey + ': ' + err.message + '\n');
      fail++;
    }
    if (i < work.length - 1) await sleep(RATE_LIMIT_DELAY_MS);
  }
  console.log('\nDone: ' + ok + ' patched, ' + fail + ' failed');
  if (fail > 0) process.exit(1);
}

main().catch(e => {
  console.error('FATAL:', e.message);
  if (e.stack) console.error(e.stack);
  process.exit(1);
});
