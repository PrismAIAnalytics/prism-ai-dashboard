#!/usr/bin/env node
// sync-tasks.js — mirror TASKS.md → dashboard tickets + Notion pages.
//
// One-way sync. TASKS.md is canonical (it holds the WIP=1 lock per WORKFLOW.md §3).
// Dashboard + Notion are read-only mirrors, kept consistent on every run.
// Idempotent: a no-op second run reports 0 creates / 0 updates.
//
// Match keys:
//   dashboard.tags must contain "task-md" and "T-###"
//   notion page.T-ID property == "T-###"
//
// Cross-link:
//   dashboard.notion_page_id ← Notion page UUID
//   notion.Dashboard Ticket ID ← dashboard ticket_key (e.g., TKT-0042)
//
// Deletion handling: rows removed from TASKS.md are NOT removed from either store.
// Manual cleanup. (See plan §"Open items" — --prune is a v2 followup.)
//
// Usage:
//   node scripts/sync-tasks.js                    # write to prod dashboard + Notion
//   node scripts/sync-tasks.js --dry-run          # parse + diff, no writes
//   node scripts/sync-tasks.js --local            # write to http://localhost:3000 instead of prod
//   node scripts/sync-tasks.js --dashboard-url=https://...
//
// Env required: NOTION_API_KEY, NOTION_TICKETS_DB_ID, API_KEY (dashboard auth)
// Loaded from Development/dashboard/.env (same lightweight pattern as server.js).

const fs = require('fs');
const path = require('path');

// ─── Lightweight .env loader (mirrors server.js:23-39) ─────────────────────
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
const DRY_RUN = process.argv.includes('--dry-run');
const USE_LOCAL = process.argv.includes('--local');
const URL_FLAG = process.argv.find(a => a.startsWith('--dashboard-url='));

const DASHBOARD_URL = URL_FLAG ? URL_FLAG.split('=')[1]
  : USE_LOCAL ? 'http://localhost:3000'
  : (process.env.DASHBOARD_URL || 'https://dashboard-api-production-dabe.up.railway.app');

const TASKS_MD_PATH = path.join(__dirname, '..', 'TASKS.md');
const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';
const MAX_NOTION_TEXT = 1900; // Notion rich_text per-block limit is 2000; leave headroom

// ─── Status mapping (TASKS.md section header → dashboard / Notion) ─────────
const STATUS_TO_DASH = {
  'In Progress':    'in_progress',
  'Up Next':        'backlog',
  'Done This Week': 'done',
  'Blocked':        'in_progress', // dashboard has no Blocked status; tagged separately
};
const STATUS_TO_NOTION = {
  'In Progress':    'In progress',
  'Up Next':        'Not started',
  'Done This Week': 'Done',
  'Blocked':        'Blocked',
};

// ─── TASKS.md parser ───────────────────────────────────────────────────────
function parseTasksMd(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const tasks = [];
  // Split on H2 headers; first segment is the file preamble (no H2)
  const sections = text.split(/^## /m).slice(1);
  for (const section of sections) {
    const lines = section.split('\n');
    const headingRaw = lines[0].trim();
    // Match "Up Next" even when written as "Up Next (priority order)"
    const heading = Object.keys(STATUS_TO_DASH).find(k => headingRaw === k || headingRaw.startsWith(k + ' '));
    if (!heading) continue;

    let inTable = false;
    for (const line of lines) {
      if (line.startsWith('|') && /^\|[\s\-:|]+\|$/.test(line.trim())) { inTable = true; continue; }
      if (!inTable) continue;
      if (!line.trim().startsWith('|')) { inTable = false; continue; }

      const cells = line.split('|').slice(1, -1).map(c => c.trim());
      if (cells.length === 0 || !cells[0]) continue;
      if (!/^T-\d+[a-z]?$/.test(cells[0])) continue; // skip header / non-T rows

      const id = cells[0];
      const title = cells[1] || '';
      const notes = cells.slice(2).join(' | ');
      const shaMatch = notes.match(/`([a-f0-9]{7,40})`/);
      tasks.push({
        id,
        title,
        status: heading,
        notes,
        mergeSha: shaMatch ? shaMatch[1] : null,
      });
    }
  }
  return tasks;
}

// ─── Dashboard API ─────────────────────────────────────────────────────────
async function dashFetch(p, opts = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(process.env.API_KEY ? { 'Authorization': `Bearer ${process.env.API_KEY}` } : {}),
    ...(opts.headers || {}),
  };
  const r = await fetch(`${DASHBOARD_URL}${p}`, { ...opts, headers });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`Dashboard ${opts.method || 'GET'} ${p}: ${r.status} ${body.slice(0, 300)}`);
  }
  return r.json();
}

async function getDashboardTickets() {
  const { tickets } = await dashFetch('/api/tickets?category=engineering');
  const map = new Map();
  for (const t of tickets) {
    const tagList = (t.tags || '').split(',').map(s => s.trim());
    if (!tagList.includes('task-md')) continue;
    const tid = tagList.find(s => /^T-\d+[a-z]?$/.test(s));
    if (tid) map.set(tid, t);
  }
  return map;
}

function dashboardPayload(task) {
  // POST appends `src:manual` via mergeSourceTag(); include it in the canonical
  // tag list so PATCH stays idempotent against subsequent reads.
  const tagList = ['task-md', task.id, 'src:manual'];
  if (task.status === 'Blocked') tagList.push('blocked');
  return {
    title: `${task.id}: ${task.title}`.slice(0, 500),
    description: task.notes.slice(0, 4000),
    category: 'engineering',
    status: STATUS_TO_DASH[task.status],
    priority: 'medium',
    tags: tagList.join(','),
    source: 'manual',
  };
}

function tagsEqual(a, b) {
  const setA = new Set((a || '').split(',').map(s => s.trim()).filter(Boolean));
  const setB = new Set((b || '').split(',').map(s => s.trim()).filter(Boolean));
  if (setA.size !== setB.size) return false;
  for (const t of setA) if (!setB.has(t)) return false;
  return true;
}

async function upsertDashboardTicket(task, existing) {
  const payload = dashboardPayload(task);
  if (!existing) {
    if (DRY_RUN) {
      console.log(`  [dry] CREATE dashboard ticket for ${task.id}`);
      return { ticket: { id: 'dry-dash-id', ticket_key: 'TKT-DRY' }, action: 'created' };
    }
    const { ticket } = await dashFetch('/api/tickets', { method: 'POST', body: JSON.stringify(payload) });
    return { ticket, action: 'created' };
  }
  const changed =
    (existing.title || '') !== payload.title ||
    (existing.description || '') !== payload.description ||
    existing.status !== payload.status ||
    !tagsEqual(existing.tags, payload.tags);
  if (!changed) return { ticket: existing, action: 'skipped' };
  if (DRY_RUN) { console.log(`  [dry] UPDATE dashboard ticket ${existing.ticket_key} for ${task.id}`); return { ticket: existing, action: 'updated' }; }
  // PATCH does not accept `source`; strip it
  const { source, ...patchable } = payload;
  const { ticket } = await dashFetch(`/api/tickets/${existing.id}`, { method: 'PATCH', body: JSON.stringify(patchable) });
  return { ticket, action: 'updated' };
}

async function linkBackDashboard(dashboardId, notionPageId) {
  if (DRY_RUN) { console.log(`  [dry] PATCH dashboard ticket ${dashboardId}.notion_page_id = ${notionPageId}`); return; }
  await dashFetch(`/api/tickets/${dashboardId}`, { method: 'PATCH', body: JSON.stringify({ notion_page_id: notionPageId }) });
}

// ─── Notion API ────────────────────────────────────────────────────────────
async function notionFetch(p, opts = {}) {
  const headers = {
    'Authorization': `Bearer ${process.env.NOTION_API_KEY}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
    ...(opts.headers || {}),
  };
  const r = await fetch(`${NOTION_API}${p}`, { ...opts, headers });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`Notion ${opts.method || 'GET'} ${p}: ${r.status} ${body.slice(0, 300)}`);
  }
  return r.json();
}

async function getNotionPages() {
  const dbId = process.env.NOTION_TICKETS_DB_ID;
  let pages = [];
  let cursor = null;
  do {
    const body = {
      filter: { property: 'T-ID', rich_text: { is_not_empty: true } },
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    };
    const resp = await notionFetch(`/databases/${dbId}/query`, { method: 'POST', body: JSON.stringify(body) });
    pages = pages.concat(resp.results);
    cursor = resp.has_more ? resp.next_cursor : null;
  } while (cursor);
  const map = new Map();
  for (const p of pages) {
    const id = p.properties['T-ID']?.rich_text?.[0]?.plain_text;
    if (id) map.set(id, p);
  }
  return map;
}

function notionPropsFor(task, dashboardKey) {
  const props = {
    'Ticket':              { title: [{ text: { content: `${task.id}: ${task.title}`.slice(0, MAX_NOTION_TEXT) } }] },
    'T-ID':                { rich_text: [{ text: { content: task.id } }] },
    'Status':              { status: { name: STATUS_TO_NOTION[task.status] } },
    'Category':            { select: { name: 'CRM Development' } },
    'Priority':            { select: { name: 'Medium' } },
    'Source':              { rich_text: [{ text: { content: 'TASKS.md' } }] },
    'Dashboard Ticket ID': { rich_text: [{ text: { content: dashboardKey || '' } }] },
  };
  return props;
}

function notionBodyChildren(task) {
  // One paragraph block with the notes, truncated. Created on first sync only;
  // subsequent updates leave the page body alone (description rot acceptable for v1).
  const content = (task.notes || '').slice(0, MAX_NOTION_TEXT) || '(no notes)';
  return [{
    object: 'block',
    type: 'paragraph',
    paragraph: { rich_text: [{ type: 'text', text: { content } }] },
  }];
}

function notionPageDiffers(page, task, dashboardKey) {
  const cur = page.properties;
  const expectTitle = `${task.id}: ${task.title}`.slice(0, MAX_NOTION_TEXT);
  const curTitle = cur['Ticket']?.title?.[0]?.plain_text || '';
  const curStatus = cur['Status']?.status?.name || '';
  const curDashKey = cur['Dashboard Ticket ID']?.rich_text?.[0]?.plain_text || '';
  return curTitle !== expectTitle
    || curStatus !== STATUS_TO_NOTION[task.status]
    || curDashKey !== (dashboardKey || '');
}

async function upsertNotionPage(task, existing, dashboardKey) {
  const properties = notionPropsFor(task, dashboardKey);
  if (!existing) {
    if (DRY_RUN) { console.log(`  [dry] CREATE notion page for ${task.id}`); return { page: { id: 'dry-page-id' }, action: 'created' }; }
    const page = await notionFetch('/pages', {
      method: 'POST',
      body: JSON.stringify({
        parent: { database_id: process.env.NOTION_TICKETS_DB_ID },
        properties,
        children: notionBodyChildren(task),
      }),
    });
    return { page, action: 'created' };
  }
  if (!notionPageDiffers(existing, task, dashboardKey)) {
    return { page: existing, action: 'skipped' };
  }
  if (DRY_RUN) { console.log(`  [dry] UPDATE notion page ${existing.id} for ${task.id}`); return { page: existing, action: 'updated' }; }
  const page = await notionFetch(`/pages/${existing.id}`, { method: 'PATCH', body: JSON.stringify({ properties }) });
  return { page, action: 'updated' };
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function main() {
  if (!process.env.NOTION_API_KEY) throw new Error('NOTION_API_KEY not set (check .env or env)');
  if (!process.env.NOTION_TICKETS_DB_ID) throw new Error('NOTION_TICKETS_DB_ID not set');

  console.log(`Mode:      ${DRY_RUN ? 'DRY RUN (no writes)' : 'WRITE'}`);
  console.log(`Dashboard: ${DASHBOARD_URL}`);
  console.log(`Notion DB: ${process.env.NOTION_TICKETS_DB_ID}`);
  console.log(`TASKS.md:  ${TASKS_MD_PATH}\n`);

  // Fail fast on Notion auth before touching the dashboard
  await notionFetch('/users/me');
  console.log('Notion auth OK.');

  const tasks = parseTasksMd(TASKS_MD_PATH);
  console.log(`Parsed ${tasks.length} tasks from TASKS.md`);
  for (const t of tasks) console.log(`  ${t.id} [${t.status}] ${t.title.slice(0, 70)}`);
  console.log('');

  const dashTickets = await getDashboardTickets();
  console.log(`Dashboard has ${dashTickets.size} existing engineering tickets tagged task-md`);
  const notionPages = await getNotionPages();
  console.log(`Notion has ${notionPages.size} existing pages with T-ID set\n`);

  const stats = { created: 0, updated: 0, skipped: 0, errors: 0 };

  for (const task of tasks) {
    try {
      const existingDash = dashTickets.get(task.id);
      const dashResult = await upsertDashboardTicket(task, existingDash);
      const dashKey = dashResult.ticket?.ticket_key || existingDash?.ticket_key || '';

      const existingNotion = notionPages.get(task.id);
      const notionResult = await upsertNotionPage(task, existingNotion, dashKey);

      // Cross-link: dashboard.notion_page_id ← Notion page UUID
      const needsLink = !DRY_RUN
        && dashResult.ticket && notionResult.page
        && (!existingDash || existingDash.notion_page_id !== notionResult.page.id);
      if (needsLink) await linkBackDashboard(dashResult.ticket.id, notionResult.page.id);

      const overall = (dashResult.action === 'created' || notionResult.action === 'created') ? 'CREATED'
        : (dashResult.action === 'updated' || notionResult.action === 'updated') ? 'UPDATED'
        : 'SKIPPED';
      console.log(`  ${task.id} → ${overall}  (dash:${dashResult.action}, notion:${notionResult.action})`);
      stats[overall.toLowerCase()]++;
    } catch (e) {
      console.error(`  ${task.id} ERROR: ${e.message}`);
      stats.errors++;
    }
  }

  console.log(`\nSummary: ${stats.created} created · ${stats.updated} updated · ${stats.skipped} skipped · ${stats.errors} errors`);
  if (stats.errors > 0) process.exit(1);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
