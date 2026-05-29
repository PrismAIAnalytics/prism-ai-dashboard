// syncTasks.test.js
//
// T-059 regression suite. Locks the gate that prevents `scripts/sync-tasks.js`
// from double-creating Notion pages on every run when the dashboard is in
// Notion-as-source mode (`USE_NOTION_SOURCE=true`).
//
// Bug history: between 2026-05-19 and 2026-05-22 three sync-tasks.js runs
// created 93 orphan Notion pages (~31 per run) because the dashboard POST
// path in main() was not idempotent — `getDashboardTickets` filtered by the
// `task-md` tag, but Notion-sourced pages don't carry that tag, so every run
// took the create branch. Cleanup archived all 93. This suite ensures the
// fix doesn't regress: in 'notion-only' mode the dashboard write path is
// never reached.
//
// Pure unit tests over the exported helpers — no Notion API, no dashboard
// API, no env vars touched globally. Run with `npm test`.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { getEffectiveMode, processTask } = require('../scripts/sync-tasks');

// ─── getEffectiveMode predicate ────────────────────────────────────────────
// The gate is a strict equality against the string 'true'. Anything else
// (including 'TRUE', 'True', '1', true, undefined, '') keeps the script in
// pre-cutover dual-write mode. Matches how `services/notionAdapter.js`
// reads the same env var — they MUST stay in lock-step or the dashboard
// will read from Notion while the script writes to the dashboard, which is
// exactly the bug T-059 closes.

test('getEffectiveMode returns notion-only when USE_NOTION_SOURCE="true"', () => {
  assert.strictEqual(getEffectiveMode({ USE_NOTION_SOURCE: 'true' }), 'notion-only');
});

test('getEffectiveMode returns dual-write when USE_NOTION_SOURCE is unset', () => {
  assert.strictEqual(getEffectiveMode({}), 'dual-write');
});

test('getEffectiveMode returns dual-write when USE_NOTION_SOURCE="false"', () => {
  assert.strictEqual(getEffectiveMode({ USE_NOTION_SOURCE: 'false' }), 'dual-write');
});

test('getEffectiveMode returns dual-write on truthy-but-not-"true" values (case sensitive)', () => {
  assert.strictEqual(getEffectiveMode({ USE_NOTION_SOURCE: 'TRUE' }), 'dual-write');
  assert.strictEqual(getEffectiveMode({ USE_NOTION_SOURCE: 'True' }), 'dual-write');
  assert.strictEqual(getEffectiveMode({ USE_NOTION_SOURCE: '1' }), 'dual-write');
  assert.strictEqual(getEffectiveMode({ USE_NOTION_SOURCE: 'yes' }), 'dual-write');
});

// ─── processTask in notion-only mode ───────────────────────────────────────
// The contract this suite enforces: in 'notion-only' mode, only
// deps.upsertNotionPage runs. Calling upsertDashboardTicket or
// linkBackDashboard from this code path is the bug.

function makeDeps(overrides = {}) {
  const calls = [];
  return {
    calls,
    upsertDashboardTicket: async (task, existing) => {
      calls.push({ fn: 'upsertDashboardTicket', taskId: task.id, hadExisting: !!existing });
      return overrides.dashResult || { ticket: { id: 'dash-1', ticket_key: 'TKT-0001' }, action: 'created' };
    },
    upsertNotionPage: async (task, existing, dashKey) => {
      calls.push({ fn: 'upsertNotionPage', taskId: task.id, hadExisting: !!existing, dashKey });
      return overrides.notionResult || { page: { id: 'notion-page-1' }, action: 'created' };
    },
    linkBackDashboard: async (dashboardId, notionPageId) => {
      calls.push({ fn: 'linkBackDashboard', dashboardId, notionPageId });
    },
  };
}

const T = (id = 'T-001', status = 'Up Next') => ({
  id, title: `${id} title`, status, notes: 'sample notes', mergeSha: null,
});

test('processTask in notion-only mode skips upsertDashboardTicket entirely', async () => {
  const deps = makeDeps();
  await processTask({
    task: T(),
    mode: 'notion-only',
    dryRun: false,
    deps,
    dashTickets: new Map(),
    notionPages: new Map(),
  });
  const fns = deps.calls.map(c => c.fn);
  assert.deepStrictEqual(fns, ['upsertNotionPage']);
});

test('processTask in notion-only mode skips linkBackDashboard even when a Notion page is created', async () => {
  const deps = makeDeps({ notionResult: { page: { id: 'fresh-notion-id' }, action: 'created' } });
  await processTask({
    task: T(),
    mode: 'notion-only',
    dryRun: false,
    deps,
    dashTickets: new Map(),
    notionPages: new Map(),
  });
  assert.ok(!deps.calls.some(c => c.fn === 'linkBackDashboard'),
    'linkBackDashboard must never run in notion-only mode');
});

test('processTask in notion-only mode passes empty dashKey to upsertNotionPage', async () => {
  const deps = makeDeps();
  await processTask({
    task: T(),
    mode: 'notion-only',
    dryRun: false,
    deps,
    dashTickets: new Map(),
    notionPages: new Map(),
  });
  const notionCall = deps.calls.find(c => c.fn === 'upsertNotionPage');
  assert.strictEqual(notionCall.dashKey, '');
});

test('processTask in notion-only mode reports SKIPPED overall when Notion upsert skips', async () => {
  const deps = makeDeps({ notionResult: { page: { id: 'n1' }, action: 'skipped' } });
  const result = await processTask({
    task: T(),
    mode: 'notion-only',
    dryRun: false,
    deps,
    dashTickets: new Map(),
    notionPages: new Map(),
  });
  assert.strictEqual(result.overall, 'SKIPPED');
  assert.strictEqual(result.dashResult.action, 'skipped');
});

// Idempotency proof — two consecutive runs over the same task list with an
// existing Notion page (T-ID match) produce zero dashboard writes and one
// Notion upsert per run (which itself short-circuits to 'skipped' via the
// real notionPageDiffers check; mocked here as a no-diff 'skipped' result).
// This is the test that directly proves the bug is fixed.
test('processTask in notion-only mode produces zero dashboard writes across two runs', async () => {
  const deps = makeDeps({ notionResult: { page: { id: 'existing-id' }, action: 'skipped' } });
  const notionPages = new Map([['T-001', { id: 'existing-id', properties: {} }]]);
  for (let i = 0; i < 2; i++) {
    await processTask({
      task: T(),
      mode: 'notion-only',
      dryRun: false,
      deps,
      dashTickets: new Map(),
      notionPages,
    });
  }
  const dashCalls = deps.calls.filter(c =>
    c.fn === 'upsertDashboardTicket' || c.fn === 'linkBackDashboard'
  );
  assert.strictEqual(dashCalls.length, 0,
    `expected 0 dashboard writes across 2 runs, got ${dashCalls.length}: ${JSON.stringify(dashCalls)}`);
});

// ─── processTask in dual-write mode (pre-cutover behavior preserved) ───────

test('processTask in dual-write mode calls upsertDashboardTicket and upsertNotionPage', async () => {
  const deps = makeDeps();
  await processTask({
    task: T(),
    mode: 'dual-write',
    dryRun: false,
    deps,
    dashTickets: new Map(),
    notionPages: new Map(),
  });
  const fns = deps.calls.map(c => c.fn);
  assert.deepStrictEqual(fns, ['upsertDashboardTicket', 'upsertNotionPage', 'linkBackDashboard']);
});

test('processTask in dual-write mode passes dashKey from upsertDashboardTicket to upsertNotionPage', async () => {
  const deps = makeDeps({
    dashResult: { ticket: { id: 'dash-42', ticket_key: 'TKT-0042' }, action: 'created' },
  });
  await processTask({
    task: T(),
    mode: 'dual-write',
    dryRun: false,
    deps,
    dashTickets: new Map(),
    notionPages: new Map(),
  });
  const notionCall = deps.calls.find(c => c.fn === 'upsertNotionPage');
  assert.strictEqual(notionCall.dashKey, 'TKT-0042');
});

test('processTask in dual-write mode skips linkBackDashboard when dryRun=true', async () => {
  const deps = makeDeps();
  await processTask({
    task: T(),
    mode: 'dual-write',
    dryRun: true,
    deps,
    dashTickets: new Map(),
    notionPages: new Map(),
  });
  assert.ok(!deps.calls.some(c => c.fn === 'linkBackDashboard'),
    'linkBackDashboard must not run when dryRun=true');
});

test('processTask in dual-write mode skips linkBackDashboard when existingDash already has matching notion_page_id', async () => {
  const deps = makeDeps({
    dashResult: { ticket: { id: 'dash-7', ticket_key: 'TKT-0007', notion_page_id: 'notion-page-1' }, action: 'skipped' },
  });
  const existingDash = { id: 'dash-7', ticket_key: 'TKT-0007', notion_page_id: 'notion-page-1' };
  await processTask({
    task: T(),
    mode: 'dual-write',
    dryRun: false,
    deps,
    dashTickets: new Map([['T-001', existingDash]]),
    notionPages: new Map(),
  });
  assert.ok(!deps.calls.some(c => c.fn === 'linkBackDashboard'),
    'linkBackDashboard must not run when the cross-link already exists');
});

test('processTask in dual-write mode reports CREATED overall when either side creates', async () => {
  const deps = makeDeps({
    dashResult: { ticket: { id: 'd' }, action: 'skipped' },
    notionResult: { page: { id: 'n' }, action: 'created' },
  });
  const result = await processTask({
    task: T(),
    mode: 'dual-write',
    dryRun: false,
    deps,
    dashTickets: new Map(),
    notionPages: new Map(),
  });
  assert.strictEqual(result.overall, 'CREATED');
});
