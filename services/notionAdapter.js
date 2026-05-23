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

// ─── Write-direction maps (T-026 Phase 4) ──────────────────────────────────
// Mirror the read-direction maps. SQLite-only statuses (`todo`, `review`,
// `cancelled`) collapse to the closest Notion equivalent because the Notion
// `Status` property doesn't have those values in the existing schema.
const STATUS_DASH_TO_NOTION = {
  backlog: 'Not started',
  todo: 'Not started',
  in_progress: 'In progress',
  review: 'In progress',
  blocked: 'Blocked',
  done: 'Done',
  cancelled: 'Done',
};
const PRIORITY_DASH_TO_NOTION = {
  urgent: 'Urgent',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};
const CATEGORY_DASH_TO_NOTION = {
  delivery: 'Client Work',
  engineering: 'CRM Development',
  marketing: 'Marketing',
  admin: 'Admin',
  sales: 'Sales & Outreach',
  content: 'Content',
  finance: 'Finance',
  training: 'Training',
  prism_studio: 'Prism Studio',
  action: 'Admin', // action items file under Admin per established convention
};

// Build a Notion properties patch object from dashboard-shape fields. Used by
// both create (full payload) and update (sparse — only changed fields). Fields
// without a Notion equivalent in the DB schema (description, ticket_type,
// assigned_to/team_members.id, project_id, tags, urgency, tools_to_use) are
// silently dropped here — Phase 5 either ports them into Notion page bodies
// or accepts the data loss when the SQLite tables go away.
function dashboardToNotionProperties(input) {
  const props = {};
  if (input.title !== undefined && input.title !== null) {
    props['Ticket'] = { title: [{ text: { content: String(input.title) } }] };
  }
  if (input.status !== undefined) {
    const v = STATUS_DASH_TO_NOTION[input.status];
    if (v) props['Status'] = { status: { name: v } };
  }
  if (input.priority !== undefined) {
    const v = PRIORITY_DASH_TO_NOTION[input.priority];
    if (v) props['Priority'] = { select: { name: v } };
  }
  if (input.category !== undefined) {
    const v = CATEGORY_DASH_TO_NOTION[input.category];
    if (v) props['Category'] = { select: { name: v } };
  }
  if (input.due_date !== undefined) {
    props['Due Date'] = input.due_date
      ? { date: { start: input.due_date } }
      : { date: null };
  }
  if (input.client_name !== undefined && input.client_name) {
    props['Client'] = { rich_text: [{ text: { content: String(input.client_name) } }] };
  }
  if (input.source !== undefined && input.source) {
    props['Source'] = { rich_text: [{ text: { content: String(input.source) } }] };
  }
  // T-057: optional "Captured By" attribution for Idea Vault captures. Property
  // must exist in the Notion DB schema as rich_text; if absent, createTicket
  // retries without it (see createTicket below) so missing-schema is safe.
  if (input.captured_by !== undefined && input.captured_by !== null && input.captured_by !== '') {
    props['Captured By'] = { rich_text: [{ text: { content: String(input.captured_by) } }] };
  }
  if (input.dashboard_ticket_id !== undefined && input.dashboard_ticket_id) {
    props['Dashboard Ticket ID'] = { rich_text: [{ text: { content: String(input.dashboard_ticket_id) } }] };
  }
  if (input.action_item_id !== undefined && input.action_item_id !== null) {
    props['Action Item ID'] = { number: input.action_item_id };
  }
  return props;
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
  // T-037: expose raw Notion Source property so source_prefix filter can match
  // free-form source strings (e.g. 'cowork:inbox') that don't show up in the
  // derived `source` categorical above.
  const sourceRaw = readProp(props, 'Source', 'rich_text');

  return {
    // Notion page UUID is the canonical id; matches the existing notion_page_id
    // value already stored on dashboard tickets via T-019.
    id: page.id,
    ticket_key,
    source,
    source_raw: sourceRaw,
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
    // T-057: Captured By attribution for Idea Vault items (null if property
    // doesn't exist in the schema or wasn't set on the page).
    captured_by: readProp(props, 'Captured By', 'rich_text'),
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

// ─── Write API (T-026 Phase 4) ─────────────────────────────────────────────
// Thin wrappers around Notion's pages endpoint. Each surfaces a structured
// Error on non-2xx so the caller can map back to HTTP status.
async function notionCreatePage({ apiKey, dbId, properties }) {
  const r = await fetch(`${NOTION_API}/pages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ parent: { database_id: dbId }, properties }),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    const err = new Error(`notion create failed: ${r.status} ${j.code || ''} ${j.message || ''}`);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

async function notionUpdatePage({ apiKey, pageId, properties }) {
  const r = await fetch(`${NOTION_API}/pages/${pageId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ properties }),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    const err = new Error(`notion update failed: ${r.status} ${j.code || ''} ${j.message || ''}`);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

async function notionGetPage({ apiKey, pageId }) {
  const r = await fetch(`${NOTION_API}/pages/${pageId}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Notion-Version': NOTION_VERSION,
    },
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    const err = new Error(`notion get failed: ${r.status} ${j.code || ''} ${j.message || ''}`);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

async function notionArchivePage({ apiKey, pageId }) {
  const r = await fetch(`${NOTION_API}/pages/${pageId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ archived: true }),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    const err = new Error(`notion archive failed: ${r.status} ${j.code || ''} ${j.message || ''}`);
    err.status = r.status;
    throw err;
  }
  return r.json();
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
    // T-037: prefix-match against raw Notion Source property. Used by inbox
    // captures (`cowork:inbox`) and any future Cowork sub-streams.
    if (filters.source_prefix) {
      const prefix = String(filters.source_prefix);
      tickets = tickets.filter(t => t.source_raw && t.source_raw.startsWith(prefix));
    }

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
        byCategory: counts('category'),
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

  // ─── Writes (T-026 Phase 4) ──────────────────────────────────────────────
  // All writes invalidate the read cache so the next list/summary reflects
  // the mutation. Notion's eventual-consistency window is typically <1s, so
  // an immediate re-read after a write usually sees the change.

  async function createTicket(input) {
    const { apiKey, dbId } = ensureCreds();
    const properties = dashboardToNotionProperties(input);
    if (!properties['Ticket']) {
      const e = new Error('createTicket: title is required');
      e.status = 400;
      throw e;
    }
    try {
      const page = await notionCreatePage({ apiKey, dbId, properties });
      invalidate();
      return notionPageToTicket(page);
    } catch (e) {
      // T-057 fallback: if the create failed because "Captured By" doesn't
      // exist in the Notion schema yet, retry without it. Lets us ship the
      // code before Michele adds the property in the Notion UI; once the
      // property exists, attribution starts working automatically with no
      // code change.
      const msg = String(e.message || '');
      if (properties['Captured By'] && e.status === 400 && /Captured By/.test(msg)) {
        const { 'Captured By': _omit, ...rest } = properties;
        console.warn('[notionAdapter] createTicket: "Captured By" property not in Notion schema; retrying without it. Add the property in Notion to enable user attribution.');
        const page = await notionCreatePage({ apiKey, dbId, properties: rest });
        invalidate();
        return notionPageToTicket(page);
      }
      throw e;
    }
  }

  async function updateTicket(pageId, updates) {
    const { apiKey } = ensureCreds();
    const properties = dashboardToNotionProperties(updates);
    // Empty properties = caller-supplied fields all have no Notion equivalent in
    // this schema (description, tags, notion_page_id, ticket_type, etc.). In
    // Notion-source mode notion_page_id is identity and description has no
    // mapped property, so these are legitimate no-ops rather than 400-worthy.
    // Return the current page state so callers (sync-tasks linkBack,
    // business-health-eval progress_update) get a sane 200 response.
    if (Object.keys(properties).length === 0) {
      const page = await notionGetPage({ apiKey, pageId });
      return notionPageToTicket(page);
    }
    const page = await notionUpdatePage({ apiKey, pageId, properties });
    invalidate();
    return notionPageToTicket(page);
  }

  async function archiveTicket(pageId) {
    const { apiKey } = ensureCreds();
    await notionArchivePage({ apiKey, pageId });
    invalidate();
    return { ok: true, archived: true, page_id: pageId };
  }

  // Action items share the same Notion database as tickets — the only
  // distinguisher is the `Action Item ID` numeric property being set.
  // The caller passes action_item_id; the adapter writes it to the page.
  async function createActionItem(input) {
    const { apiKey, dbId } = ensureCreds();
    const properties = dashboardToNotionProperties({
      title: input.title,
      status: input.status || 'backlog',
      category: 'action',
      due_date: input.due_date,
      action_item_id: input.action_item_id,
    });
    if (!properties['Ticket']) {
      const e = new Error('createActionItem: title is required');
      e.status = 400;
      throw e;
    }
    const page = await notionCreatePage({ apiKey, dbId, properties });
    invalidate();
    return notionPageToActionItem(page) || notionPageToTicket(page);
  }

  async function updateActionItem(pageId, updates) {
    const { apiKey } = ensureCreds();
    const properties = dashboardToNotionProperties({
      title: updates.title,
      status: updates.status,
      action_item_id: updates.action_item_id,
    });
    // Same no-op semantics as updateTicket — see comment there. Action items
    // share the underlying Notion page, so unmappable-fields-only updates
    // (urgency, priority numeric, tools_to_use, completed_at) return current
    // state rather than 400.
    if (Object.keys(properties).length === 0) {
      const page = await notionGetPage({ apiKey, pageId });
      return notionPageToActionItem(page) || notionPageToTicket(page);
    }
    const page = await notionUpdatePage({ apiKey, pageId, properties });
    invalidate();
    return notionPageToActionItem(page) || notionPageToTicket(page);
  }

  async function archiveActionItem(pageId) {
    const { apiKey } = ensureCreds();
    await notionArchivePage({ apiKey, pageId });
    invalidate();
    return { ok: true, archived: true, page_id: pageId };
  }

  return {
    listTickets, listActionItems, getTicket, summary, invalidate,
    createTicket, updateTicket, archiveTicket,
    createActionItem, updateActionItem, archiveActionItem,
  };
}

const _default = makeAdapter();

module.exports = {
  // Default-instance API (used by server.js routes)
  listTickets: (filters) => _default.listTickets(filters),
  listActionItems: (filters) => _default.listActionItems(filters),
  getTicket: (idOrKey) => _default.getTicket(idOrKey),
  summary: () => _default.summary(),
  invalidate: () => _default.invalidate(),

  // Write API (T-026 Phase 4)
  createTicket: (input) => _default.createTicket(input),
  updateTicket: (pageId, updates) => _default.updateTicket(pageId, updates),
  archiveTicket: (pageId) => _default.archiveTicket(pageId),
  createActionItem: (input) => _default.createActionItem(input),
  updateActionItem: (pageId, updates) => _default.updateActionItem(pageId, updates),
  archiveActionItem: (pageId) => _default.archiveActionItem(pageId),

  // Factory + pure mappers exposed for tests with custom env / fixtures
  makeAdapter,
  notionPageToTicket,
  notionPageToActionItem,
  dashboardToNotionProperties,
};
