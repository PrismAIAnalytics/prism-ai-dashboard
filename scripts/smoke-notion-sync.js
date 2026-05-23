#!/usr/bin/env node
// smoke-notion-sync.js — local exercise of services/notionSync.js with the cutoff
// active. Uses an in-memory better-sqlite3 DB seeded from prod tickets via API,
// so we test the real matching logic without touching prod or the local file DB.
// Always runs in dryRun mode — no Notion writes, no DB writes.

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

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

const DASHBOARD_URL = process.env.DASHBOARD_URL || 'https://dashboard-api-production-dabe.up.railway.app';
const NOTION_KEY = process.env.NOTION_API_KEY;
const NOTION_DB = process.env.NOTION_TICKETS_DB_ID;
const SINCE = process.env.NOTION_SYNC_SINCE || undefined;
const DASH_KEY = process.env.API_KEY;

if (!NOTION_KEY || !NOTION_DB || !DASH_KEY) {
  console.error('Missing one of NOTION_API_KEY, NOTION_TICKETS_DB_ID, API_KEY');
  process.exit(1);
}

const { syncNotionTickets } = require('../services/notionSync');

(async () => {
  console.log('SMOKE TEST — services/notionSync.js');
  console.log('  PROD URL:', DASHBOARD_URL);
  console.log('  Cutoff  :', SINCE || '(none)');
  console.log();

  // Build an in-memory replica of prod tickets (just the columns the sync touches)
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE tickets (
      id TEXT PRIMARY KEY, ticket_key TEXT, title TEXT, description TEXT,
      ticket_type TEXT, category TEXT, status TEXT, priority TEXT,
      tags TEXT, source TEXT, created_by TEXT, due_date TEXT,
      notion_page_id TEXT, updated_at TEXT
    );
  `);

  const r = await fetch(DASHBOARD_URL + '/api/tickets', { headers: { Authorization: 'Bearer ' + DASH_KEY } });
  const j = await r.json();
  const ins = db.prepare(
    `INSERT INTO tickets (id, ticket_key, title, description, ticket_type, category, status, priority, tags, source, created_by, due_date, notion_page_id, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  for (const t of j.tickets || []) {
    ins.run(t.id, t.ticket_key, t.title || '', t.description || '', t.ticket_type, t.category, t.status, t.priority, t.tags, t.source, t.created_by, t.due_date, t.notion_page_id, t.updated_at);
  }
  console.log(`  Loaded ${db.prepare('SELECT COUNT(*) c FROM tickets').get().c} prod tickets into in-memory DB`);
  console.log();

  // Stub nextTicketKey — we won't need it in dryRun, but the API requires it
  const nextTicketKey = () => 'NTN-9999';

  const stats = await syncNotionTickets({
    db,
    nextTicketKey,
    apiKey: NOTION_KEY,
    dbId: NOTION_DB,
    since: SINCE,
    dryRun: true,
    log: (m) => console.log(' ', m),
  });

  console.log();
  console.log('=== Smoke result ===');
  console.log('  fetched:        from Notion (count above)');
  console.log('  would create:  ', stats.wouldCreate);
  console.log('  would update:  ', stats.wouldUpdate);
  console.log('  skipped:       ', stats.skipped);
  console.log('  errors:        ', stats.errors);
  console.log('  duration:      ', stats.durationMs + 'ms');

  if (stats.errors > 0) {
    console.error('FAIL: errors > 0');
    process.exit(1);
  }
  if (SINCE && stats.wouldCreate > 5) {
    console.warn(`WARN: cutoff is set but ${stats.wouldCreate} pages would still create — investigate.`);
  }
  console.log('OK');
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
