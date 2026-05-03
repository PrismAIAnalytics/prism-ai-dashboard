// notionAdapter.js — Phase 1 read-path adapter for the Notion-as-source migration.
//
// T-023. Provides Notion-backed implementations of the GET routes the dashboard
// frontend reads from: /api/tickets, /api/tickets/summary, /api/actions.
//
// Gated behind USE_NOTION_SOURCE in server.js — when 'false' (default) the
// existing SQLite path runs; when 'true' the adapter answers from Notion.
//
// Cache: 60-second in-memory TTL keyed by query signature, with single-flight
// coalescing so a thundering herd of concurrent requests collapses to one
// Notion call. Notion's REST API soft-limits at ~3 req/sec; without coalescing
// a busy dashboard would 429 immediately.
//
// Failure mode: on Notion error, serves stale-from-cache if available (with
// `stale: true` exposed on the result), otherwise lets the route handler fall
// back to the SQLite path. Phase 1 keeps SQLite authoritative; later phases
// remove this safety net.
//
// Contract: every field the frontend reads from /api/tickets must be present
// in the adapter output (some null where Notion has no equivalent property).
// See contract.test.js for the enforced field list.

'use strict';

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';
const CACHE_TTL_MS = 60 * 1000;

const _cache = new Map();      // key → { data, expiresAt }
const _inflight = new Map();   // key → Promise (single-flight coalescing)

const STATUS_NOTION_TO_DASH = {
  'Not started': 'backlog',
  'In progress': 'in_progress',
  'Blocked': 'blocked',
  'Done': 'done',
};

const PRIORITY_NOTION_TO_DASH = {
  Urgent: 'urgent',
  High: 'high',
  Medium: 'medium',
  Low: 'low',
};

// Mirrors services/notionSync.js so categories don't reclassify across the two
// integrations. Unknown Notion categories normalize to lowercase_with_underscores.
const CATEGORY_NOTION_TO_DASH = {
  'AI Bridge': 'delivery',
  'Client Work': 'delivery',
  'CRM Development': 'engineering',
  'Marketing': 'marketing',
  'Admin': 'admin',
  'Sales & Outreach': 'sales',
  'Content': 'content',
  'Finance': 'finance',
  'Training': 'training',
  'Prism Studio': 'prism_studio',
};

function categoryNotionToDash(notionCat) {
  if (!notionCat) return 'general';
  if (CATEGORY_NOTION_TO_DASH[notionCat]) return CATEGORY_NOTION_TO_DASH[notionCat];
  return notionCat.toLowerCase()
    .replace(/\s*&\s*/g, '_')
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
}

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
    case 'people_name':   return p.people?.[0]?.name || null;
    case 'created_time':  return p.created_time || null;
    case 'last_edited':   return p.last_edited_time || null;
    default:              return null;
  }
}

// Map a Notion page → dashboard-shape ticket object. All fields the frontend
// reads from /api/tickets are present; Notion-absent fields are null. Tag
// values follow T-019's convention so the read-only badge logic still works.
function notionPageToTicket(page) {
  const props = page.properties || {};
  const actionItemId = readProp(props, 'Action Item ID', 'number');
  const tIdRaw = readProp(props, 'T-ID', 'rich_text');
  const dashIdRaw = readProp(props, 'Dashboard Ticket ID', 'rich_text');

  // ticket_key derivation, in priority order:
  //  1. Action Item ID set → ACT-#### (zero-padded; matches dashboard prefix)
  //  2. Dashboard Ticket ID set → use it directly (already cross-linked)
  //  3. T-ID set → use it (engineering tickets driven by TASKS.md)
  //  4. Fallback → NTN-<last 8 chars of UUID> for stability across runs
  let ticket_key;
  let source;
  if (actionItemId != null) {
    ticket_key = `ACT-${String(actionItemId).padStart(4, '0')}`;
    source = 'action-item';
  } else if (dashIdRaw) {
    ticket_key = dashIdRaw;
    if (dashIdRaw.startsWith('ACT-')) source = 'action-item';
    else if (dashIdRaw.startsWith('NTN-')) source = 'notion';
    else if (dashIdRaw.startsWith('TKT-')) source = 'manual';
    else if (dashIdRaw.startsWith('T-')) source = 'manual';
    else source = 'notion';
  } else if (tIdRaw) {
    ticket_key = tIdRaw;
    source = 'manual';
  } else {
    ticket_key = `NTN-${page.id.replace(/-/g, '').slice(-8)}`;
    source = 'notion';
  }

  const status = STATUS_NOTION_TO_DASH[readProp(props, 'Status', 'status')] || 'backlog';
  const priority = PRIORITY_NOTION_TO_DASH[readProp(props, 'Priority', 'select')] || 'medium';
  const lastEdited = readProp(props, 'Last Updated', 'last_edited');

  return {
    // Notion page UUID is the canonical id; matches the existing notion_page_id
    // value already stored on dashboard tickets via T-019.
    id: page.id,
    ticket_key,
    source,
    title: readProp(props, 'Ticket', 'title') || '',
    // Notion has no description property; page-body fetch deferred to Phase 4
    // (would explode per-request count to satisfy a single list endpoint).
    description: '',
    // Notion has no ticket_type property; default to internal.
    ticket_type: 'internal',
    category: categoryNotionToDash(readProp(props, 'Category', 'select')),
    status,
    priority,
    // Notion `people` doesn't map to a dashboard team_members.id without a
    // separate user table — keep id null, surface only the name for display.
    assigned_to: null,
    assignee_name: readProp(props, 'Assignee', 'people_name'),
    client_id: null,
    client_name: readProp(props, 'Client', 'rich_text'),
    project_id: null,
    project_name: null,
    due_date: readProp(props, 'Due Date', 'date'),
    // Tags drive the T-019 read-only UI badges; preserve src:notion convention.
    tags: ['notion-source', 'src:notion', `notion-page:${page.id}`].join(','),
    sort_order: null,
    created_at: readProp(props, 'Created', 'created_time'),
    updated_at: lastEdited,
    // Approximation: Notion has no completed_date; Last Updated is the closest
    // proxy for done tickets and matches what the existing sync writes.
    completed_date: status === 'done' && lastEdited ? lastEdited.split('T')[0] : null,
    created_by: null,
    notion_page_id: page.id,
    action_item_id: actionItemId,
  };
}

// Map a Notion page → dashboard-shape action_item, or null if the page isn't
// an action item. Action items in Notion are identified by Action Item ID set.
function notionPageToActionItem(page) {
  const props = page.properties || {};
  const actionItemId = readProp(props, 'Action Item ID', 'number');
  if (actionItemId == null) return null;

  const status = STATUS_NOTION_TO_DASH[readProp(props, 'Status', 'status')];
  return {
    id: actionItemId,
    title: readProp(props, 'Ticket', 'title') || '',
    description: '',
    // Notion has no urgency property; default safely.
    urgency: 'this_month',
    priority: 50,
    tools_to_use: null,
    status: status === 'done' ? 'done' : (status === 'in_progress' ? 'in_progress' : 'pending'),
    completed_at: null,
    ticket_id: page.id,
    created_at: readProp(props, 'Created', 'created_time'),
  };
}

async function fetchAllPages({ apiKey, dbId, pageCap = 50 }) {
  const out = [];
  let cursor;
  for (let i = 0; i < pageCap; i++) {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const r = await fetch(`${NOTION_API}/databases/${dbId}/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      const err = new Error(`notion query failed: ${r.status} ${j.code || ''} ${j.message || ''}`);
      err.status = r.status;
      throw err;
    }
    const j = await r.json();
    out.push(...(j.results || []));
    if (!j.has_more) return out;
    cursor = j.next_cursor;
  }
  throw new Error(`notion query exceeded ${pageCap} page cap`);
}

// 60-second cache + single-flight coalescing. Concurrent same-key requests
// share one in-flight promise; the resolved value caches for CACHE_TTL_MS.
// On error: surfaces the error to the caller, but leaves any prior cached
// value in place so callers can opt to serve stale.
async function withCache(key, factory) {
  const now = Date.now();
  const hit = _cache.get(key);
  if (hit && now < hit.expiresAt) return { data: hit.data, stale: false };

  if (_inflight.has(key)) {
    const data = await _inflight.get(key);
    return { data, stale: false };
  }

  const p = factory()
    .then(data => {
      _cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
      _inflight.delete(key);
      return data;
    })
    .catch(err => {
      _inflight.delete(key);
      throw err;
    });
  _inflight.set(key, p);
  const data = await p;
  return { data, stale: false };
}

// Like withCache but returns stale data on factory error if any cache entry
// exists. Used by route handlers so a Notion outage downgrades to stale-serve
// rather than 5xx.
async function withCacheTolerant(key, factory) {
  try {
    return await withCache(key, factory);
  } catch (err) {
    const stale = _cache.get(key);
    if (stale) return { data: stale.data, stale: true, error: err };
    throw err;
  }
}

function makeAdapter(getEnv = () => process.env) {
  const env = () => getEnv();

  function ensureCreds() {
    const e = env();
    if (!e.NOTION_API_KEY) throw new Error('NOTION_API_KEY not configured');
    if (!e.NOTION_TICKETS_DB_ID) throw new Error('NOTION_TICKETS_DB_ID not configured');
    return { apiKey: e.NOTION_API_KEY, dbId: e.NOTION_TICKETS_DB_ID };
  }

  async function _listAllPages() {
    const { apiKey, dbId } = ensureCreds();
    return withCacheTolerant(`pages:${dbId}`, () => fetchAllPages({ apiKey, dbId }));
  }

  async function listTickets(filters = {}) {
    const { data: pages, stale } = await _listAllPages();
    let tickets = pages.map(notionPageToTicket);

    // Server-side-equivalent filters from /api/tickets contract
    if (filters.status) tickets = tickets.filter(t => t.status === filters.status);
    if (filters.priority) tickets = tickets.filter(t => t.priority === filters.priority);
    if (filters.ticket_type) tickets = tickets.filter(t => t.ticket_type === filters.ticket_type);
    if (filters.category) tickets = tickets.filter(t => t.category === filters.category);
    if (filters.assigned_to) tickets = tickets.filter(t => t.assigned_to === filters.assigned_to);
    if (filters.client_id) tickets = tickets.filter(t => t.client_id === filters.client_id);
    if (filters.project_id) tickets = tickets.filter(t => t.project_id === filters.project_id);
    if (filters.notion_unsynced === '1') tickets = tickets.filter(t => t.category === 'action' && !t.notion_page_id);

    // Match SQLite ORDER BY: priority bucket, then created_at DESC.
    // sort_order doesn't exist in Notion, so it drops out of the sort.
    const PRIO = { urgent: 0, high: 1, medium: 2, low: 3 };
    tickets.sort((a, b) => {
      const pd = (PRIO[a.priority] ?? 9) - (PRIO[b.priority] ?? 9);
      if (pd !== 0) return pd;
      return (b.created_at || '').localeCompare(a.created_at || '');
    });

    return { tickets, stale };
  }

  async function listActionItems(filters = {}) {
    const { data: pages, stale } = await _listAllPages();
    let items = pages.map(notionPageToActionItem).filter(Boolean);
    if (filters.urgency) items = items.filter(i => i.urgency === filters.urgency);
    if (filters.status) items = items.filter(i => i.status === filters.status);
    items.sort((a, b) => (a.priority || 50) - (b.priority || 50));
    return { items, stale };
  }

  async function getTicket(idOrKey) {
    const { tickets, stale } = await listTickets();
    const ticket = tickets.find(t => t.id === idOrKey || t.ticket_key === idOrKey) || null;
    return { ticket, stale };
  }

  async function summary() {
    const { tickets, stale } = await listTickets();
    const today = new Date().toISOString().split('T')[0];
    const weekAgo = new Date(Date.now() - 7 * 86400 * 1000).toISOString().split('T')[0];

    const counts = (key) => {
      const out = {};
      for (const t of tickets) {
        const v = t[key];
        if (!v) continue;
        out[v] = (out[v] || 0) + 1;
      }
      return Object.entries(out).map(([k, count]) => ({ [key]: k, count }));
    };

    return {
      summary: {
        byStatus: counts('status'),
        byPriority: counts('priority'),
        byType: counts('ticket_type'),
        overdue: tickets.filter(t => t.due_date && t.due_date < today && t.status !== 'done' && t.status !== 'cancelled').length,
        completedThisWeek: tickets.filter(t => t.completed_date && t.completed_date >= weekAgo).length,
        total: tickets.length,
        open: tickets.filter(t => t.status !== 'done' && t.status !== 'cancelled').length,
      },
      stale,
    };
  }

  function invalidate() {
    _cache.clear();
    _inflight.clear();
  }

  return { listTickets, listActionItems, getTicket, summary, invalidate };
}

const _default = makeAdapter();

module.exports = {
  // Default-instance API (used by server.js routes)
  listTickets: (filters) => _default.listTickets(filters),
  listActionItems: (filters) => _default.listActionItems(filters),
  getTicket: (idOrKey) => _default.getTicket(idOrKey),
  summary: () => _default.summary(),
  invalidate: () => _default.invalidate(),

  // Factory + pure mappers exposed for tests with custom env / fixtures
  makeAdapter,
  notionPageToTicket,
  notionPageToActionItem,
};
