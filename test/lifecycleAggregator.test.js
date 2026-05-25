// lifecycleAggregator.test.js — T-076 unit tests.
//
// Pure-function coverage of the workstream collapse, 5×5 matrix bucketing,
// retired filter, iteration depth, median computation, and shipPlan precondition
// gates. Network-dependent paths (Notion fetch) are exercised with a stub
// notionAdapter so tests run offline.
//
// Run with `node --test test/`.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const lifecycleAggregator = require('../services/lifecycleAggregator');
const plansAggregator = require('../services/plansAggregator');

// ─── Stub notionAdapter ──────────────────────────────────────────────────
function makeStubAdapter(tickets) {
  return {
    listTickets: async () => ({ tickets }),
  };
}

// Common fixture: tickets covering all five collapsed workstreams + an Admin
// ticket that should NOT appear in the heatmap.
const FIXTURE_TICKETS = [
  { title: 'T-036: Mission Control Phase 1', status: 'done', category: 'engineering' },
  { title: 'T-037: Mission Control inbox',  status: 'done', category: 'engineering' },
  { title: 'T-023: Notion-as-source P1',    status: 'done', category: 'engineering' },
  { title: 'SOC-005: Founder Journey kick', status: 'in_progress', category: 'marketing' },
  { title: 'PS-057: Solopreneur OS landing', status: 'blocked', category: 'prism_studio' },
  { title: 'CW-001: Client onboarding doc',  status: 'done', category: 'delivery' },
  { title: 'SL-001: Sales outreach drip',    status: 'in_progress', category: 'sales' },
  { title: 'AD-001: Quarterly admin sweep',  status: 'done', category: 'admin' }, // excluded
];

// ─── Workstream collapse ────────────────────────────────────────────────
test('NOTION_CATEGORY_TO_WORKSTREAM collapses 6 dash slugs → 5 display rows', () => {
  const { NOTION_CATEGORY_TO_WORKSTREAM } = lifecycleAggregator;
  // Delivery
  assert.equal(NOTION_CATEGORY_TO_WORKSTREAM.delivery, 'delivery');
  // Engineering
  assert.equal(NOTION_CATEGORY_TO_WORKSTREAM.engineering, 'engineering');
  // Marketing absorbs Content
  assert.equal(NOTION_CATEGORY_TO_WORKSTREAM.marketing, 'marketing');
  assert.equal(NOTION_CATEGORY_TO_WORKSTREAM.content, 'marketing');
  // Sales
  assert.equal(NOTION_CATEGORY_TO_WORKSTREAM.sales, 'sales');
  // Studio
  assert.equal(NOTION_CATEGORY_TO_WORKSTREAM.prism_studio, 'studio');
});

test('admin / finance / training are EXCLUDED from the heatmap mapping', () => {
  const { NOTION_CATEGORY_TO_WORKSTREAM } = lifecycleAggregator;
  assert.equal(NOTION_CATEGORY_TO_WORKSTREAM.admin, undefined);
  assert.equal(NOTION_CATEGORY_TO_WORKSTREAM.finance, undefined);
  assert.equal(NOTION_CATEGORY_TO_WORKSTREAM.training, undefined);
});

// ─── inferPlanWorkstream ────────────────────────────────────────────────
test('inferPlanWorkstream picks the dominant category among a plan\'s tickets', () => {
  const { inferPlanWorkstream } = lifecycleAggregator;

  // Mission Control roadmap = T-036..T-055, mostly engineering
  const result = inferPlanWorkstream(
    { ticket_id_range: ['T-036', 'T-055'] },
    FIXTURE_TICKETS,
  );
  assert.equal(result, 'engineering');
});

test('inferPlanWorkstream returns null when no tickets match the spec', () => {
  const { inferPlanWorkstream } = lifecycleAggregator;
  const result = inferPlanWorkstream(
    { ticket_id_range: ['XX-001', 'XX-099'] },
    FIXTURE_TICKETS,
  );
  assert.equal(result, null);
});

test('inferPlanWorkstream returns null when tickets carry only excluded categories', () => {
  const { inferPlanWorkstream } = lifecycleAggregator;
  const adminOnly = [
    { title: 'AD-001: Admin task A', status: 'done', category: 'admin' },
    { title: 'AD-002: Admin task B', status: 'done', category: 'finance' },
  ];
  const result = inferPlanWorkstream({ ticket_id_range: ['AD-001', 'AD-099'] }, adminOnly);
  assert.equal(result, null);
});

// ─── computeIterationDepth ──────────────────────────────────────────────
test('computeIterationDepth returns inclusive day-count between two dates', () => {
  const { computeIterationDepth } = lifecycleAggregator;
  assert.equal(computeIterationDepth('2026-05-01', '2026-05-10'), 10);
  assert.equal(computeIterationDepth('2026-05-25', '2026-05-25'), 1);
});

test('computeIterationDepth returns null on missing / malformed dates', () => {
  const { computeIterationDepth } = lifecycleAggregator;
  assert.equal(computeIterationDepth(null, '2026-05-10'), null);
  assert.equal(computeIterationDepth('2026-05-10', null), null);
  assert.equal(computeIterationDepth('not-a-date', '2026-05-10'), null);
});

// ─── median ─────────────────────────────────────────────────────────────
test('median handles odd, even, and empty inputs', () => {
  const { median } = lifecycleAggregator;
  assert.equal(median([14, 21, 7]), 14);    // odd
  assert.equal(median([10, 14, 18, 22]), 16); // even -> avg of middle two
  assert.equal(median([42]), 42);           // single
  assert.equal(median([]), null);           // empty
  assert.equal(median(null), null);         // null guard
});

// ─── compute() — full aggregation ────────────────────────────────────────
test('compute() builds the 5×5 matrix from inferred ticket workstreams', async () => {
  // Use a stub notionAdapter that returns the fixture tickets so plan workstream
  // inference works without hitting Notion. The other state sources (inbox,
  // handoffs, pending, archived) are exercised against their real disk paths
  // — this is a wide-but-shallow integration test rather than a pure unit test.
  const stub = makeStubAdapter(FIXTURE_TICKETS);
  // Force cache miss between tests
  lifecycleAggregator.invalidateCache();
  const data = await lifecycleAggregator.compute(stub);

  assert.equal(data.ok === undefined, true, 'compute() returns inner shape, not the route envelope');
  assert.ok(data.tiles, 'tiles surfaced');
  assert.ok(data.items, 'items surfaced');
  assert.ok(data.matrix, 'matrix surfaced');

  // Matrix has all 5 rows × 5 cols, every value an integer ≥ 0
  for (const ws of lifecycleAggregator.ALL_WORKSTREAMS) {
    assert.ok(data.matrix[ws], `matrix.${ws} present`);
    for (const st of lifecycleAggregator.ALL_STATES) {
      assert.ok(Number.isInteger(data.matrix[ws][st]), `matrix.${ws}.${st} is integer`);
      assert.ok(data.matrix[ws][st] >= 0, `matrix.${ws}.${st} >= 0`);
    }
  }
});

test('compute() filters Solopreneur OS (retired:true) out of active items', async () => {
  const stub = makeStubAdapter(FIXTURE_TICKETS);
  lifecycleAggregator.invalidateCache();
  const data = await lifecycleAggregator.compute(stub);

  const activeTitles = data.items.filter(i => i.state === 'active').map(i => i.title);
  // Solopreneur OS is marked retired:true in active-roadmaps.json — must NOT surface
  assert.equal(
    activeTitles.some(t => /Solopreneur OS/i.test(t)),
    false,
    'Solopreneur OS should be filtered out by the retired flag',
  );
});

test('compute() caches by default and re-runs when invalidated', async () => {
  const stub1 = makeStubAdapter([
    { title: 'T-001: A', status: 'done', category: 'engineering' },
  ]);
  lifecycleAggregator.invalidateCache();
  const a = await lifecycleAggregator.compute(stub1);

  // Second call with a different stub — should return cached (first stub's) result
  const stub2 = makeStubAdapter([
    { title: 'T-002: B', status: 'done', category: 'marketing' },
  ]);
  const b = await lifecycleAggregator.compute(stub2);
  assert.equal(b.as_of, a.as_of, 'cached response returns identical as_of');

  // Invalidate then call again — should re-fetch
  lifecycleAggregator.invalidateCache();
  const c = await lifecycleAggregator.compute(stub2);
  assert.notEqual(c.as_of, a.as_of, 'after invalidate, as_of advances');
});

// ─── shipPlan precondition gates ────────────────────────────────────────
test('shipPlan rejects empty / short closing_comment with status 422', async () => {
  const stub = makeStubAdapter(FIXTURE_TICKETS);

  await assert.rejects(
    () => lifecycleAggregator.shipPlan('mission-control', '', stub),
    (e) => e.status === 422 && /closing_comment/i.test(e.message),
  );

  await assert.rejects(
    () => lifecycleAggregator.shipPlan('mission-control', 'too short', stub),
    (e) => e.status === 422,
  );
});

test('shipPlan rejects unknown slug with status 404', async () => {
  const stub = makeStubAdapter(FIXTURE_TICKETS);
  await assert.rejects(
    () => lifecycleAggregator.shipPlan('does-not-exist', 'This is a valid closing comment over 20 chars.', stub),
    (e) => e.status === 404,
  );
});

test('shipPlan rejects retired plans with status 409', async () => {
  const stub = makeStubAdapter(FIXTURE_TICKETS);
  // Solopreneur OS has retired:true in active-roadmaps.json
  await assert.rejects(
    () => lifecycleAggregator.shipPlan('solopreneur-os-etsy-sku', 'This is a valid closing comment over 20 chars.', stub),
    (e) => e.status === 409,
  );
});

test('shipPlan rejects when plan is not at 100% with status 409', async () => {
  // Founder Journey has 1 ticket SOC-005 with status in_progress in fixture — not at 100%
  const stub = makeStubAdapter(FIXTURE_TICKETS);
  await assert.rejects(
    () => lifecycleAggregator.shipPlan('founder-journey-personal-account', 'This is a valid closing comment over 20 chars.', stub),
    (e) => e.status === 409 && /not at 100/i.test(e.message),
  );
});

test('shipPlan succeeds for a 100%-complete plan and moves it atomically', async () => {
  // Mission Control spec is T-036..T-055 (range). Build a fixture where every
  // ticket in the range is done so the aggregator counts the plan as 100%.
  // Snapshot the manifest before so we can restore it.
  const allDoneTickets = [];
  for (let n = 36; n <= 55; n += 1) {
    allDoneTickets.push({ title: `T-0${n}: phase`, status: 'done', category: 'engineering' });
  }
  const stub = makeStubAdapter(allDoneTickets);

  // Snapshot both manifests so the test is non-destructive
  const activeBefore = fs.readFileSync(plansAggregator.MANIFEST_PATH, 'utf8');
  const archivedBefore = fs.readFileSync(lifecycleAggregator.ARCHIVED_PATH, 'utf8');

  try {
    const out = await lifecycleAggregator.shipPlan(
      'mission-control',
      'Closed — Mission Control phases 1–5 shipped; Daily Agenda lifecycle view live in production.',
      stub,
    );
    assert.equal(out.ok, true);
    assert.ok(out.shipped, 'shipped entry returned');
    assert.equal(out.shipped.slug, 'mission-control');
    assert.ok(out.shipped.shipped_at, 'shipped_at timestamp present');
    assert.ok(out.shipped.closing_comment.length >= 20, 'closing comment preserved');
    assert.ok(Array.isArray(out.shipped.ticket_snapshot), 'ticket snapshot is an array');
    assert.equal(out.shipped.ticket_snapshot.length, 20, 'all 20 tickets in range snapshotted');
    assert.equal(out.shipped.workstream, 'engineering', 'workstream inferred');

    // Active manifest should no longer contain this slug
    const activeAfter = plansAggregator.readManifestRaw();
    assert.equal(
      activeAfter.some(r => r.slug === 'mission-control'),
      false,
      'plan removed from active manifest',
    );
    // Archived should contain it (at the top — reverse-chronological)
    const archivedAfter = lifecycleAggregator.readArchived();
    assert.equal(archivedAfter[0].slug, 'mission-control', 'plan landed at top of archived');
  } finally {
    // Restore both manifests so other tests + the live app are unaffected
    fs.writeFileSync(plansAggregator.MANIFEST_PATH, activeBefore, 'utf8');
    fs.writeFileSync(lifecycleAggregator.ARCHIVED_PATH, archivedBefore, 'utf8');
  }
});

// ─── plansAggregator surface check ──────────────────────────────────────
test('plansAggregator exposes ready_to_ship flag for 100% plans', async () => {
  // Mission Control is the only live active roadmap with a ticket_id_range
  // (T-036..T-055). Stub every ticket in the range as done so the aggregator
  // computes ready_to_ship:true. notion-as-source-migration was deduped out of
  // active-roadmaps.json (now lives in archived-roadmaps.json), so we can't
  // assert against it here.
  const allDoneTickets = [];
  for (let n = 36; n <= 55; n += 1) {
    allDoneTickets.push({ title: `T-0${n}: phase`, status: 'done', category: 'engineering' });
  }
  const stub = makeStubAdapter(allDoneTickets);
  const result = await plansAggregator.getActiveRoadmaps(stub);

  const missionControl = result.active_roadmaps.find(r => r.slug === 'mission-control');
  assert.ok(missionControl, 'mission-control present');
  assert.equal(missionControl.ready_to_ship, true, 'ready_to_ship surfaces when at 100%');

  // Solopreneur OS is retired — should be absent entirely
  const solopreneur = result.active_roadmaps.find(r => r.slug === 'solopreneur-os-etsy-sku');
  assert.equal(solopreneur, undefined, 'retired plan filtered out of active output');
});
