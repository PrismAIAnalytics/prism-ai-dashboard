// inboxRouter.test.js
//
// T-090 audit-defensible ticket bodies. Asserts:
//   - createCapture passes a full Origin body (including untruncated text) to
//     the adapter, not just title + properties
//   - triage(action='ticket') appends a [TRIAGE-EVENT] comment via createComment
//     after the status/source updates land
//   - Comment-create failure during triage does NOT fail the triage itself —
//     the trail is best-effort; losing it is preferable to losing the triage
//
// Pure unit tests with a stubbed adapter — no Notion, no fetch, no Express.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  makeRouter,
  deriveOriginBody,
  TITLE_MAX,
} = require('../services/inboxRouter');

function makeStubAdapter(overrides = {}) {
  const calls = { createTicket: [], updateTicket: [], createComment: [], archiveTicket: [] };
  return {
    calls,
    createTicket: async (input) => {
      calls.createTicket.push(input);
      return { id: 'page-uuid-stub', title: input.title };
    },
    updateTicket: async (pageId, updates) => {
      calls.updateTicket.push({ pageId, updates });
      return { id: pageId, ...updates };
    },
    createComment: async (pageId, input) => {
      calls.createComment.push({ pageId, input });
      return { id: 'comment-uuid', ...input };
    },
    archiveTicket: async (pageId) => {
      calls.archiveTicket.push(pageId);
      return { ok: true, archived: true, page_id: pageId };
    },
    listTickets: async () => ({ tickets: [], stale: false }),
    ...overrides,
  };
}

// ─── deriveOriginBody — the canonical Origin block shape ────────────────────

test('deriveOriginBody includes all four Origin fields + full untruncated text', () => {
  const longText = 'A'.repeat(TITLE_MAX + 200); // longer than title cap
  const body = deriveOriginBody(longText, 'michele', '2026-05-28T13:45:00Z');
  assert.match(body, /^### Origin$/m);
  assert.match(body, /- Created by: michele/);
  assert.match(body, /- Captured at: 2026-05-28T13:45:00Z/);
  assert.match(body, /- Source surface: Dashboard Inbox/);
  assert.ok(body.includes(longText), 'full untruncated original text is present in body');
});

test('deriveOriginBody falls back to "unattributed" when capturedBy is null/empty', () => {
  for (const who of [null, undefined, '', '   ']) {
    const body = deriveOriginBody('asdf', who, '2026-05-28T00:00:00Z');
    assert.match(body, /- Created by: unattributed/, `who=${JSON.stringify(who)}`);
  }
});

test('deriveOriginBody appends an empty Trail section so future events anchor consistently', () => {
  const body = deriveOriginBody('hello', 'm', '2026-05-28T00:00:00Z');
  assert.match(body, /^### Trail$/m);
});

// ─── createCapture passes body to adapter ───────────────────────────────────

test('createCapture passes a body field containing the Origin block to adapter.createTicket', async () => {
  const adapter = makeStubAdapter();
  const router = makeRouter(adapter);
  await router.createCapture('first line\nsecond line with details', 'michele');
  assert.strictEqual(adapter.calls.createTicket.length, 1);
  const input = adapter.calls.createTicket[0];
  assert.strictEqual(input.title, 'first line');
  assert.ok(typeof input.body === 'string', 'body is a string');
  assert.match(input.body, /### Origin/);
  assert.ok(
    input.body.includes('second line with details'),
    'body carries the untruncated text past the first line',
  );
  assert.match(input.body, /- Created by: michele/);
});

test('createCapture body carries the full text when input exceeds the title cap', async () => {
  const adapter = makeStubAdapter();
  const router = makeRouter(adapter);
  const longText = 'X'.repeat(TITLE_MAX + 500);
  await router.createCapture(longText, 'm');
  const input = adapter.calls.createTicket[0];
  // Title is truncated as before.
  assert.ok(input.title.length <= TITLE_MAX, 'title respects TITLE_MAX');
  // Body has the full untruncated original.
  assert.ok(input.body.includes(longText), 'body has the untruncated original');
});

// ─── triage(action='ticket') appends [TRIAGE-EVENT] comment ─────────────────

test('triage promote-to-ticket appends a [TRIAGE-EVENT] comment with category + due_date', async () => {
  const adapter = makeStubAdapter();
  const router = makeRouter(adapter);
  await router.triage('page-uuid-stub', 'ticket', {
    category: 'engineering',
    due_date: '2026-06-01',
    triaged_by: 'michele',
  });
  assert.strictEqual(adapter.calls.updateTicket.length, 1, 'updateTicket called once');
  assert.strictEqual(adapter.calls.createComment.length, 1, 'createComment called once');
  const { pageId, input } = adapter.calls.createComment[0];
  assert.strictEqual(pageId, 'page-uuid-stub');
  assert.match(input.text, /\[TRIAGE-EVENT\]/);
  assert.match(input.text, /michele/);
  assert.match(input.text, /engineering/);
  assert.match(input.text, /2026-06-01/);
});

test('triage promote-to-ticket still leaves a [TRIAGE-EVENT] comment when no category/due_date given', async () => {
  const adapter = makeStubAdapter();
  const router = makeRouter(adapter);
  await router.triage('page-uuid-stub', 'ticket', { triaged_by: 'unattributed' });
  assert.strictEqual(adapter.calls.createComment.length, 1);
  const { input } = adapter.calls.createComment[0];
  assert.match(input.text, /\[TRIAGE-EVENT\]/);
});

test('triage succeeds even if createComment throws (trail is best-effort)', async () => {
  const adapter = makeStubAdapter({
    createComment: async () => { throw new Error('Notion comment API blew up'); },
  });
  const router = makeRouter(adapter);
  const result = await router.triage('page-uuid-stub', 'ticket', { category: 'admin' });
  assert.strictEqual(result.ok, true, 'triage did not throw');
  assert.strictEqual(result.action, 'ticket');
});

test('triage dismiss does NOT post a [TRIAGE-EVENT] comment (only promotion writes one)', async () => {
  const adapter = makeStubAdapter();
  const router = makeRouter(adapter);
  await router.triage('page-uuid-stub', 'dismiss');
  assert.strictEqual(adapter.calls.createComment.length, 0);
  assert.strictEqual(adapter.calls.archiveTicket.length, 1);
});
