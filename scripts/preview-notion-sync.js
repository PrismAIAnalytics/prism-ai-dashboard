#!/usr/bin/env node
// preview-notion-sync.js — predict what notionSync.syncNotionTickets() will do
// against PROD without writing anything. Pulls prod ticket data via API to do
// the matching, since the local SQLite DB doesn't necessarily reflect prod state.
//
// Usage:
//   node scripts/preview-notion-sync.js              # full preview (all 57 unlinked would create)
//   node scripts/preview-notion-sync.js --skip-done  # preview with skipDoneOnFirstRun=true

const fs = require('fs');
const path = require('path');

try {
  const envPath = path.join(__dirname, '..', '.env');
  const envFile = fs.readFileSync(envPath, 'utf8');
  for (const line of envFile.split('\n')) {
    const m = line.replace(/\r$/, '').match(/^\s*([^#=]+?)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) {
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  }
} catch (e) { if (e.code !== 'ENOENT') console.warn('[.env]', e.message); }

const SKIP_DONE = process.argv.includes('--skip-done');
const DASHBOARD_URL = process.env.DASHBOARD_URL || 'https://dashboard-api-production-dabe.up.railway.app';
const NOTION_KEY = process.env.NOTION_API_KEY;
const NOTION_DB = process.env.NOTION_TICKETS_DB_ID;
const DASH_KEY = process.env.API_KEY;

if (!NOTION_KEY || !NOTION_DB || !DASH_KEY) {
  console.error('Missing one of NOTION_API_KEY, NOTION_TICKETS_DB_ID, API_KEY');
  process.exit(1);
}

const { fetchAllNotionTickets, mapPage } = require('../services/notionSync');

(async () => {
  console.log(`PROD URL : ${DASHBOARD_URL}`);
  console.log(`Mode     : DRY RUN${SKIP_DONE ? ' + skipDoneOnFirstRun' : ''}`);
  console.log();

  // Fetch prod tickets to build an in-memory match index
  const r = await fetch(DASHBOARD_URL + '/api/tickets', {
    headers: { Authorization: 'Bearer ' + DASH_KEY },
  });
  const j = await r.json();
  const prodTickets = j.tickets || [];
  const byNotionId = new Map();
  const byTicketKey = new Map();
  for (const t of prodTickets) {
    if (t.notion_page_id) byNotionId.set(t.notion_page_id, t);
    if (t.ticket_key) byTicketKey.set(t.ticket_key, t);
  }
  console.log(`Prod tickets: ${prodTickets.length} (${byNotionId.size} linked to Notion)`);

  const pages = await fetchAllNotionTickets({ apiKey: NOTION_KEY, dbId: NOTION_DB });
  console.log(`Notion pages: ${pages.length}`);
  console.log();

  const buckets = {
    skipTID: 0,
    skipNoTitle: 0,
    skipNoChange: 0,
    skipDoneFirstRun: 0,
    wouldUpdate: [],
    wouldUpdateBackfill: [],
    wouldCreate: [],
  };

  for (const page of pages) {
    const m = mapPage(page);
    if (m.t_id) { buckets.skipTID++; continue; }
    if (!m.title) { buckets.skipNoTitle++; continue; }

    let existing = byNotionId.get(m.notion_page_id);
    let viaBackfill = false;
    if (!existing && m.dashboard_ticket_id) {
      existing = byTicketKey.get(m.dashboard_ticket_id);
      if (existing) viaBackfill = true;
    }

    if (existing) {
      const needsBackfill = !existing.notion_page_id;
      const changed = needsBackfill ||
        existing.title !== m.title ||
        existing.status !== m.status ||
        existing.priority !== m.priority ||
        existing.category !== m.category ||
        (existing.due_date || null) !== (m.due_date || null);
      if (!changed) { buckets.skipNoChange++; continue; }
      const tag = needsBackfill ? buckets.wouldUpdateBackfill : buckets.wouldUpdate;
      tag.push({ k: existing.ticket_key, t: m.title, st: m.status, viaBackfill });
      continue;
    }

    if (SKIP_DONE && m.status === 'done') { buckets.skipDoneFirstRun++; continue; }

    buckets.wouldCreate.push({ t: m.title, st: m.status, p: m.priority, c: m.category });
  }

  console.log('=== PREVIEW SUMMARY ===');
  console.log('  skip (T-ID is set, T-015 owns)        :', buckets.skipTID);
  console.log('  skip (no title, malformed)            :', buckets.skipNoTitle);
  console.log('  skip (already in sync, no changes)    :', buckets.skipNoChange);
  if (SKIP_DONE) console.log('  skip (done, --skip-done active)       :', buckets.skipDoneFirstRun);
  console.log('  WOULD UPDATE existing                 :', buckets.wouldUpdate.length);
  console.log('  WOULD UPDATE w/ notion_page_id backfill:', buckets.wouldUpdateBackfill.length);
  console.log('  WOULD CREATE new dashboard ticket     :', buckets.wouldCreate.length);

  if (buckets.wouldCreate.length) {
    console.log();
    console.log('=== Sample of would-create (first 20) ===');
    const byStatus = {};
    for (const x of buckets.wouldCreate) byStatus[x.st] = (byStatus[x.st] || 0) + 1;
    console.log('  by status:', byStatus);
    console.log();
    for (const x of buckets.wouldCreate.slice(0, 20)) {
      console.log(`  [${x.st.padEnd(11)}] ${x.c.padEnd(20)} | ${x.t.slice(0, 70)}`);
    }
    if (buckets.wouldCreate.length > 20) console.log(`  … and ${buckets.wouldCreate.length - 20} more`);
  }

  if (buckets.wouldUpdateBackfill.length) {
    console.log();
    console.log('=== Sample of would-update via Dashboard Ticket ID backfill (first 10) ===');
    for (const x of buckets.wouldUpdateBackfill.slice(0, 10)) {
      console.log(`  ${x.k} → ${x.t.slice(0, 60)} (${x.st})`);
    }
  }
})().catch(e => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
