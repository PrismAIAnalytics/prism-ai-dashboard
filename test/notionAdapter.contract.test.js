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
  ];
  for (const [notion, dash] of cases) {
    const t = notionPageToTicket(makeNotionPage({
      properties: { Status: { type: 'status', status: { name: notion } } },
    }));
    assert.strictEqual(t.status, dash, `Status ${notion} → ${dash}`);
  }
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
