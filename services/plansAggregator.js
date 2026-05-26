// plansAggregator.js — T-057. Powers the Daily Agenda's Plans panel.
//
// Reads data/active-roadmaps.json (a hand-curated manifest of which multi-ticket
// arcs are currently in flight), then computes ship progress for each roadmap
// by intersecting the manifest's ticket IDs with the live Notion Tickets DB.
//
// Why a manifest vs derived clustering: "what's a plan" is a Michele-curated
// concept (multi-ticket arcs that ship together — Mission Control roadmap,
// Notion-source migration, Solopreneur OS). Notion has no native "roadmap"
// property, and prefix-based heuristics misgroup (T-### is engineering generally,
// not a single arc). The manifest is the right abstraction; aggregation against
// Notion gives the live progress numbers.
//
// Manifest entry shape (either ticket_id_range OR ticket_ids per entry):
//   {
//     slug, name, decision_date, note,
//     ticket_id_range: ["T-036", "T-055"]   // inclusive bounds, same prefix
//     // -- OR --
//     ticket_ids: ["PS-057", "PS-058", "PS-059"]   // explicit list
//   }

'use strict';

const fs = require('fs');
const path = require('path');

// Manifest path: config/ rather than data/ because Railway mounts a persistent
// volume at /app/data for the SQLite WAL file, which would overlay any files
// COPY'd into data/ at build time. The config/ directory is safe to COPY +
// serve from at runtime.
const MANIFEST_PATH = path.resolve(path.join(__dirname, '..', 'config', 'active-roadmaps.json'));

function readManifest() {
  try {
    const raw = fs.readFileSync(MANIFEST_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.active_roadmaps) ? parsed.active_roadmaps : [];
  } catch (e) {
    console.warn('[plansAggregator] failed to read manifest:', e.message);
    return [];
  }
}

// Parse a human ticket ID like "T-036" → { prefix: "T-", num: 36 }. Returns null
// for malformed input.
function parseTicketId(id) {
  if (!id || typeof id !== 'string') return null;
  const m = id.match(/^([A-Z]+-)(\d+)$/);
  if (!m) return null;
  return { prefix: m[1], num: parseInt(m[2], 10) };
}

// Extract the first ticket ID from a Notion ticket title. The dashboard's Notion
// DB uses synthetic ticket_keys (NTN-####, ACT-####, etc.) regardless of how
// humans refer to tickets — engineering T-### IDs and Prism Studio PS-### IDs
// live in the title (e.g. "T-036: Repurpose Daily Review …" or "[Cowork] T-061
// Upgrade node-quickbooks …"). Returns the first PREFIX-NUMBER found, or null.
function extractTicketIdFromTitle(title) {
  if (!title || typeof title !== 'string') return null;
  const m = title.match(/\b([A-Z]+-\d{3,})\b/);
  return m ? m[1] : null;
}

// Build the per-roadmap predicate: does this title's embedded ticket ID belong
// to this roadmap?
function makeBelongsTo(roadmap) {
  if (Array.isArray(roadmap.ticket_ids) && roadmap.ticket_ids.length > 0) {
    const set = new Set(roadmap.ticket_ids);
    return (id) => set.has(id);
  }
  if (Array.isArray(roadmap.ticket_id_range) && roadmap.ticket_id_range.length === 2) {
    const lo = parseTicketId(roadmap.ticket_id_range[0]);
    const hi = parseTicketId(roadmap.ticket_id_range[1]);
    if (!lo || !hi || lo.prefix !== hi.prefix) return () => false;
    return (id) => {
      const p = parseTicketId(id);
      return !!p && p.prefix === lo.prefix && p.num >= lo.num && p.num <= hi.num;
    };
  }
  // Manifest entry has neither — skip the roadmap.
  return () => false;
}

// Status precedence for dedupe: when multiple Notion pages share the same
// ticket ID (the Business Health Auto-Eval 5x-dupe pattern), the most-progressed
// status wins. Higher number = further along.
const STATUS_PROGRESS = { done: 4, in_progress: 3, blocked: 2, backlog: 1 };

// Bucket counts for one roadmap. `tickets` is the full Notion ticket list from
// notionAdapter.listTickets({}); we extract each title's ticket ID, dedupe by ID
// keeping the most-progressed status, then count.
function computeProgress(roadmap, tickets) {
  const belongs = makeBelongsTo(roadmap);

  // First pass: collect best-status-per-ID across the roadmap's members.
  const byId = new Map();
  for (const t of tickets || []) {
    const id = extractTicketIdFromTitle(t.title);
    if (!id || !belongs(id)) continue;
    const existing = byId.get(id);
    const incomingRank = STATUS_PROGRESS[t.status] ?? 0;
    const existingRank = existing ? (STATUS_PROGRESS[existing.status] ?? 0) : -1;
    if (incomingRank > existingRank) {
      byId.set(id, { id, status: t.status });
    }
  }

  const counts = { total: byId.size, shipped: 0, in_progress: 0, blocked: 0, backlog: 0, other: 0 };
  let nextInProgressId = null;

  for (const m of byId.values()) {
    switch (m.status) {
      case 'done': counts.shipped += 1; break;
      case 'in_progress':
        counts.in_progress += 1;
        if (!nextInProgressId || (parseTicketId(m.id)?.num ?? Infinity) < (parseTicketId(nextInProgressId)?.num ?? Infinity)) {
          nextInProgressId = m.id;
        }
        break;
      case 'blocked': counts.blocked += 1; break;
      case 'backlog': counts.backlog += 1; break;
      default: counts.other += 1;
    }
  }

  return { ...counts, in_progress_headline: nextInProgressId };
}

// Public entrypoint. Takes the notionAdapter module (passed by server.js to
// avoid a circular require) and returns { active_roadmaps, manifest_present, manifest_path }.
//
// T-080: `options.prefetchedTickets` lets a caller pass an already-fetched
// ticket list (from a prior `notionAdapter.listTickets({})` call) so we skip
// the redundant Notion roundtrip. lifecycleAggregator.compute uses this —
// before T-080 it called listTickets at the top AND again indirectly through
// getActiveRoadmaps, doubling the cold-load latency (3.3s → ~1.6s when fixed).
async function getActiveRoadmaps(notionAdapter, options = {}) {
  const manifest = readManifest();
  const manifestPresent = fs.existsSync(MANIFEST_PATH);

  if (manifest.length === 0) {
    return { active_roadmaps: [], manifest_present: manifestPresent, manifest_path: MANIFEST_PATH, notion_available: false };
  }

  let tickets = [];
  let notionAvailable = false;
  let notionError = null;

  if (Array.isArray(options.prefetchedTickets)) {
    // Caller already paid the Notion roundtrip cost — reuse the result.
    tickets = options.prefetchedTickets;
    notionAvailable = true;
  } else {
    try {
      const result = await notionAdapter.listTickets({});
      tickets = result.tickets || [];
      notionAvailable = true;
    } catch (e) {
      notionError = e.message;
      console.warn('[plansAggregator] notion fetch failed, rendering manifest with progress: unknown — %s', e.message);
    }
  }

  // T-078: filter out retired entries (e.g. Solopreneur OS) so the Active
  // panel + Lifecycle Spectrum view stop rendering dead roadmaps. The manifest
  // keeps the entry for audit-trail; the `retired: true` flag is the live signal.
  const liveManifest = manifest.filter(r => r.retired !== true);

  const roadmaps = liveManifest.map(r => {
    const progress = notionAvailable ? computeProgress(r, tickets) : null;
    // T-078: surface `ready_to_ship: true` when every ticket in the roadmap is
    // Done. The Lifecycle Spectrum view uses this to render the "Ship this plan"
    // CTA without needing a separate roundtrip.
    const readyToShip = !!(progress && progress.total > 0 && progress.shipped === progress.total);
    return {
      slug: r.slug,
      name: r.name,
      decision_date: r.decision_date || null,
      note: r.note || '',
      spec: r.ticket_id_range
        ? { kind: 'range', from: r.ticket_id_range[0], to: r.ticket_id_range[1] }
        : { kind: 'list', ids: r.ticket_ids || [] },
      progress, // null if Notion unavailable; clients show "progress unknown"
      ready_to_ship: readyToShip,
    };
  });

  return {
    active_roadmaps: roadmaps,
    manifest_present: manifestPresent,
    manifest_path: MANIFEST_PATH,
    notion_available: notionAvailable,
    notion_error: notionError,
  };
}

// T-078 exposed helpers — lifecycleAggregator needs to read the same manifest
// without going through the public entrypoint (which calls Notion). Also
// surfaces the raw manifest so the Ship transition can mutate it atomically.
function readManifestRaw() {
  return readManifest();
}

function writeManifestRaw(entries) {
  const payload = {
    _comment: 'T-057: Active roadmaps the Daily Agenda Plans panel surfaces. Edit this file to add or retire a roadmap; ship progress is computed live from Notion via services/plansAggregator.js. Two ways to specify which tickets belong to a roadmap: ticket_id_range (inclusive bounds, must share a prefix) OR ticket_ids (explicit list). Use one or the other per entry, not both.',
    active_roadmaps: entries,
  };
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(payload, null, 2) + '\n', 'utf8');
}

// T-084: append helper consumed by lifecycleAggregator.activatePendingPlan
// (Pending → Active promote). Declared here rather than inlined at the call
// site so T-085's `→ Add to Pending` action can reuse the same helper for its
// own append path. Throws if a slug collision exists — caller decides 409.
function appendToManifest(entry) {
  if (!entry || typeof entry.slug !== 'string' || !entry.slug) {
    throw new Error('appendToManifest: entry.slug is required');
  }
  const current = readManifestRaw();
  if (current.some(e => e.slug === entry.slug)) {
    const err = new Error(`appendToManifest: slug already present in active manifest: ${entry.slug}`);
    err.status = 409;
    throw err;
  }
  writeManifestRaw([...current, entry]);
}

module.exports = {
  getActiveRoadmaps,
  parseTicketId,
  extractTicketIdFromTitle,
  makeBelongsTo,
  computeProgress,
  MANIFEST_PATH,
  // T-078 exports for lifecycleAggregator + Ship transition endpoint
  readManifestRaw,
  writeManifestRaw,
  // T-084 export for Pending → Active promote (also reused by T-085 if/when shipped)
  appendToManifest,
};
