#!/usr/bin/env node
// migrate-delivery-to-notion.js — one-time migration of orphan `delivery` tickets
// from the dashboard `tickets` table into the Notion "Prism AI Tickets" DB.
//
// Why: T-019 makes the CRM Tickets page view-only for engineering/action/delivery.
// Delivery tickets (TKT-####, src:manual) currently have no upstream — this gives
// each one a Notion page so future edits happen there. After migration, the
// dashboard ticket carries notion_page_id and the page is the canonical source.
//
// Default mode: --dry-run (prints payloads, no writes).
// Pass --apply to actually write to Notion + dashboard.

const fs = require('fs');
const path = require('path');

// ─── Lightweight .env loader ───────────────────────────────────────────────
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

const APPLY = process.argv.includes('--apply');
const DASHBOARD_URL = process.env.DASHBOARD_URL || 'https://dashboard-api-production-dabe.up.railway.app';
const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';
const TODAY = new Date().toISOString().slice(0, 10);

const NOTION_KEY = process.env.NOTION_API_KEY;
const NOTION_DB = process.env.NOTION_TICKETS_DB_ID;
const DASH_KEY = process.env.API_KEY;

if (!NOTION_KEY || !NOTION_DB || !DASH_KEY) {
  console.error('Missing one of: NOTION_API_KEY, NOTION_TICKETS_DB_ID, API_KEY');
  process.exit(1);
}

// ─── Mappings ──────────────────────────────────────────────────────────────
const STATUS_MAP = {
  backlog: 'Not started',
  todo: 'Not started',
  in_progress: 'In progress',
  blocked: 'Blocked',
  done: 'Done',
};
const PRIORITY_MAP = { urgent: 'Urgent', high: 'High', medium: 'Medium', low: 'Low' };

function mapCategory(tags) {
  // Delivery tickets use category tags. Default to AI Bridge for anything ai-bridge tagged;
  // fall through to Client Work otherwise.
  if (!tags) return 'Client Work';
  if (tags.includes('ai-bridge')) return 'AI Bridge';
  return 'Client Work';
}

// ─── Helpers ───────────────────────────────────────────────────────────────
async function dashFetch(p, opts = {}) {
  const r = await fetch(DASHBOARD_URL + p, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + DASH_KEY, ...(opts.headers || {}) },
  });
  if (!r.ok) throw new Error(`dashboard ${p}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function notionFetch(p, opts = {}) {
  const r = await fetch(NOTION_API + p, {
    ...opts,
    headers: {
      Authorization: 'Bearer ' + NOTION_KEY,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const j = await r.json();
  if (!r.ok || j.object === 'error') throw new Error(`notion ${p}: ${j.code || r.status} ${j.message || ''}`);
  return j;
}

function buildPayload(ticket) {
  const props = {
    Ticket: { title: [{ text: { content: ticket.title || '(untitled)' } }] },
    Status: { status: { name: STATUS_MAP[ticket.status] || 'Not started' } },
    Priority: { select: { name: PRIORITY_MAP[ticket.priority] || 'Medium' } },
    Category: { select: { name: mapCategory(ticket.tags) } },
    'Dashboard Ticket ID': { rich_text: [{ text: { content: ticket.ticket_key || '' } }] },
    Source: {
      rich_text: [{ text: { content: `manual (migrated from dashboard ${ticket.ticket_key} on ${TODAY})` } }],
    },
    Client: {
      rich_text: [{ text: { content: ticket.client_name || 'Prism AI Analytics' } }],
    },
  };

  if (ticket.due_date) {
    props['Due Date'] = { date: { start: ticket.due_date } };
  }

  const children = ticket.description
    ? [
        {
          object: 'block',
          type: 'paragraph',
          paragraph: { rich_text: [{ text: { content: ticket.description.slice(0, 1900) } }] },
        },
      ]
    : [];

  return {
    parent: { database_id: NOTION_DB },
    properties: props,
    children,
  };
}

// ─── Main ──────────────────────────────────────────────────────────────────
(async () => {
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`Dashboard: ${DASHBOARD_URL}`);
  console.log(`Notion DB: ${NOTION_DB}`);
  console.log();

  const all = await dashFetch('/api/tickets');
  const orphans = (all.tickets || []).filter(
    t => t.category === 'delivery' && !t.notion_page_id,
  );

  console.log(`Found ${orphans.length} orphan delivery tickets:`);
  for (const t of orphans) {
    console.log(`  ${t.ticket_key} | ${t.status} | ${t.priority} | ${t.title}`);
  }
  console.log();

  if (orphans.length === 0) {
    console.log('Nothing to migrate.');
    return;
  }

  for (const t of orphans) {
    const payload = buildPayload(t);
    console.log(`--- ${t.ticket_key} → Notion payload ---`);
    console.log(`  title    : ${payload.properties.Ticket.title[0].text.content}`);
    console.log(`  status   : ${payload.properties.Status.status.name}`);
    console.log(`  priority : ${payload.properties.Priority.select.name}`);
    console.log(`  category : ${payload.properties.Category.select.name}`);
    console.log(`  due      : ${payload.properties['Due Date']?.date?.start || '(none)'}`);
    console.log(`  source   : ${payload.properties.Source.rich_text[0].text.content}`);
    console.log(`  body     : ${(t.description || '(none)').slice(0, 80)}${t.description && t.description.length > 80 ? '…' : ''}`);

    if (!APPLY) continue;

    const page = await notionFetch('/pages', { method: 'POST', body: JSON.stringify(payload) });
    console.log(`  CREATED  : ${page.id}`);

    await dashFetch(`/api/tickets/${t.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ notion_page_id: page.id }),
    });
    console.log(`  LINKED   : dashboard ticket ${t.ticket_key} ← notion_page_id ${page.id}`);
  }

  console.log();
  console.log(APPLY ? 'Migration complete.' : 'Dry-run complete. Re-run with --apply to write.');
})().catch(e => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
