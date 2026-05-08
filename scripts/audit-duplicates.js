#!/usr/bin/env node
// audit-duplicates.js — T-024, Phase 2 of the Notion-as-source migration.
//
// Read-only audit. Pulls every dashboard ticket + action_item from prod via
// HTTP, pulls every Notion `Prism AI Tickets` page via the Notion API, pairs
// them up, surfaces conflicts. Writes a CSV to reports/ for Michele to
// annotate. The annotated CSV is the gate for Phase 3 (T-025).
//
// Pairing key (in priority order):
//   1. tickets.notion_page_id ↔ Notion page.id  (strong key, set by T-019)
//   2. tickets.ticket_key ↔ Notion `Dashboard Ticket ID` (legacy backfill)
//   3. action_items.id ↔ Notion `Action Item ID`        (action items)
//
// Three categories surface in match_type:
//   - matched       — both sides exist; conflict_fields lists divergences
//   - sqlite_only   — dashboard side without Notion mate; must be created in
//                     Notion (Phase 3) before Phase 5 can drop the SQLite
//                     tables
//   - notion_only   — Notion page without dashboard mate; already syncing in
//                     via T-019 cron; no action needed
//
// suggested_winner heuristic for matched conflicts:
//   - if Notion last_edited_time > dashboard updated_at → "notion"
//   - else → "sqlite"
//   - sqlite_only → "sqlite" (only side that exists)
//   - notion_only → "notion" (only side that exists)
//
// resolution column is empty — Michele fills `keep_notion` / `keep_sqlite` /
// `merge_manual` / `archive_both` per row before T-025 reconciliation runs.
//
// Usage:
//   node scripts/audit-duplicates.js                   # writes reports/duplicates-YYYY-MM-DD.csv
//   node scripts/audit-duplicates.js --out=path.csv    # custom output path
//   node scripts/audit-duplicates.js --local           # use http://localhost:3000 instead of prod
//
// Env required (loaded from .env): NOTION_API_KEY, NOTION_TICKETS_DB_ID, API_KEY

'use strict';

const fs = require('fs');
const path = require('path');

// ─── Lightweight .env loader (mirrors server.js) ───────────────────────────
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
} catch (e) {
  if (e.code !== 'ENOENT') console.warn('[.env] Failed to load:', e.message);
}

// ─── Config ────────────────────────────────────────────────────────────────
const USE_LOCAL = process.argv.includes('--local');
const OUT_FLAG = process.argv.find(a => a.startsWith('--out='));
const DASHBOARD_URL = USE_LOCAL ? 'http://localhost:3000'
  : (process.env.DASHBOARD_URL || 'https://dashboard-api-production-dabe.up.railway.app');
const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

const today = new Date().toISOString().split('T')[0];
const REPORTS_DIR = path.join(__dirname, '..', 'reports');
const OUT_PATH = OUT_FLAG ? OUT_FLAG.split('=')[1] : path.join(REPORTS_DIR, `duplicates-${today}.csv`);

function envOrDie(name) {
  const v = process.env[name];
  if (!v) { console.error(`Missing ${name} (load .env or set in shell)`); process.exit(1); }
  return v;
}
const API_KEY = envOrDie('API_KEY');
const NOTION_API_KEY = envOrDie('NOTION_API_KEY');
const NOTION_DB_ID = envOrDie('NOTION_TICKETS_DB_ID');

// ─── Fetchers ──────────────────────────────────────────────────────────────
async function dashFetch(p) {
  const r = await fetch(DASHBOARD_URL + p, { headers: { Authorization: `Bearer ${API_KEY}` } });
  if (!r.ok) throw new Error(`dashboard ${p}: ${r.status} ${await r.text().catch(() => '')}`);
  return r.json();
}

async function fetchAllNotionPages() {
  const out = [];
  let cursor;
  for (let i = 0; i < 50; i++) {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const r = await fetch(`${NOTION_API}/databases/${NOTION_DB_ID}/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${NOTION_API_KEY}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`notion query: ${r.status} ${await r.text().catch(() => '')}`);
    const j = await r.json();
    out.push(...(j.results || []));
    if (!j.has_more) return out;
    cursor = j.next_cursor;
  }
  throw new Error('notion query exceeded 50-page cap');
}

// ─── Notion property readers (stripped down vs services/notionAdapter.js) ──
function readProp(props, key, type) {
  const p = props[key];
  if (!p) return null;
  switch (type) {
    case 'title':         return p.title?.[0]?.plain_text || null;
    case 'rich_text':     return p.rich_text?.[0]?.plain_text || null;
    case 'select':        return p.select?.name || null;
    case 'status':        return p.status?.name || null;
    case 'date':          return p.date?.start || null;
    case 'number':        return p.number ?? null;
    case 'unique_id':     return p.unique_id ? `${p.unique_id.prefix || ''}-${p.unique_id.number}` : null;
    default:              return null;
  }
}

function projectNotionPage(page) {
  const props = page.properties || {};
  return {
    notion_page_id: page.id,
    title: readProp(props, 'Ticket', 'title'),
    status: readProp(props, 'Status', 'status'),
    priority: readProp(props, 'Priority', 'select'),
    category: readProp(props, 'Category', 'select'),
    due_date: readProp(props, 'Due Date', 'date'),
    t_id: readProp(props, 'T-ID', 'rich_text'),
    dashboard_ticket_id: readProp(props, 'Dashboard Ticket ID', 'rich_text'),
    action_item_id: readProp(props, 'Action Item ID', 'number'),
    prism_id: readProp(props, 'Ticket ID', 'unique_id'),
    last_edited: page.last_edited_time || null,
  };
}

// ─── Conflict detection ────────────────────────────────────────────────────
const norm = (v) => v == null ? '' : String(v).trim();

const STATUS_NOTION_TO_DASH = {
  'Not started': 'backlog', 'In progress': 'in_progress', 'Blocked': 'blocked', 'Done': 'done',
};
const PRIORITY_NOTION_TO_DASH = {
  Urgent: 'urgent', High: 'high', Medium: 'medium', Low: 'low',
};

function compareMatched(dashRow, notionRow) {
  const conflicts = [];
  if (norm(dashRow.title) !== norm(notionRow.title)) conflicts.push('title');
  const notionStatusMapped = STATUS_NOTION_TO_DASH[notionRow.status] || norm(notionRow.status);
  if (norm(dashRow.status) !== norm(notionStatusMapped)) conflicts.push('status');
  const notionPriorityMapped = PRIORITY_NOTION_TO_DASH[notionRow.priority] || norm(notionRow.priority);
  if (norm(dashRow.priority) !== norm(notionPriorityMapped)) conflicts.push('priority');
  if (norm(dashRow.due_date) !== norm(notionRow.due_date)) conflicts.push('due_date');
  return conflicts;
}

function suggestWinner(dashRow, notionRow) {
  const dt = (dashRow.updated_at || dashRow.created_at || '').replace(' ', 'T');
  const nt = notionRow.last_edited || '';
  if (!dt && !nt) return 'tie';
  if (!dt) return 'notion';
  if (!nt) return 'sqlite';
  return nt > dt ? 'notion' : (dt > nt ? 'sqlite' : 'tie');
}

// ─── CSV writer (RFC 4180) ─────────────────────────────────────────────────
function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function writeCsv(rows, headers, outPath) {
  const lines = [headers.join(',')];
  for (const r of rows) lines.push(headers.map(h => csvCell(r[h])).join(','));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, lines.join('\n') + '\n', 'utf8');
}

// ─── Main ──────────────────────────────────────────────────────────────────
(async () => {
  console.log(`[audit] dashboard: ${DASHBOARD_URL}`);
  console.log(`[audit] notion DB: ${NOTION_DB_ID}`);
  console.log('');

  console.log('[audit] fetching dashboard tickets...');
  const ticketsRes = await dashFetch('/api/tickets');
  const tickets = ticketsRes.tickets || [];
  console.log(`  → ${tickets.length} tickets`);

  console.log('[audit] fetching dashboard action_items...');
  const actionsRes = await dashFetch('/api/actions');
  const actions = actionsRes.data || [];
  console.log(`  → ${actions.length} action_items`);

  console.log('[audit] fetching Notion pages...');
  const notionPages = (await fetchAllNotionPages()).map(projectNotionPage);
  console.log(`  → ${notionPages.length} Notion pages`);
  console.log('');

  // Build lookup indexes
  const notionByPageId = new Map(notionPages.map(p => [p.notion_page_id, p]));
  const notionByDashId = new Map(notionPages.filter(p => p.dashboard_ticket_id).map(p => [p.dashboard_ticket_id, p]));
  const notionByActionId = new Map(notionPages.filter(p => p.action_item_id != null).map(p => [p.action_item_id, p]));
  const matchedNotionIds = new Set();

  const rows = [];

  // Pass 1: tickets → pair against Notion
  for (const t of tickets) {
    let np = null;
    if (t.notion_page_id) np = notionByPageId.get(t.notion_page_id);
    if (!np && t.ticket_key) np = notionByDashId.get(t.ticket_key);
    if (!np && t.action_item_id != null) np = notionByActionId.get(t.action_item_id);

    if (np) {
      matchedNotionIds.add(np.notion_page_id);
      const conflicts = compareMatched(t, np);
      rows.push({
        match_type: 'matched',
        sqlite_id: t.id,
        sqlite_key: t.ticket_key || '',
        notion_page_id: np.notion_page_id,
        prism_id: np.prism_id || '',
        t_id: np.t_id || '',
        action_item_id: np.action_item_id ?? t.action_item_id ?? '',
        title_sqlite: t.title,
        title_notion: np.title || '',
        status_sqlite: t.status,
        status_notion: np.status || '',
        priority_sqlite: t.priority,
        priority_notion: np.priority || '',
        due_sqlite: t.due_date || '',
        due_notion: np.due_date || '',
        category_sqlite: t.category || '',
        category_notion: np.category || '',
        last_updated_sqlite: t.updated_at || t.created_at || '',
        last_updated_notion: np.last_edited || '',
        conflict_fields: conflicts.join(';'),
        suggested_winner: conflicts.length ? suggestWinner(t, np) : '',
        resolution: '',
      });
    } else {
      rows.push({
        match_type: 'sqlite_only',
        sqlite_id: t.id,
        sqlite_key: t.ticket_key || '',
        notion_page_id: '',
        prism_id: '',
        t_id: '',
        action_item_id: t.action_item_id ?? '',
        title_sqlite: t.title,
        title_notion: '',
        status_sqlite: t.status,
        status_notion: '',
        priority_sqlite: t.priority,
        priority_notion: '',
        due_sqlite: t.due_date || '',
        due_notion: '',
        category_sqlite: t.category || '',
        category_notion: '',
        last_updated_sqlite: t.updated_at || t.created_at || '',
        last_updated_notion: '',
        conflict_fields: '',
        suggested_winner: 'sqlite',
        resolution: '',
      });
    }
  }

  // Pass 2: action_items not already represented via tickets
  for (const a of actions) {
    if (rows.some(r => r.action_item_id !== '' && Number(r.action_item_id) === a.id)) continue;
    const np = notionByActionId.get(a.id);
    if (np) {
      matchedNotionIds.add(np.notion_page_id);
      rows.push({
        match_type: 'matched',
        sqlite_id: `action_items#${a.id}`,
        sqlite_key: `(no ticket pair) ACT-${String(a.id).padStart(4, '0')}`,
        notion_page_id: np.notion_page_id,
        prism_id: np.prism_id || '',
        t_id: np.t_id || '',
        action_item_id: a.id,
        title_sqlite: a.title,
        title_notion: np.title || '',
        status_sqlite: a.status,
        status_notion: np.status || '',
        priority_sqlite: '',
        priority_notion: np.priority || '',
        due_sqlite: '',
        due_notion: np.due_date || '',
        category_sqlite: 'action',
        category_notion: np.category || '',
        last_updated_sqlite: a.created_at || '',
        last_updated_notion: np.last_edited || '',
        conflict_fields: norm(a.title) !== norm(np.title) ? 'title' : '',
        suggested_winner: 'notion',
        resolution: '',
      });
    } else {
      rows.push({
        match_type: 'sqlite_only',
        sqlite_id: `action_items#${a.id}`,
        sqlite_key: `(no ticket pair) ACT-${String(a.id).padStart(4, '0')}`,
        notion_page_id: '',
        prism_id: '',
        t_id: '',
        action_item_id: a.id,
        title_sqlite: a.title,
        title_notion: '',
        status_sqlite: a.status,
        status_notion: '',
        priority_sqlite: '',
        priority_notion: '',
        due_sqlite: '',
        due_notion: '',
        category_sqlite: 'action',
        category_notion: '',
        last_updated_sqlite: a.created_at || '',
        last_updated_notion: '',
        conflict_fields: '',
        suggested_winner: 'sqlite',
        resolution: '',
      });
    }
  }

  // Pass 3: Notion pages with no SQLite mate
  for (const np of notionPages) {
    if (matchedNotionIds.has(np.notion_page_id)) continue;
    rows.push({
      match_type: 'notion_only',
      sqlite_id: '',
      sqlite_key: '',
      notion_page_id: np.notion_page_id,
      prism_id: np.prism_id || '',
      t_id: np.t_id || '',
      action_item_id: np.action_item_id ?? '',
      title_sqlite: '',
      title_notion: np.title || '',
      status_sqlite: '',
      status_notion: np.status || '',
      priority_sqlite: '',
      priority_notion: np.priority || '',
      due_sqlite: '',
      due_notion: np.due_date || '',
      category_sqlite: '',
      category_notion: np.category || '',
      last_updated_sqlite: '',
      last_updated_notion: np.last_edited || '',
      conflict_fields: '',
      suggested_winner: 'notion',
      resolution: '',
    });
  }

  // Sort: matched-with-conflicts first (most attention needed), then matched
  // clean, then sqlite_only, then notion_only.
  const sortBucket = (r) => {
    if (r.match_type === 'matched' && r.conflict_fields) return 0;
    if (r.match_type === 'matched') return 1;
    if (r.match_type === 'sqlite_only') return 2;
    return 3;
  };
  rows.sort((a, b) => {
    const d = sortBucket(a) - sortBucket(b);
    if (d !== 0) return d;
    return (a.sqlite_key || a.notion_page_id).localeCompare(b.sqlite_key || b.notion_page_id);
  });

  const headers = [
    'match_type', 'sqlite_id', 'sqlite_key', 'notion_page_id', 'prism_id', 't_id', 'action_item_id',
    'title_sqlite', 'title_notion',
    'status_sqlite', 'status_notion',
    'priority_sqlite', 'priority_notion',
    'due_sqlite', 'due_notion',
    'category_sqlite', 'category_notion',
    'last_updated_sqlite', 'last_updated_notion',
    'conflict_fields', 'suggested_winner', 'resolution',
  ];

  writeCsv(rows, headers, OUT_PATH);

  // Summary
  const counts = rows.reduce((acc, r) => {
    const k = r.match_type === 'matched' && r.conflict_fields ? 'matched_with_conflicts'
      : r.match_type === 'matched' ? 'matched_clean'
      : r.match_type;
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});

  console.log('[audit] summary:');
  console.log(`  matched (with conflicts):    ${counts.matched_with_conflicts || 0}`);
  console.log(`  matched (clean):             ${counts.matched_clean || 0}`);
  console.log(`  sqlite_only:                 ${counts.sqlite_only || 0}`);
  console.log(`  notion_only:                 ${counts.notion_only || 0}`);
  console.log(`  total rows:                  ${rows.length}`);
  console.log('');
  console.log(`[audit] CSV written → ${OUT_PATH}`);
  console.log('');
  console.log('Next: open the CSV, fill the resolution column for each row');
  console.log('  (keep_notion / keep_sqlite / merge_manual / archive_both),');
  console.log('  then T-025 reads the annotated CSV and applies the decisions.');
})();
