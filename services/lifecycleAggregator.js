// services/lifecycleAggregator.js — T-078. Powers Mission Control's 5-state
// Lifecycle Spectrum view (Idea → Handoff → Pending → Active → Shipped).
//
// One aggregator endpoint feeds the entire view client-side, mirroring how
// /api/benchmark-products feeds the Compliance page. The shape returned:
//
//   {
//     as_of: ISO timestamp,
//     notion_available: boolean,
//     tiles: { idea, handoff, pending, active, shipped_30d, velocity_per_week, cycle_time_median_days },
//     items: [ { id, state, title, workstream, source, last_updated, ... per-state fields ... } ],
//     matrix: { delivery: {idea,handoff,pending,active,shipped_30d}, engineering: {...}, ... }
//   }
//
// The 5-row workstream collapse (locked design decision):
//   delivery     ← Notion category 'AI Bridge', 'Client Work'
//   engineering  ← Notion category 'CRM Development'
//   marketing    ← Notion category 'Marketing', 'Content'
//   sales        ← Notion category 'Sales & Outreach'
//   studio       ← Notion category 'Prism Studio'
//
//   Admin / Finance / Training tickets carry no workstream (administrative
//   overhead, not output) — they appear in the detail table with workstream:null
//   but are EXCLUDED from the heatmap matrix counts.
//
// Railway behavior: the workspace-root Handoffs/ directory does not ship to
// Railway, so listHandoffs() returns empty there. Handoff Docs/ inside the
// dashboard may or may not be present depending on Dockerfile COPY directives —
// if it isn't, the handoff state simply renders empty. Mirrors the same
// graceful-degradation pattern as pendingPlansAggregator's plans-dir scan.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const plansAggregator = require('./plansAggregator');
const pendingPlansAggregator = require('./pendingPlansAggregator');
const inboxRouter = require('./inboxRouter');

// parseFrontMatter + serializeFrontMatter (T-083) live at workspace-root
// Handoffs/parseFrontMatter.js so they can be shared with the CLI build-index.
// On Railway the workspace root is not shipped, so require() fails — fall back
// to no-op stubs (handoffs surface as "needs front-matter"; spawn-plan returns
// 503 before reaching the serializer anyway since ~/.claude/plans/ is absent).
let parseFrontMatter;
let serializeFrontMatter;
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  const mod = require('../../../Handoffs/parseFrontMatter');
  parseFrontMatter = typeof mod.parseFrontMatter === 'function' ? mod.parseFrontMatter : () => null;
  // Older versions of the workspace-root module may not export
  // serializeFrontMatter (added in T-083). Detect that explicitly so we
  // don't silently destructure to `undefined` and crash spawn-plan at call
  // time — fall back to a marker that throws, surfacing the workflow gap.
  serializeFrontMatter = typeof mod.serializeFrontMatter === 'function'
    ? mod.serializeFrontMatter
    : () => { throw new Error('serializeFrontMatter not present in workspace-root Handoffs/parseFrontMatter.js — upgrade it (T-083 introduced this export)'); };
} catch (_) {
  parseFrontMatter = () => null;
  serializeFrontMatter = () => { throw new Error('Handoffs/parseFrontMatter module not available in this environment (Railway / non-local clone)'); };
}

// T-083: home for spawned plan files. Absolute path so containment checks
// against arbitrary slug input are predictable. Local-only — Railway has
// no ~/.claude/ directory, so spawn-plan returns 503 if this isn't writable.
const PLANS_DIR_ABS = path.resolve(path.join(os.homedir(), '.claude', 'plans'));

// Resolve workspace-root + handoff scan paths. WORKSPACE_ROOT is __dirname / ../../..
const WORKSPACE_ROOT = path.resolve(__dirname, '..', '..', '..');
const HANDOFF_SCAN_PATHS = [
  path.join(WORKSPACE_ROOT, 'Handoffs', 'active'),
  path.resolve(__dirname, '..', 'Handoff Docs'), // inside the dashboard repo
];

const ARCHIVED_PATH = path.resolve(path.join(__dirname, '..', 'config', 'archived-roadmaps.json'));

// Ticket category → 5-row workstream display (the locked collapse mapping).
// notionAdapter normalizes Notion's Category select to dashboard slugs at line 242
// (categoryNotionToDash). So the values here are dashboard slugs, NOT Notion
// display names. Dashboard slug origins per services/notionAdapter.js:
//   delivery     ← Notion 'AI Bridge' or 'Client Work'
//   engineering  ← Notion 'CRM Development'
//   marketing    ← Notion 'Marketing'
//   content      ← Notion 'Content'
//   sales        ← Notion 'Sales & Outreach'
//   prism_studio ← Notion 'Prism Studio'
//   admin/finance/training ← Notion 'Admin'/'Finance'/'Training' (excluded — overhead)
const NOTION_CATEGORY_TO_WORKSTREAM = {
  delivery: 'delivery',
  engineering: 'engineering',
  marketing: 'marketing',
  content: 'marketing',
  sales: 'sales',
  prism_studio: 'studio',
  // admin, finance, training intentionally absent
};

const ALL_WORKSTREAMS = ['delivery', 'engineering', 'marketing', 'sales', 'studio'];
const ALL_STATES = ['idea', 'handoff', 'pending', 'active', 'shipped'];

// 60-second in-memory cache. Invalidated by shipPlan().
const CACHE_TTL_MS = 60 * 1000;
let _cache = { data: null, expires: 0 };

function readArchived() {
  try {
    const raw = fs.readFileSync(ARCHIVED_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.archived_roadmaps) ? parsed.archived_roadmaps : [];
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.warn('[lifecycleAggregator] failed to read archived:', e.message);
    }
    return [];
  }
}

function writeArchived(entries) {
  const payload = {
    _comment: 'Archived (shipped) roadmaps. Companion to active-roadmaps.json. A plan lands here when all its tickets are Done AND a closing comment was attached at ship time. New entries are appended at the top (reverse-chronological by shipped_at). Schema: slug, name, ticket_ids OR ticket_id_range, decision_date, note, shipped_at, closing_comment, ticket_snapshot, cycle_time_days, workstream.',
    archived_roadmaps: entries,
  };
  fs.writeFileSync(ARCHIVED_PATH, JSON.stringify(payload, null, 2) + '\n', 'utf8');
}

// Scan one folder for .md handoff files. Files without front-matter are
// returned with has_front_matter:false so the UI can flag them rather than
// silently dropping the legacy material.
function scanHandoffFolder(absPath) {
  if (!fs.existsSync(absPath)) return [];
  let entries;
  try {
    entries = fs.readdirSync(absPath, { withFileTypes: true });
  } catch (_) {
    return [];
  }

  const out = [];
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.toLowerCase().endsWith('.md')) continue;
    const lower = ent.name.toLowerCase();
    if (lower === 'readme.md' || lower === 'index.md') continue;

    const filePath = path.join(absPath, ent.name);
    let content = '';
    let stat = null;
    try {
      content = fs.readFileSync(filePath, 'utf8');
      stat = fs.statSync(filePath);
    } catch (_) {
      continue;
    }

    const fm = parseFrontMatter(content);
    const hasFm = !!(fm && fm.status !== undefined);
    const title = ent.name.replace(/\.md$/i, '');
    const lastUpdated = (fm && fm.last_updated)
      || (stat ? new Date(stat.mtimeMs).toISOString().slice(0, 10) : null);

    out.push({
      slug: title,
      title,
      source_path: filePath,
      front_matter: fm,
      has_front_matter: hasFm,
      status: fm && fm.status || null,
      created: fm && fm.created || null,
      last_updated: lastUpdated,
      ticket: fm && fm.ticket || null,
      owner: fm && fm.owner || null,
      workstream: fm && fm.workstream || null,
    });
  }
  return out;
}

// Active = status:active in front-matter, OR no front-matter at all (legacy
// files we haven't retrofitted yet). Superseded / archived are dropped.
function listHandoffs() {
  const all = [];
  for (const p of HANDOFF_SCAN_PATHS) all.push(...scanHandoffFolder(p));
  return all.filter(h => {
    if (!h.has_front_matter) return true; // legacy — surface with the warning flag
    return h.front_matter.status === 'active';
  });
}

// Iteration depth proxy: days between created and last_updated, +1 (inclusive).
// Used as a bar-length hint on the Handoffs drill-in viz.
function computeIterationDepth(created, lastUpdated) {
  if (!created || !lastUpdated) return null;
  const start = new Date(created);
  const end = new Date(lastUpdated);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return null;
  const days = Math.round((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)) + 1;
  return days > 0 ? days : 1;
}

// Infer a plan's workstream from the dominant Notion category among its
// member tickets. Returns null if no tickets carry a recognized category.
function inferPlanWorkstream(roadmap, allTickets) {
  if (!allTickets || allTickets.length === 0) return null;
  const belongs = plansAggregator.makeBelongsTo(roadmap);
  const counts = {};
  for (const t of allTickets) {
    const id = plansAggregator.extractTicketIdFromTitle(t.title);
    if (!id || !belongs(id)) continue;
    const ws = NOTION_CATEGORY_TO_WORKSTREAM[t.category] || null;
    if (!ws) continue;
    counts[ws] = (counts[ws] || 0) + 1;
  }
  let max = 0;
  let best = null;
  for (const [k, v] of Object.entries(counts)) {
    if (v > max) { max = v; best = k; }
  }
  return best;
}

// T-123: normalize a pending-plan's optional `ticket_spec` into the roadmap
// shape that plansAggregator.computeProgress understands. Accepts the same
// {kind:'range'|'ids', value:[...]} shape activatePendingPlan takes, so a plan
// promoted manually and one auto-flipped read from the identical field.
// Returns null when the spec is absent or malformed (plan stays Pending).
function normalizeTicketSpec(spec) {
  if (!spec || typeof spec !== 'object') return null;
  const value = spec.value;
  if (!Array.isArray(value) || value.length === 0) return null;
  if (spec.kind === 'range') {
    if (value.length !== 2) return null;
    return { kind: 'range', value: [String(value[0]), String(value[1])] };
  }
  if (spec.kind === 'ids') {
    return { kind: 'ids', value: value.map(String) };
  }
  return null;
}

function median(nums) {
  if (!nums || nums.length === 0) return null;
  const sorted = nums.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

async function compute(notionAdapter, { useCache = true } = {}) {
  if (useCache && _cache.data && _cache.expires > Date.now()) return _cache.data;

  // Fetch tickets once — reused by inbox category inference + active progress + workstream inference.
  let allTickets = [];
  let notionAvailable = false;
  if (notionAdapter && typeof notionAdapter.listTickets === 'function') {
    try {
      const result = await notionAdapter.listTickets({});
      allTickets = result.tickets || [];
      notionAvailable = true;
    } catch (e) {
      console.warn('[lifecycleAggregator] Notion fetch failed:', e.message);
    }
  }

  // ─── 1. Ideas (inbox captures) ─────────────────────────────────────────
  let ideaItems = [];
  try {
    const inbox = await inboxRouter.listCaptures();
    ideaItems = (inbox.captures || []).map(t => ({
      id: `idea:${t.id || t.notion_page_id || t.url || Math.random().toString(36).slice(2)}`,
      state: 'idea',
      title: t.title || '(untitled idea)',
      workstream: NOTION_CATEGORY_TO_WORKSTREAM[t.category] || null,
      source: 'cowork:inbox',
      last_updated: (t.created_at || '').slice(0, 10) || null,
      drill_link: t.url || null,
    }));
  } catch (e) {
    console.warn('[lifecycleAggregator] idea fetch failed:', e.message);
  }

  // ─── 2. Handoffs ───────────────────────────────────────────────────────
  const handoffs = listHandoffs();
  const handoffItems = handoffs.map(h => ({
    id: `handoff:${h.slug}`,
    state: 'handoff',
    title: h.title,
    workstream: h.workstream || null,
    source: h.source_path,
    last_updated: h.last_updated,
    iteration_depth: computeIterationDepth(h.created, h.last_updated),
    has_front_matter: h.has_front_matter,
    ticket: h.ticket,
    owner: h.owner,
    drill_link: h.source_path,
  }));

  // ─── 3. Pending plans ──────────────────────────────────────────────────
  // T-123: a Pending plan that declares a `ticket_spec` is no longer "awaiting
  // review" the moment any of its tickets start moving in Notion. Rather than
  // wait for a manual `→ Active` click, we reclassify it to Active at compute
  // time (display-only — the pending-plans.json manifest is never rewritten,
  // so this is self-correcting and can't corrupt the manifest). Plans without a
  // ticket_spec, or whose tickets haven't started, stay Pending.
  let pendingItems = [];
  const autoActivatedItems = [];
  try {
    const pending = await pendingPlansAggregator.getPendingPlans(plansAggregator);

    for (const p of (pending.pending_plans || [])) {
      const spec = normalizeTicketSpec(p.ticket_spec);
      if (spec && notionAvailable) {
        const roadmapShape = spec.kind === 'range'
          ? { ticket_id_range: spec.value }
          : { ticket_ids: spec.value };
        const progress = plansAggregator.computeProgress(roadmapShape, allTickets);
        // "Started" = at least one member ticket has left Backlog. shipped/done,
        // in_progress, and blocked all count as started work.
        const started = progress.total > 0
          && (progress.shipped > 0 || progress.in_progress > 0 || progress.blocked > 0);
        if (started) {
          autoActivatedItems.push({
            id: `active:${p.slug}`,
            state: 'active',
            title: p.name,
            slug: p.slug,
            workstream: inferPlanWorkstream(roadmapShape, allTickets),
            source: p.plan_file,
            last_updated: p.review_date || p.created_date || null,
            progress,
            // All tickets Done → surface the "Ship this plan" CTA, but never
            // auto-archive: the Shipped write is irreversible and needs a human
            // closing comment (decided 2026-06-18).
            ready_to_ship: progress.shipped === progress.total,
            spec: spec.kind === 'range'
              ? { kind: 'range', from: spec.value[0], to: spec.value[1] }
              : { kind: 'list', ids: spec.value },
            note: p.summary || '',
            auto_activated: true, // T-123 provenance — flipped from Pending by ticket activity
          });
          continue;
        }
      }
      pendingItems.push({
        id: `pending:${p.slug}`,
        state: 'pending',
        title: p.name,
        workstream: null, // pending manifest carries no workstream — left null
        source: p.plan_file,
        last_updated: p.review_date || p.created_date || null,
        summary: p.summary || '',
        drill_link: p.plan_file,
      });
    }

    // T-123: surface recent auto-scanned drafts (~/.claude/plans/ files carrying
    // a review marker, modified in the scanner's window) on the Lifecycle table
    // too — previously they only appeared in the Daily Agenda's side panel, so
    // a plan drafted yesterday never showed up here. Tagged auto_suggested so
    // the UI can mark them as not-yet-in-the-manifest. Empty on Railway (no
    // plans dir), same graceful degradation as the scanner.
    for (const s of (pending.suggested_plans || [])) {
      pendingItems.push({
        id: `pending:suggested:${s.slug}`,
        state: 'pending',
        title: s.name,
        workstream: null,
        source: s.plan_file,
        last_updated: s.modified_date || null,
        summary: '',
        drill_link: s.plan_file,
        auto_suggested: true, // T-123 — from plans-dir auto-scan, not yet curated into the manifest
      });
    }
  } catch (e) {
    console.warn('[lifecycleAggregator] pending fetch failed:', e.message);
  }

  // ─── 4. Active roadmaps ───────────────────────────────────────────────
  // T-080: pass the already-fetched allTickets array so plansAggregator
  // doesn't fire a second Notion roundtrip for the same data. Halves the
  // cold-load latency on /api/mission-control/lifecycle (~3.3s → ~1.6s).
  let activeItems = [];
  if (notionAvailable) {
    try {
      const active = await plansAggregator.getActiveRoadmaps(notionAdapter, {
        prefetchedTickets: allTickets,
      });
      activeItems = (active.active_roadmaps || []).map(r => {
        // Reconstruct the raw-manifest shape for inferPlanWorkstream
        const roadmapShape = r.spec && r.spec.kind === 'range'
          ? { ticket_id_range: [r.spec.from, r.spec.to] }
          : { ticket_ids: r.spec && r.spec.ids || [] };
        return {
          id: `active:${r.slug}`,
          state: 'active',
          title: r.name,
          slug: r.slug,
          workstream: inferPlanWorkstream(roadmapShape, allTickets),
          source: 'config/active-roadmaps.json',
          last_updated: r.decision_date || null,
          progress: r.progress,
          ready_to_ship: !!r.ready_to_ship,
          spec: r.spec,
          note: r.note,
        };
      });
    } catch (e) {
      console.warn('[lifecycleAggregator] active fetch failed:', e.message);
    }
  } else {
    // Notion unavailable — surface manifest entries with progress:null
    const raw = plansAggregator.readManifestRaw();
    activeItems = raw.filter(r => r.retired !== true).map(r => ({
      id: `active:${r.slug}`,
      state: 'active',
      title: r.name,
      slug: r.slug,
      workstream: null,
      source: 'config/active-roadmaps.json',
      last_updated: r.decision_date || null,
      progress: null,
      ready_to_ship: false,
      note: r.note,
    }));
  }

  // T-123: fold the plans that auto-flipped Pending → Active into the Active
  // column. The pending/active dedup (getPendingPlans masks active slugs) keeps
  // a slug from appearing in both, so no collision filter is needed here.
  if (autoActivatedItems.length > 0) {
    activeItems = [...activeItems, ...autoActivatedItems];
  }

  // ─── 5. Shipped (archived) ────────────────────────────────────────────
  const archived = readArchived();
  const shippedItems = archived.map(a => ({
    id: `shipped:${a.slug}`,
    state: 'shipped',
    title: a.name || a.slug,
    slug: a.slug,
    workstream: a.workstream || null,
    source: 'config/archived-roadmaps.json',
    last_updated: (a.shipped_at || '').slice(0, 10) || null,
    shipped_at: a.shipped_at,
    closing_comment: a.closing_comment || '',
    cycle_time_days: a.cycle_time_days || null,
  }));

  const items = [...ideaItems, ...handoffItems, ...pendingItems, ...activeItems, ...shippedItems];

  // ─── Tiles ────────────────────────────────────────────────────────────
  const thirtyDaysAgoMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const shipped30dItems = shippedItems.filter(s => {
    const t = new Date(s.shipped_at || 0).getTime();
    return !isNaN(t) && t >= thirtyDaysAgoMs;
  });
  const velocityPerWeek = +(shipped30dItems.length / 4.3).toFixed(1);

  const recentCycleTimes = shippedItems
    .slice(0, 10) // archived is reverse-chronological per writeArchived order
    .map(s => s.cycle_time_days)
    .filter(d => typeof d === 'number' && d > 0);
  const cycleTimeMedian = median(recentCycleTimes);

  const tiles = {
    idea: ideaItems.length,
    handoff: handoffItems.length,
    pending: pendingItems.length,
    active: activeItems.length,
    shipped_30d: shipped30dItems.length,
    velocity_per_week: velocityPerWeek,
    cycle_time_median_days: cycleTimeMedian,
  };

  // ─── 5×5 matrix ───────────────────────────────────────────────────────
  // Rows = collapsed workstreams. Cols = lifecycle states. Cells = item counts.
  // Shipped column counts only the 30-day rolling window so the matrix stays
  // a current-state view rather than an all-time tally.
  const matrix = {};
  for (const ws of ALL_WORKSTREAMS) {
    matrix[ws] = {};
    for (const st of ALL_STATES) matrix[ws][st] = 0;
  }
  const shipped30dIds = new Set(shipped30dItems.map(s => s.id));
  for (const it of items) {
    if (!it.workstream || !ALL_WORKSTREAMS.includes(it.workstream)) continue;
    if (it.state === 'shipped' && !shipped30dIds.has(it.id)) continue;
    matrix[it.workstream][it.state] += 1;
  }

  const data = {
    as_of: new Date().toISOString(),
    notion_available: notionAvailable,
    tiles,
    items,
    matrix,
  };

  _cache = { data, expires: Date.now() + CACHE_TTL_MS };
  return data;
}

function invalidateCache() {
  _cache = { data: null, expires: 0 };
}

// ─── Ship transition ──────────────────────────────────────────────────────
// Atomic move: active-roadmaps.json → archived-roadmaps.json.
// Pre-conditions: plan exists in active manifest, all tickets are Done,
// closing comment is ≥ 20 chars.
// Throws errors with a `.status` property so the route handler can map cleanly.
async function shipPlan(slug, closingComment, notionAdapter) {
  if (!slug || typeof slug !== 'string') {
    const e = new Error('slug is required');
    e.status = 400;
    throw e;
  }
  const trimmed = (closingComment || '').toString().trim();
  if (trimmed.length < 20) {
    const e = new Error('closing_comment is required (min 20 chars)');
    e.status = 422;
    throw e;
  }

  const active = plansAggregator.readManifestRaw();
  const entry = active.find(r => r.slug === slug);
  if (!entry) {
    const e = new Error(`plan not found: ${slug}`);
    e.status = 404;
    throw e;
  }
  if (entry.retired === true) {
    const e = new Error(`plan is retired: ${slug}`);
    e.status = 409;
    throw e;
  }

  // Verify all tickets are Done
  if (!notionAdapter || typeof notionAdapter.listTickets !== 'function') {
    const e = new Error('Notion adapter unavailable — cannot verify ticket completion');
    e.status = 503;
    throw e;
  }
  const result = await notionAdapter.listTickets({});
  const tickets = result.tickets || [];
  const progress = plansAggregator.computeProgress(entry, tickets);
  if (progress.total === 0) {
    const e = new Error(`plan has zero tickets matching its spec — manifest spec error`);
    e.status = 409;
    throw e;
  }
  if (progress.shipped !== progress.total) {
    const e = new Error(`plan is not at 100% (shipped: ${progress.shipped}/${progress.total})`);
    e.status = 409;
    throw e;
  }

  // Snapshot tickets + compute cycle time
  const belongs = plansAggregator.makeBelongsTo(entry);
  const ticketSnapshot = [];
  for (const t of tickets) {
    const id = plansAggregator.extractTicketIdFromTitle(t.title);
    if (!id || !belongs(id)) continue;
    ticketSnapshot.push({
      id,
      status: t.status,
      title: t.title,
      last_updated: t.last_updated || null,
    });
  }

  let cycleTimeDays = null;
  if (entry.decision_date) {
    const start = new Date(entry.decision_date).getTime();
    if (!isNaN(start)) {
      cycleTimeDays = Math.max(1, Math.round((Date.now() - start) / (24 * 60 * 60 * 1000)));
    }
  }

  const shippedEntry = {
    slug: entry.slug,
    name: entry.name,
    ticket_id_range: entry.ticket_id_range || undefined,
    ticket_ids: entry.ticket_ids || undefined,
    decision_date: entry.decision_date || null,
    note: entry.note || '',
    shipped_at: new Date().toISOString(),
    closing_comment: trimmed,
    ticket_snapshot: ticketSnapshot,
    cycle_time_days: cycleTimeDays,
    workstream: inferPlanWorkstream(entry, tickets),
  };

  // Archived write first — if it fails, active stays intact.
  const archived = readArchived();
  archived.unshift(shippedEntry);
  writeArchived(archived);

  // Then remove from active.
  const remaining = active.filter(r => r.slug !== slug);
  plansAggregator.writeManifestRaw(remaining);

  invalidateCache();
  return { ok: true, shipped: shippedEntry };
}

// ─── T-084: Pending → Active promote + dismiss ────────────────────────────
// Slug allowlist matches the filenames produced by ~/.claude/plans/ auto-scan
// (slugified plan filenames, hyphen/underscore only). Defends against path
// traversal even though slugs are JSON keys here, not filesystem paths —
// suggested plans (T-085) will use the same regex for file-path containment.
const SLUG_ALLOWLIST = /^[a-z0-9][a-z0-9\-_]{0,80}$/i;

function _assertValidSlug(slug) {
  if (!slug || typeof slug !== 'string' || !SLUG_ALLOWLIST.test(slug)) {
    const e = new Error('invalid slug');
    e.status = 400;
    throw e;
  }
}

// Activate a Pending plan → Active. Body:
//   ticket_spec: { kind: 'range', value: [from, to] } | { kind: 'ids', value: [...] }
//   decision_date?: 'YYYY-MM-DD' (default today)
//   note?: string
// Atomic ordering: append to active first; if that fails, no state change.
// Then remove from pending. Partial write (active appended, pending remove
// failed) is masked by the self-healing dedup in pendingPlansAggregator.
async function activatePendingPlan(slug, { ticket_spec, decision_date, note } = {}) {
  _assertValidSlug(slug);

  if (!ticket_spec || typeof ticket_spec !== 'object') {
    const e = new Error('ticket_spec is required');
    e.status = 422;
    throw e;
  }
  if (ticket_spec.kind !== 'range' && ticket_spec.kind !== 'ids') {
    const e = new Error('ticket_spec.kind must be "range" or "ids"');
    e.status = 422;
    throw e;
  }
  if (!Array.isArray(ticket_spec.value) || ticket_spec.value.length === 0) {
    const e = new Error('ticket_spec.value must be a non-empty array');
    e.status = 422;
    throw e;
  }
  if (ticket_spec.kind === 'range' && ticket_spec.value.length !== 2) {
    const e = new Error('ticket_spec.value must be [from, to] for kind="range"');
    e.status = 422;
    throw e;
  }

  // Look up the pending entry. readManifest is raw — sees entries even if the
  // self-healing dedup has hidden them from getPendingPlans output.
  const pending = pendingPlansAggregator.readManifest();
  const entry = pending.find(p => p.slug === slug);
  if (!entry) {
    const e = new Error(`pending plan not found: ${slug}`);
    e.status = 404;
    throw e;
  }

  // Build the active manifest entry. Only one of ticket_id_range / ticket_ids
  // per plansAggregator convention.
  const activeEntry = {
    slug: entry.slug,
    name: entry.name,
    decision_date: (decision_date || '').toString().trim() || new Date().toISOString().slice(0, 10),
  };
  if (ticket_spec.kind === 'range') {
    activeEntry.ticket_id_range = [String(ticket_spec.value[0]), String(ticket_spec.value[1])];
  } else {
    activeEntry.ticket_ids = ticket_spec.value.map(v => String(v));
  }
  if (note && String(note).trim()) activeEntry.note = String(note).trim();

  // Step 1: append to active. Throws 409 on slug collision (caller decides).
  plansAggregator.appendToManifest(activeEntry);

  // Step 2: remove from pending. If this throws, partial state — self-healing
  // dedup masks it on the next render; log and re-throw as a soft warning.
  try {
    const remaining = pending.filter(p => p.slug !== slug);
    pendingPlansAggregator.writeManifest(remaining);
  } catch (e) {
    console.warn('[lifecycleAggregator] activatePendingPlan: active append OK but pending write failed — self-healing dedup will mask:', e.message);
  }

  invalidateCache();
  return { ok: true, activated: activeEntry };
}

// Dismiss a Pending plan: remove from config/pending-plans.json only. Does
// NOT touch the underlying ~/.claude/plans/*.md file — that's the user's data.
async function dismissPendingPlan(slug) {
  _assertValidSlug(slug);

  const pending = pendingPlansAggregator.readManifest();
  const entry = pending.find(p => p.slug === slug);
  if (!entry) {
    const e = new Error(`pending plan not found: ${slug}`);
    e.status = 404;
    throw e;
  }

  const remaining = pending.filter(p => p.slug !== slug);
  pendingPlansAggregator.writeManifest(remaining);

  invalidateCache();
  return { ok: true, dismissed: slug };
}

// ─── T-083: Handoff → Plan spawn ───────────────────────────────────────────
// Reads a Handoff .md file, writes a new plan file to ~/.claude/plans/ with a
// "Draft for review" marker so pendingPlansAggregator.REVIEW_MARKERS picks it
// up as a suggested_plan, and bumps the source handoff's frontmatter with
// last_updated + spawned_plan: <basename> for traceability.
//
// Atomicity gate (per peer-review): rewrite the source handoff FIRST. If that
// fails, no new file is created. If the new-plan write fails after the source
// was bumped, the dangling `spawned_plan:` ref is more visible/recoverable
// than the inverse orphan.
//
// Local-only: Railway has no ~/.claude/plans/. Returns 503 when paths absent.
async function spawnPlanFromHandoff(handoffSlug) {
  _assertValidSlug(handoffSlug);

  // Find the handoff. listHandoffs filters by status:active OR no-front-matter
  // — we additionally require has_front_matter (can't bump frontmatter on a
  // legacy file that doesn't have a parseable block).
  const handoffs = listHandoffs();
  const handoff = handoffs.find(h => h.slug === handoffSlug);
  if (!handoff) {
    const e = new Error(`handoff not found: ${handoffSlug}`);
    e.status = 404;
    throw e;
  }
  if (!handoff.has_front_matter) {
    const e = new Error(`handoff has no front-matter — can't bump it. Add a YAML block first.`);
    e.status = 422;
    throw e;
  }

  // Verify destination directory exists. Local-dev only — Railway has no ~/.claude/.
  if (!fs.existsSync(PLANS_DIR_ABS)) {
    const e = new Error('Handoff→Plan is local-only (~/.claude/plans/ not present in this environment)');
    e.status = 503;
    throw e;
  }

  // TOCTOU guard: lstat the source handoff and abort on symlink.
  let srcStat;
  try {
    srcStat = fs.lstatSync(handoff.source_path);
  } catch (e) {
    const err = new Error(`source handoff unreadable: ${e.code || e.message}`);
    err.status = 500;
    throw err;
  }
  if (srcStat.isSymbolicLink()) {
    const e = new Error('source handoff is a symlink — refusing to write through it');
    e.status = 409;
    throw e;
  }

  // Read source and split into frontmatter + body.
  const sourceContent = fs.readFileSync(handoff.source_path, 'utf8');
  const fmMatch = sourceContent.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!fmMatch) {
    // Shouldn't happen — listHandoffs already verified front-matter — but guard.
    const e = new Error('source handoff frontmatter block missing');
    e.status = 422;
    throw e;
  }
  const body = sourceContent.slice(fmMatch[0].length);
  if (!body.replace(/\s/g, '')) {
    const e = new Error('source handoff body is empty');
    e.status = 422;
    throw e;
  }

  // Compute target path with containment check. Slug already passed allowlist;
  // path.resolve + startsWith is defense in depth against any future bypass.
  const today = new Date().toISOString().slice(0, 10);
  const baseName = `handoff-${handoffSlug}-${today}.md`;
  let targetPath = path.resolve(PLANS_DIR_ABS, baseName);
  if (!targetPath.startsWith(PLANS_DIR_ABS + path.sep)) {
    const e = new Error('target path escapes plans directory');
    e.status = 400;
    throw e;
  }

  // Collision handling: -1, -2, ... if a file already exists for this slug+date.
  let suffix = 0;
  while (fs.existsSync(targetPath)) {
    suffix += 1;
    if (suffix > 99) {
      const e = new Error('too many collisions — ran out of suffix slots');
      e.status = 409;
      throw e;
    }
    targetPath = path.resolve(PLANS_DIR_ABS, `handoff-${handoffSlug}-${today}-${suffix}.md`);
    if (!targetPath.startsWith(PLANS_DIR_ABS + path.sep)) {
      const e = new Error('target path escapes plans directory');
      e.status = 400;
      throw e;
    }
  }

  // Step 1 (atomicity gate): bump source handoff frontmatter FIRST.
  // Build a new frontmatter object from the parsed one, updating last_updated +
  // adding spawned_plan: <basename>. Basename only (not full path) — defense
  // in depth against path-leak through the serialized value.
  const newFm = { ...handoff.front_matter };
  newFm.last_updated = today;
  newFm.spawned_plan = path.basename(targetPath);
  const newFmBlock = serializeFrontMatter(newFm);
  const newSourceContent = `${newFmBlock}\n${body.startsWith('\n') ? body.slice(1) : body}`;
  fs.writeFileSync(handoff.source_path, newSourceContent, 'utf8');

  // Step 2: write the new plan file. If this throws, the source has been
  // bumped but the plan file doesn't exist — surfaces as a dangling
  // spawned_plan: reference on next listHandoffs scan.
  const planFm = {
    source_handoff: path.basename(handoff.source_path),
    created: today,
  };
  const planContent = `${serializeFrontMatter(planFm)}\n\nDraft for review\n\n# ${handoff.title}\n\n${body.trim()}\n`;
  fs.writeFileSync(targetPath, planContent, 'utf8');

  invalidateCache();
  return {
    ok: true,
    plan_path: targetPath,
    source_handoff_path: handoff.source_path,
  };
}

module.exports = {
  compute,
  shipPlan,
  // T-084 exports for Pending → Active + Dismiss
  activatePendingPlan,
  dismissPendingPlan,
  // T-083 export for Handoff → Plan spawn
  spawnPlanFromHandoff,
  invalidateCache,
  // T-083 exposed for tests
  PLANS_DIR_ABS,
  // Exposed for tests
  NOTION_CATEGORY_TO_WORKSTREAM,
  ALL_WORKSTREAMS,
  ALL_STATES,
  listHandoffs,
  inferPlanWorkstream,
  computeIterationDepth,
  median,
  readArchived,
  writeArchived,
  ARCHIVED_PATH,
};
