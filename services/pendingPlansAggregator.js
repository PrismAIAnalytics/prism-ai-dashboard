// pendingPlansAggregator.js — T-065. Powers the Daily Agenda's Pending Plans panel.
//
// Reads config/pending-plans.json (a hand-curated manifest of plans awaiting
// Michele's approval) and auto-scans ~/.claude/plans/ for recent plan files
// carrying explicit "Draft for review" / "Not approved" / "For review:" markers.
// Auto-scan results that aren't already in the manifest are returned as
// `suggested_plans` so Michele can promote them by editing the manifest.
//
// Manifest entry shape:
//   {
//     slug, name, plan_file, created_date, review_date, summary
//   }
//
// Auto-suggested entry shape:
//   {
//     slug, name, plan_file, modified_date, source: 'auto_scan'
//   }
//
// Railway behavior: ~/.claude/plans/ does not exist on Railway, so the auto-scan
// gracefully degrades — `suggested_plans` returns empty and `plans_dir_available`
// returns false. The manifest entries always render.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// Manifest path: config/ rather than data/ because Railway mounts a persistent
// volume at /app/data for the SQLite WAL file which would overlay COPY'd files
// (same reasoning as T-063's plansAggregator manifest relocation).
const MANIFEST_PATH = path.resolve(path.join(__dirname, '..', 'config', 'pending-plans.json'));

// Plans directory — overridable via env for testing. Defaults to ~/.claude/plans/
// which exists on Michele's local machine but not on Railway.
const PLANS_DIR = process.env.PRISM_PLANS_DIR || path.join(os.homedir(), '.claude', 'plans');

// Only auto-suggest plans modified in the last N days. Older files are usually
// stale ExitPlanMode artifacts from past conversations, not active review items.
const SUGGESTION_WINDOW_DAYS = 7;

// Substring markers that signal a plan is awaiting review. Case-insensitive,
// matched against the first ~4KB of the file (covers frontmatter + top headers).
const REVIEW_MARKERS = [
  /draft for review/i,
  /for review:/i,
  /not approved/i,
  /awaiting (review|approval)/i,
  /deferred for review/i,
];

function readManifest() {
  try {
    const raw = fs.readFileSync(MANIFEST_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.pending_plans) ? parsed.pending_plans : [];
  } catch (e) {
    console.warn('[pendingPlansAggregator] failed to read manifest:', e.message);
    return [];
  }
}

// Inspect a plan file's first ~4KB for a review marker. Returns {headline} when
// a marker is found, or null when no marker matches or the file can't be read.
function inspectPlanFile(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(4096);
    const bytes = fs.readSync(fd, buf, 0, 4096, 0);
    fs.closeSync(fd);
    const head = buf.slice(0, bytes).toString('utf8');

    const hasMarker = REVIEW_MARKERS.some((re) => re.test(head));
    if (!hasMarker) return null;

    const h1 = head.match(/^#\s+(.+?)$/m);
    const headline = h1 ? h1[1].trim() : path.basename(filePath, '.md');
    return { headline };
  } catch (e) {
    return null;
  }
}

// Walk PLANS_DIR for .md files modified within the suggestion window that carry
// a review marker and aren't already represented in the manifest. Returns
// {suggested: [...], available: bool}.
function scanPlansDir(manifestBasenames) {
  if (!fs.existsSync(PLANS_DIR)) {
    return { suggested: [], available: false };
  }

  let entries;
  try {
    entries = fs.readdirSync(PLANS_DIR, { withFileTypes: true });
  } catch (e) {
    console.warn('[pendingPlansAggregator] readdir failed:', e.message);
    return { suggested: [], available: false };
  }

  const cutoff = Date.now() - SUGGESTION_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const suggested = [];

  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.endsWith('.md')) continue;
    if (manifestBasenames.has(ent.name)) continue;

    const filePath = path.join(PLANS_DIR, ent.name);
    let st;
    try {
      st = fs.statSync(filePath);
    } catch {
      continue;
    }
    if (st.mtimeMs < cutoff) continue;

    const inspect = inspectPlanFile(filePath);
    if (!inspect) continue;

    suggested.push({
      slug: ent.name.replace(/\.md$/, ''),
      name: inspect.headline,
      plan_file: filePath,
      modified_date: new Date(st.mtimeMs).toISOString().slice(0, 10),
      source: 'auto_scan',
    });
  }

  suggested.sort((a, b) => b.modified_date.localeCompare(a.modified_date));
  return { suggested, available: true };
}

// T-084: writer counterpart to readManifest. Preserves the existing wrapper
// shape `{ pending_plans: [...] }` and prepends a self-documenting _comment
// matching the convention used by plansAggregator.writeManifestRaw.
function writeManifest(entries) {
  const payload = {
    _comment: 'T-065: Plans awaiting Michele\'s approval. Surfaces as Pending-state rows on the Daily Agenda Lifecycle table. T-084 added the activate/dismiss endpoints — entries are removed from this file when promoted to Active (via plansAggregator.appendToManifest) or dismissed outright.',
    pending_plans: entries,
  };
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(payload, null, 2) + '\n', 'utf8');
}

async function getPendingPlans(plansAggregator) {
  const manifest = readManifest();
  const manifestPresent = fs.existsSync(MANIFEST_PATH);

  // T-084: self-healing dedup — if a partial two-file write left a slug in
  // both pending and active manifests, surface it in Active only. plansAggregator
  // is passed in (rather than required at the top) to avoid a circular
  // dependency since plansAggregator never imports this module today.
  let displayManifest = manifest;
  if (plansAggregator && typeof plansAggregator.readManifestRaw === 'function') {
    try {
      const activeSlugs = new Set(plansAggregator.readManifestRaw().map(e => e.slug).filter(Boolean));
      displayManifest = manifest.filter(p => !activeSlugs.has(p.slug));
    } catch (e) {
      // Don't fail the Pending render if active manifest is unreadable —
      // fall back to raw manifest. Logged at warn.
      console.warn('[pendingPlansAggregator] dedup filter failed:', e.message);
    }
  }

  const manifestBasenames = new Set(
    manifest.map((p) => (p.plan_file ? path.basename(p.plan_file) : '')).filter(Boolean)
  );
  const scan = scanPlansDir(manifestBasenames);

  return {
    pending_plans: displayManifest,
    suggested_plans: scan.suggested,
    manifest_present: manifestPresent,
    manifest_path: MANIFEST_PATH,
    plans_dir_available: scan.available,
    plans_dir_path: PLANS_DIR,
  };
}

module.exports = {
  getPendingPlans,
  MANIFEST_PATH,
  PLANS_DIR,
  inspectPlanFile,
  scanPlansDir,
  // T-084 exports for activate/dismiss handlers
  readManifest,
  writeManifest,
};
