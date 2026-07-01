// notionAdapter.contract.test.js
//
// T-023 Phase 1 contract test. Asserts every field the dashboard frontend reads
// from /api/tickets, /api/tickets/summary, and /api/actions is present in the
// notionAdapter's output. Field inventory derived from grep of public/index.html
// — see the "Required ticket fields" / "Required action_item fields" arrays below.
//
// Pure-mapper tests (no network). Run with `node --test test/`. Node 18+ has
// node:test built in; no Jest/Mocha dependency required.
//
// What this test catches:
//   - A field the frontend reads is missing from the adapter's output
//   - A field is present but null when it should have a value
//   - The ticket_key derivation logic regresses (ACT-####, NTN-…, T-…)
//   - The status/priority/category mapping regresses
//
// What this test does NOT catch:
//   - Notion API contract changes (use scripts/inspect-notion-schema.js)
//   - End-to-end response-shape parity vs the SQLite path (smoke test does that)

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { notionPageToTicket, notionPageToActionItem, makeAdapter } = require('../services/notionAdapter');

// Field inventory — every key the frontend reads from a ticket object across
// public/index.html (table rows, kanban cards, editable modal, read-only modal).
const REQUIRED_TICKET_FIELDS = [
  'id',
  'ticket_key',
  'source',
  'title',
  'description',
  'ticket_type',
  'category',
  'status',
  'priority',
  'assigned_to',
  'assignee_name',
  'client_id',
  'client_name',
  'project_id',
  'project_name',
  'due_date',
  'tags',
  'sort_order',
  'created_at',
  'updated_at',
  'completed_date',
  'created_by',
  'notion_page_id',
  'action_item_id',
];

// Field inventory for action_items — the frontend only reads .status today,
// but we lock the wider shape so /api/actions consumers (scripts, portal)
// don't break silently when Phase 4 cuts writes over.
const REQUIRED_ACTION_ITEM_FIELDS = [
  'id',
  'title',
  'description',
  'urgency',
  'priority',
  'tools_to_use',
  'status',
  'completed_at',
  'ticket_id',
  'created_at',
];

// Builders — produce realistic Notion page fixtures matching the schema dumped
// by scripts/inspect-notion-schema.js on 2026-05-03.
function makeNotionPage(overrides = {}) {
  return {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    properties: {
      Ticket: { type: 'title', title: [{ plain_text: 'Sample ticket' }] },
      Status: { type: 'status', status: { name: 'In progress' } },
      Priority: { type: 'select', select: { name: 'High' } },
      Category: { type: 'select', select: { name: 'CRM Development' } },
      'Due Date': { type: 'date', date: { start: '2026-05-10' } },
      'T-ID': { type: 'rich_text', rich_text: [] },
      'Dashboard Ticket ID': { type: 'rich_text', rich_text: [] },
      'Action Item ID': { type: 'number', number: null },
      Assignee: { type: 'people', people: [{ name: 'Michele Fisher' }] },
      Client: { type: 'rich_text', rich_text: [{ plain_text: 'Prism AI Analytics' }] },
      Source: { type: 'rich_text', rich_text: [{ plain_text: 'Notion' }] },
      Created: { type: 'created_time', created_time: '2026-04-30T12:00:00.000Z' },
      'Last Updated': { type: 'last_edited_time', last_edited_time: '2026-05-01T09:30:00.000Z' },
      ...overrides.properties,
    },
    ...overrides,
  };
}

// ─── Ticket field-presence contract ─────────────────────────────────────────

test('every frontend-required ticket field is present on adapter output', () => {
  const ticket = notionPageToTicket(makeNotionPage());
  for (const field of REQUIRED_TICKET_FIELDS) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(ticket, field),
      `Missing required field: ${field}`
    );
  }
});

test('ticket id is the Notion page UUID', () => {
  const page = makeNotionPage({ id: '12345678-1234-1234-1234-123456789012' });
  const ticket = notionPageToTicket(page);
  assert.strictEqual(ticket.id, '12345678-1234-1234-1234-123456789012');
  assert.strictEqual(ticket.notion_page_id, ticket.id);
});

// ─── ticket_key derivation rules (the ACT-#### prefix the plan calls out) ──

test('ticket_key uses ACT-#### when Action Item ID is set', () => {
  const page = makeNotionPage({
    properties: { 'Action Item ID': { type: 'number', number: 3 } },
  });
  const ticket = notionPageToTicket(page);
  assert.strictEqual(ticket.ticket_key, 'ACT-0003');
  assert.strictEqual(ticket.source, 'action-item');
  assert.strictEqual(ticket.action_item_id, 3);
});

test('ticket_key zero-pads single-digit Action Item IDs', () => {
  const ticket = notionPageToTicket(makeNotionPage({
    properties: { 'Action Item ID': { type: 'number', number: 1 } },
  }));
  assert.strictEqual(ticket.ticket_key, 'ACT-0001');
});

test('ticket_key handles 4-digit Action Item IDs without truncation', () => {
  const ticket = notionPageToTicket(makeNotionPage({
    properties: { 'Action Item ID': { type: 'number', number: 1234 } },
  }));
  assert.strictEqual(ticket.ticket_key, 'ACT-1234');
});

test('ticket_key falls back to Dashboard Ticket ID when no Action Item ID', () => {
  const ticket = notionPageToTicket(makeNotionPage({
    properties: {
      'Dashboard Ticket ID': { type: 'rich_text', rich_text: [{ plain_text: 'TKT-0023' }] },
    },
  }));
  assert.strictEqual(ticket.ticket_key, 'TKT-0023');
  assert.strictEqual(ticket.source, 'manual');
});

test('ticket_key falls back to T-ID for engineering tickets', () => {
  const ticket = notionPageToTicket(makeNotionPage({
    properties: {
      'T-ID': { type: 'rich_text', rich_text: [{ plain_text: 'T-019' }] },
    },
  }));
  assert.strictEqual(ticket.ticket_key, 'T-019');
  assert.strictEqual(ticket.source, 'manual');
});

test('ticket_key derives from page UUID when nothing else is set', () => {
  const ticket = notionPageToTicket(makeNotionPage({
    id: '11111111-2222-3333-4444-555566667777',
  }));
  assert.strictEqual(ticket.ticket_key, 'NTN-66667777');
  assert.strictEqual(ticket.source, 'notion');
});

// ─── Status / priority / category mapping ───────────────────────────────────

test('Notion status names map to dashboard enum values', () => {
  const cases = [
    ['Not started', 'backlog'],
    ['In progress', 'in_progress'],
    ['Blocked', 'blocked'],
    ['Done', 'done'],
    ['Cancelled', 'cancelled'],
  ];
  for (const [notion, dash] of cases) {
    const t = notionPageToTicket(makeNotionPage({
      properties: { Status: { type: 'status', status: { name: notion } } },
    }));
    assert.strictEqual(t.status, dash, `Status ${notion} → ${dash}`);
  }
});

// Cancelled read-map regression guard: before this fix, `Cancelled` had no
// STATUS_NOTION_TO_DASH entry and collapsed to `backlog` via the `|| 'backlog'`
// fallback — the display bug that produced a 22-day phantom brief item.
test('Cancelled maps to cancelled, not backlog', () => {
  const t = notionPageToTicket(makeNotionPage({
    properties: { Status: { type: 'status', status: { name: 'Cancelled' } } },
  }));
  assert.strictEqual(t.status, 'cancelled');
});

// Write-map regression guard: `cancelled` must round-trip back to Notion as
// `Cancelled`, not `Done`. The old map wrote `Done`, silently corrupting the
// Notion source of truth on every cancelled-ticket write.
test('dashboard cancelled writes back to Notion as Cancelled, not Done', () => {
  const props = dashboardToNotionProperties({ status: 'cancelled' });
  assert.strictEqual(props.Status?.status?.name, 'Cancelled');
});

test('Notion priority names map to dashboard enum values', () => {
  const cases = [
    ['Urgent', 'urgent'],
    ['High', 'high'],
    ['Medium', 'medium'],
    ['Low', 'low'],
  ];
  for (const [notion, dash] of cases) {
    const t = notionPageToTicket(makeNotionPage({
      properties: { Priority: { type: 'select', select: { name: notion } } },
    }));
    assert.strictEqual(t.priority, dash, `Priority ${notion} → ${dash}`);
  }
});

test('CRM Development category maps to engineering', () => {
  const t = notionPageToTicket(makeNotionPage());
  assert.strictEqual(t.category, 'engineering');
});

test('AI Bridge and Client Work both map to delivery', () => {
  for (const cat of ['AI Bridge', 'Client Work']) {
    const t = notionPageToTicket(makeNotionPage({
      properties: { Category: { type: 'select', select: { name: cat } } },
    }));
    assert.strictEqual(t.category, 'delivery', `${cat} → delivery`);
  }
});

test('unknown category normalizes to lowercase_with_underscores', () => {
  const t = notionPageToTicket(makeNotionPage({
    properties: { Category: { type: 'select', select: { name: 'Some Random Category' } } },
  }));
  assert.strictEqual(t.category, 'some_random_category');
});

// ─── Tags follow the T-019 convention so the read-only UI badge works ──────

test('tags include src:notion and notion-page:UUID for the upstream-sourced badge', () => {
  const t = notionPageToTicket(makeNotionPage({ id: 'abc-def' }));
  assert.match(t.tags, /\bsrc:notion\b/);
  assert.match(t.tags, /notion-page:abc-def/);
});

// ─── completed_date is populated only when status='done' ───────────────────

test('completed_date is null for non-done tickets', () => {
  const t = notionPageToTicket(makeNotionPage({
    properties: { Status: { type: 'status', status: { name: 'In progress' } } },
  }));
  assert.strictEqual(t.completed_date, null);
});

test('completed_date derives from Last Updated when status=done', () => {
  const t = notionPageToTicket(makeNotionPage({
    properties: {
      Status: { type: 'status', status: { name: 'Done' } },
      'Last Updated': { type: 'last_edited_time', last_edited_time: '2026-05-02T15:30:00.000Z' },
    },
  }));
  assert.strictEqual(t.completed_date, '2026-05-02');
});

// ─── Action item field-presence contract ───────────────────────────────────

test('every required action_item field is present on adapter output', () => {
  const page = makeNotionPage({
    properties: { 'Action Item ID': { type: 'number', number: 5 } },
  });
  const item = notionPageToActionItem(page);
  for (const field of REQUIRED_ACTION_ITEM_FIELDS) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(item, field),
      `Missing required field: ${field}`
    );
  }
});

test('notionPageToActionItem returns null for non-action pages', () => {
  const item = notionPageToActionItem(makeNotionPage());
  assert.strictEqual(item, null);
});

test('action_item id is the numeric Action Item ID, not the page UUID', () => {
  const item = notionPageToActionItem(makeNotionPage({
    properties: { 'Action Item ID': { type: 'number', number: 42 } },
  }));
  assert.strictEqual(item.id, 42);
});

test('Done Notion status maps to done; In progress maps to in_progress; rest pending', () => {
  const cases = [
    ['Done', 'done'],
    ['In progress', 'in_progress'],
    ['Not started', 'pending'],
    ['Blocked', 'pending'],
  ];
  for (const [notion, expected] of cases) {
    const item = notionPageToActionItem(makeNotionPage({
      properties: {
        'Action Item ID': { type: 'number', number: 1 },
        Status: { type: 'status', status: { name: notion } },
      },
    }));
    assert.strictEqual(item.status, expected, `action_item ${notion} → ${expected}`);
  }
});

// ─── Adapter factory + cache behavior ──────────────────────────────────────

test('makeAdapter throws when NOTION_API_KEY is missing', async () => {
  const adapter = makeAdapter(() => ({ NOTION_TICKETS_DB_ID: 'x' }));
  await assert.rejects(adapter.listTickets(), /NOTION_API_KEY not configured/);
});

test('makeAdapter throws when NOTION_TICKETS_DB_ID is missing', async () => {
  const adapter = makeAdapter(() => ({ NOTION_API_KEY: 'x' }));
  await assert.rejects(adapter.listTickets(), /NOTION_TICKETS_DB_ID not configured/);
});

// ─── Write-direction mapper (T-026 Phase 4) ────────────────────────────────

const { dashboardToNotionProperties } = require('../services/notionAdapter');

test('dashboardToNotionProperties maps title to Ticket title property', () => {
  const p = dashboardToNotionProperties({ title: 'New ticket' });
  assert.deepStrictEqual(p['Ticket'], { title: [{ text: { content: 'New ticket' } }] });
});

test('dashboardToNotionProperties maps the 8-option status vocabulary to Notion status names', () => {
  // Phase 2D schema close-out (2026-05-24), extended with Cancelled (2026-06-11)
  // — the full 8-option Notion Status vocabulary round-trips losslessly. See
  // STATUS_DASH_TO_NOTION at the top of notionAdapter.js for the canonical map.
  const cases = [
    ['backlog', 'Backlog'],
    ['todo', 'To Do'],
    ['in_progress', 'In progress'],
    ['review', 'Review'],
    ['blocked', 'Blocked'],
    ['done', 'Done'],
    ['cancelled', 'Cancelled'], // now round-trips to its own Notion option (was buggily 'Done').
  ];
  for (const [dash, notion] of cases) {
    const p = dashboardToNotionProperties({ status: dash });
    assert.deepStrictEqual(p['Status'], { status: { name: notion } }, `status ${dash} → ${notion}`);
  }
});

test('dashboardToNotionProperties maps urgent/high/medium/low to Notion priority select', () => {
  for (const [dash, notion] of [['urgent', 'Urgent'], ['high', 'High'], ['medium', 'Medium'], ['low', 'Low']]) {
    const p = dashboardToNotionProperties({ priority: dash });
    assert.deepStrictEqual(p['Priority'], { select: { name: notion } }, `priority ${dash} → ${notion}`);
  }
});

test('dashboardToNotionProperties maps category aliases including `action`', () => {
  assert.deepStrictEqual(
    dashboardToNotionProperties({ category: 'engineering' })['Category'],
    { select: { name: 'CRM Development' } },
  );
  assert.deepStrictEqual(
    dashboardToNotionProperties({ category: 'action' })['Category'],
    { select: { name: 'Admin' } },
    'action items file under Admin',
  );
});

test('dashboardToNotionProperties produces Due Date with null when due_date is empty string', () => {
  assert.deepStrictEqual(
    dashboardToNotionProperties({ due_date: '' })['Due Date'],
    { date: null },
  );
});

test('dashboardToNotionProperties drops fields with no Notion equivalent (description/tags/assigned_to)', () => {
  const p = dashboardToNotionProperties({
    title: 'X',
    description: 'long body text',
    tags: 'a,b,c',
    assigned_to: 'team-member-uuid',
  });
  assert.ok(p['Ticket'], 'title kept');
  assert.strictEqual(p['Description'], undefined);
  assert.strictEqual(p['Tags'], undefined);
  assert.strictEqual(p['Assignee'], undefined);
});

test('dashboardToNotionProperties writes Action Item ID as number when provided', () => {
  const p = dashboardToNotionProperties({ action_item_id: 42 });
  assert.deepStrictEqual(p['Action Item ID'], { number: 42 });
});

test('dashboardToNotionProperties returns empty object when no input fields are mappable', () => {
  const p = dashboardToNotionProperties({ description: 'x', tags: 'y' });
  assert.deepStrictEqual(p, {});
});

// ─── Empty-update no-op behavior (T-026a fix) ──────────────────────────────
// Pre-fix, updateTicket/updateActionItem threw "no mappable fields in updates"
// when the caller's update payload only carried fields with no Notion property
// (description, tags, notion_page_id, etc.). That 400 broke sync-tasks.js's
// linkBackDashboard PATCH ({notion_page_id}) and business-health-eval's
// progress_update PATCH ({description}). Both are legitimate no-ops in
// Notion-source mode — the adapter should return the current page state.

function withStubbedFetch(t, handler) {
  const original = global.fetch;
  global.fetch = handler;
  t.after(() => { global.fetch = original; });
}

const stubPage = {
  id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  properties: {
    Ticket: { type: 'title', title: [{ plain_text: 'Existing title' }] },
    Status: { type: 'status', status: { name: 'In progress' } },
    Priority: { type: 'select', select: { name: 'Medium' } },
    Category: { type: 'select', select: { name: 'CRM Development' } },
    'T-ID': { type: 'rich_text', rich_text: [] },
    'Dashboard Ticket ID': { type: 'rich_text', rich_text: [] },
    'Action Item ID': { type: 'number', number: null },
    Created: { type: 'created_time', created_time: '2026-05-22T00:00:00.000Z' },
    'Last Updated': { type: 'last_edited_time', last_edited_time: '2026-05-22T00:00:00.000Z' },
  },
};

test('updateTicket no-ops on empty mappable updates and returns current page state via GET', async (t) => {
  let patchCalled = false;
  let getCalled = false;
  withStubbedFetch(t, async (url, opts) => {
    const method = (opts && opts.method) || 'GET';
    if (method === 'GET' && url.endsWith(`/pages/${stubPage.id}`)) {
      getCalled = true;
      return { ok: true, json: async () => stubPage };
    }
    if (method === 'PATCH') patchCalled = true;
    return { ok: false, status: 500, json: async () => ({}) };
  });

  const adapter = makeAdapter(() => ({ NOTION_API_KEY: 'k', NOTION_TICKETS_DB_ID: 'db' }));
  const ticket = await adapter.updateTicket(stubPage.id, { notion_page_id: stubPage.id });

  assert.strictEqual(patchCalled, false, 'no PATCH should be issued for an empty-mappable update');
  assert.strictEqual(getCalled, true, 'current page state should be fetched');
  assert.strictEqual(ticket.id, stubPage.id);
  assert.strictEqual(ticket.title, 'Existing title');
});

test('updateTicket no-ops when payload only contains description (no Notion equivalent)', async (t) => {
  let patchCalled = false;
  withStubbedFetch(t, async (url, opts) => {
    const method = (opts && opts.method) || 'GET';
    if (method === 'PATCH') patchCalled = true;
    if (method === 'GET') return { ok: true, json: async () => stubPage };
    return { ok: false, status: 500, json: async () => ({}) };
  });
  const adapter = makeAdapter(() => ({ NOTION_API_KEY: 'k', NOTION_TICKETS_DB_ID: 'db' }));
  const ticket = await adapter.updateTicket(stubPage.id, { description: 'refreshed by progress_update' });
  assert.strictEqual(patchCalled, false);
  assert.strictEqual(ticket.id, stubPage.id);
});

test('updateActionItem no-ops on empty mappable updates and returns current page state', async (t) => {
  let patchCalled = false;
  const actionPage = {
    ...stubPage,
    properties: { ...stubPage.properties, 'Action Item ID': { type: 'number', number: 7 } },
  };
  withStubbedFetch(t, async (url, opts) => {
    const method = (opts && opts.method) || 'GET';
    if (method === 'PATCH') patchCalled = true;
    if (method === 'GET') return { ok: true, json: async () => actionPage };
    return { ok: false, status: 500, json: async () => ({}) };
  });

  const adapter = makeAdapter(() => ({ NOTION_API_KEY: 'k', NOTION_TICKETS_DB_ID: 'db' }));
  const item = await adapter.updateActionItem(actionPage.id, { urgency: 'this_month', priority: 50 });

  assert.strictEqual(patchCalled, false, 'no PATCH should be issued for an empty-mappable action-item update');
  assert.strictEqual(item.id, 7, 'returned action item carries the numeric Action Item ID');
});

// ─── summary() exposes byCategory (T-038 — required by snapshot-tickets cron) ───

test('summary() includes byCategory aggregation so snapshot cron can filter dev_insight', async (t) => {
  // Two pages: one engineering, one fake dev-insight (via unknown category that
  // normalizes to dev_insight). We stub the database query endpoint, not the
  // adapter internals, so this exercises the real summary() → counts() flow.
  const pages = [
    {
      id: 'p1',
      properties: {
        Ticket: { type: 'title', title: [{ plain_text: 'A' }] },
        Status: { type: 'status', status: { name: 'In progress' } },
        Priority: { type: 'select', select: { name: 'Medium' } },
        Category: { type: 'select', select: { name: 'CRM Development' } },
        'T-ID': { type: 'rich_text', rich_text: [] },
        'Dashboard Ticket ID': { type: 'rich_text', rich_text: [] },
        'Action Item ID': { type: 'number', number: null },
        Created: { type: 'created_time', created_time: '2026-05-22T00:00:00.000Z' },
        'Last Updated': { type: 'last_edited_time', last_edited_time: '2026-05-22T00:00:00.000Z' },
      },
    },
    {
      id: 'p2',
      properties: {
        Ticket: { type: 'title', title: [{ plain_text: 'B' }] },
        Status: { type: 'status', status: { name: 'Not started' } },
        Priority: { type: 'select', select: { name: 'Low' } },
        Category: { type: 'select', select: { name: 'Dev Insight' } },
        'T-ID': { type: 'rich_text', rich_text: [] },
        'Dashboard Ticket ID': { type: 'rich_text', rich_text: [] },
        'Action Item ID': { type: 'number', number: null },
        Created: { type: 'created_time', created_time: '2026-05-22T00:00:00.000Z' },
        'Last Updated': { type: 'last_edited_time', last_edited_time: '2026-05-22T00:00:00.000Z' },
      },
    },
  ];
  withStubbedFetch(t, async (url, opts) => {
    if (url.includes('/databases/') && opts && opts.method === 'POST') {
      return { ok: true, json: async () => ({ results: pages, has_more: false }) };
    }
    return { ok: false, status: 500, json: async () => ({}) };
  });

  const adapter = makeAdapter(() => ({ NOTION_API_KEY: 'k', NOTION_TICKETS_DB_ID: 'db' }));
  const { summary } = await adapter.summary();
  assert.ok(Array.isArray(summary.byCategory), 'byCategory must be an array');
  const cats = Object.fromEntries(summary.byCategory.map(r => [r.category, r.count]));
  assert.strictEqual(cats.engineering, 1, 'CRM Development → engineering');
  assert.strictEqual(cats.dev_insight, 1, 'Dev Insight → dev_insight (unknown-cat normalization)');
});

// ─── Body content (T-090 audit-defensible tickets) ──────────────────────────
// createTicket accepts an optional `body` string and writes it into Notion
// page children. Backward-compatible: omitted body = no children sent.

const { bodyTextToNotionChildren } = require('../services/notionAdapter');

test('bodyTextToNotionChildren returns [] for null/empty/whitespace', () => {
  assert.deepStrictEqual(bodyTextToNotionChildren(null), []);
  assert.deepStrictEqual(bodyTextToNotionChildren(undefined), []);
  assert.deepStrictEqual(bodyTextToNotionChildren(''), []);
  assert.deepStrictEqual(bodyTextToNotionChildren('   \n  \n'), []);
});

test('bodyTextToNotionChildren produces one paragraph block per line', () => {
  const blocks = bodyTextToNotionChildren('first line\nsecond line');
  assert.strictEqual(blocks.length, 2);
  assert.strictEqual(blocks[0].type, 'paragraph');
  assert.strictEqual(blocks[0].paragraph.rich_text[0].text.content, 'first line');
  assert.strictEqual(blocks[1].paragraph.rich_text[0].text.content, 'second line');
});

test('bodyTextToNotionChildren preserves blank lines as empty paragraphs', () => {
  const blocks = bodyTextToNotionChildren('a\n\nb');
  assert.strictEqual(blocks.length, 3);
  assert.deepStrictEqual(blocks[1].paragraph.rich_text, []);
});

test('bodyTextToNotionChildren chunks lines longer than 2000 chars', () => {
  const longLine = 'x'.repeat(4500);
  const blocks = bodyTextToNotionChildren(longLine);
  assert.strictEqual(blocks.length, 3, '4500 chars → 2000 + 2000 + 500');
  assert.strictEqual(blocks[0].paragraph.rich_text[0].text.content.length, 2000);
  assert.strictEqual(blocks[1].paragraph.rich_text[0].text.content.length, 2000);
  assert.strictEqual(blocks[2].paragraph.rich_text[0].text.content.length, 500);
});

test('createTicket passes body as children on the POST payload', async (t) => {
  let postBody = null;
  withStubbedFetch(t, async (url, opts) => {
    const method = (opts && opts.method) || 'GET';
    if (method === 'POST' && url.endsWith('/pages')) {
      postBody = JSON.parse(opts.body);
      return { ok: true, json: async () => stubPage };
    }
    return { ok: false, status: 500, json: async () => ({}) };
  });
  const adapter = makeAdapter(() => ({ NOTION_API_KEY: 'k', NOTION_TICKETS_DB_ID: 'db' }));
  await adapter.createTicket({
    title: 'X',
    body: 'Origin block line 1\nOrigin block line 2',
  });
  assert.ok(postBody, 'POST was issued');
  assert.ok(Array.isArray(postBody.children), 'children array is present');
  assert.strictEqual(postBody.children.length, 2);
  assert.strictEqual(
    postBody.children[0].paragraph.rich_text[0].text.content,
    'Origin block line 1',
  );
});

test('createTicket omits children when body is not provided (backward-compat)', async (t) => {
  let postBody = null;
  withStubbedFetch(t, async (url, opts) => {
    const method = (opts && opts.method) || 'GET';
    if (method === 'POST' && url.endsWith('/pages')) {
      postBody = JSON.parse(opts.body);
      return { ok: true, json: async () => stubPage };
    }
    return { ok: false, status: 500, json: async () => ({}) };
  });
  const adapter = makeAdapter(() => ({ NOTION_API_KEY: 'k', NOTION_TICKETS_DB_ID: 'db' }));
  await adapter.createTicket({ title: 'X' });
  assert.ok(postBody, 'POST was issued');
  assert.strictEqual(postBody.children, undefined, 'children key absent');
});

test('updateTicket still PATCHes when at least one field is mappable', async (t) => {
  let patchCalled = false;
  let patchBody = null;
  withStubbedFetch(t, async (url, opts) => {
    const method = (opts && opts.method) || 'GET';
    if (method === 'PATCH') {
      patchCalled = true;
      patchBody = JSON.parse(opts.body);
      return { ok: true, json: async () => stubPage };
    }
    return { ok: false, status: 500, json: async () => ({}) };
  });
  const adapter = makeAdapter(() => ({ NOTION_API_KEY: 'k', NOTION_TICKETS_DB_ID: 'db' }));
  await adapter.updateTicket(stubPage.id, { status: 'done', description: 'ignored' });
  assert.strictEqual(patchCalled, true);
  assert.deepStrictEqual(patchBody.properties['Status'], { status: { name: 'Done' } });
});
