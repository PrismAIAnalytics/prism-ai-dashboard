#!/usr/bin/env node
// apply-reconciliation.js — T-025. Reads a duplicates CSV from
// audit-duplicates.js with the `resolution` column filled in, then executes
// the chosen resolution per row.
//
// Resolutions:
//   keep_notion   — Notion is canonical. SQLite row stays as-is (the SQLite
//                   `tickets` and `action_items` tables are being dropped in
//                   T-020 Phase 4 anyway). Logged for the record.
//   keep_sqlite   — SQLite is canonical. Push SQLite's values for the conflict
//                   fields into Notion via the Notion API.
//   merge_manual  — Skip with a warning. Handle in the Notion UI.
//   archive_both  — Archive the Notion page. The matching SQLite row is left
//                   alone (will be dropped in T-020 Phase 4).
//
// Field-direction note: this script only ever PATCHes Notion. It never touches
// SQLite. Rationale: SQLite is about to be retired in Phase 4; mutating it now
// is wasted effort. If a user-facing dashboard read needs to show the
// reconciled value before Phase 4 ships, set USE_NOTION_SOURCE=true in Railway
// — that flips reads to Notion via the existing notionAdapter (T-023).
//
// Usage:
//   node scripts/apply-reconciliation.js <csv>
//   node scripts/apply-reconciliation.js <csv> --dry-run
//   node scripts/apply-reconciliation.js <csv> --limit=N
//   node scripts/apply-reconciliation.js <csv> --yes

'use strict';

const fs = require('fs');
const path = require('path');

try {
  const envFile = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
  for (const line of envFile.split('\n')) {
    const m = line.replace(/\r$/, '').match(/^\s*([^#=]+?)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) {
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  }
} catch (e) { if (e.code !== 'ENOENT') console.warn('[.env]', e.message); }

const args = process.argv.slice(2);
const CSV_PATH = args.find(a => !a.startsWith('--'));
const DRY_RUN = args.includes('--dry-run');
const SKIP_PAUSE = args.includes('--yes');
const LIMIT_FLAG = args.find(a => a.startsWith('--limit='));
const LIMIT = LIMIT_FLAG ? parseInt(LIMIT_FLAG.split('=')[1], 10) : Infinity;

if (!CSV_PATH) { console.error('Usage: apply-reconciliation.js <csv> [--dry-run] [--limit=N] [--yes]'); process.exit(1); }
if (!fs.existsSync(CSV_PATH)) { console.error(`CSV not found: ${CSV_PATH}`); process.exit(1); }

const NOTION_KEY = process.env.NOTION_API_KEY;
if (!DRY_RUN && !NOTION_KEY) { console.error('Missing NOTION_API_KEY (real runs only)'); process.exit(1); }

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';
const REQ_INTERVAL_MS = 500;

const today = new Date().toISOString().split('T')[0];
const REPORTS_DIR = path.join(__dirname, '..', 'reports');
const LOG_PATH = path.join(REPORTS_DIR, `reconciliation-log-${today}.jsonl`);

// ─── CSV parser ────────────────────────────────────────────────────────────
function parseCsvLine(line) {
  const out = []; let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQ = !inQ; continue; }
    if (c === ',' && !inQ) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const header = lines[0].split(',');
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    const row = {};
    header.forEach((h, j) => { row[h] = cells[j] || ''; });
    rows.push(row);
  }
  return { header, rows };
}

// ─── Format mappers (Notion canonical case) ───────────────────────────────
const PRIORITY_SQLITE_TO_NOTION = { urgent: 'Urgent', high: 'High', medium: 'Medium', low: 'Low' };
const STATUS_SQLITE_TO_NOTION = {
  backlog: 'Not started',
  in_progress: 'In progress',
  blocked: 'Blocked',
  done: 'Done',
};

function notionPropertyUpdates(row) {
  // Returns a Notion `properties` patch object built from SQLite's values for
  // the fields listed in conflict_fields. Used for keep_sqlite resolution.
  const conflictFields = (row.conflict_fields || '').split(';').filter(Boolean);
  const props = {};
  for (const field of conflictFields) {
    switch (field) {
      case 'priority': {
        const v = PRIORITY_SQLITE_TO_NOTION[(row.priority_sqlite || '').toLowerCase()];
        if (v) props['Priority'] = { select: { name: v } };
        break;
      }
      case 'status': {
        const v = STATUS_SQLITE_TO_NOTION[(row.status_sqlite || '').toLowerCase()];
        if (v) props['Status'] = { status: { name: v } };
        break;
      }
      case 'due_date': {
        if (row.due_sqlite) props['Due Date'] = { date: { start: row.due_sqlite } };
        else props['Due Date'] = { date: null };
        break;
      }
      // category/title intentionally not pushed back — too risky to overwrite
      // Notion-canonical category/title from a SQLite mirror.
      default: break;
    }
  }
  return props;
}

// ─── Notion API ────────────────────────────────────────────────────────────
async function patchNotionPage(pageId, properties) {
  const r = await fetch(`${NOTION_API}/pages/${pageId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${NOTION_KEY}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ properties }),
  });
  if (!r.ok) throw new Error(`patch ${pageId}: ${r.status} ${await r.text().catch(() => '')}`);
  return r.json();
}

async function archiveNotionPage(pageId) {
  const r = await fetch(`${NOTION_API}/pages/${pageId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${NOTION_KEY}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ archived: true }),
  });
  if (!r.ok) throw new Error(`archive ${pageId}: ${r.status} ${await r.text().catch(() => '')}`);
  return r.json();
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Main ──────────────────────────────────────────────────────────────────
(async () => {
  const text = fs.readFileSync(CSV_PATH, 'utf8');
  const { rows } = parseCsv(text);

  // Only act on rows where resolution is set
  const decided = rows.filter(r => (r.resolution || '').trim());
  const byRes = decided.reduce((acc, r) => { acc[r.resolution] = (acc[r.resolution] || 0) + 1; return acc; }, {});

  console.log(`\nParsed ${rows.length} CSV rows · ${decided.length} have a resolution set`);
  for (const [k, v] of Object.entries(byRes)) console.log(`  ${k}: ${v}`);

  const plan = decided.slice(0, LIMIT);
  if (plan.length < decided.length) {
    console.log(`\n--limit=${LIMIT} → executing first ${plan.length} of ${decided.length}`);
  }
  if (plan.length === 0) { console.log('\nNothing to do. Exiting.'); return; }

  console.log(`\nPlanned actions (${plan.length}):`);
  for (const r of plan) {
    const t = (r.title_notion || r.title_sqlite || '').slice(0, 40);
    let detail = '';
    if (r.resolution === 'keep_sqlite') {
      const props = notionPropertyUpdates(r);
      detail = ` → Notion PATCH: ${Object.keys(props).join(', ') || '(no fields)'}`;
    } else if (r.resolution === 'archive_both') {
      detail = ' → Notion archive';
    } else if (r.resolution === 'keep_notion') {
      detail = ' → log only (SQLite stays; tables drop in T-020 Phase 4)';
    } else if (r.resolution === 'merge_manual') {
      detail = ' → SKIP (handle in Notion UI)';
    }
    console.log(`  ${r.resolution.padEnd(13)} ${(r.prism_id || '?').padEnd(10)} ${(r.sqlite_key || '?').padEnd(10)} ${t}${detail}`);
  }

  if (DRY_RUN) { console.log('\n[DRY RUN] No Notion calls made.'); return; }

  console.log(`\nLog: ${LOG_PATH}`);
  if (!SKIP_PAUSE) { console.log('Starting in 5 seconds — Ctrl-C to abort.'); await sleep(5000); }

  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const logStream = fs.createWriteStream(LOG_PATH, { flags: 'a' });

  let ok = 0, fail = 0, skipped = 0;
  for (const r of plan) {
    const base = {
      ts: new Date().toISOString(),
      prism_id: r.prism_id,
      sqlite_key: r.sqlite_key,
      notion_page_id: r.notion_page_id,
      resolution: r.resolution,
      conflict_fields: r.conflict_fields,
    };
    try {
      if (r.resolution === 'keep_notion') {
        logStream.write(JSON.stringify({ ...base, action: 'logged-no-mutation', note: 'SQLite tables drop in T-020 Phase 4; Notion is canonical' }) + '\n');
        console.log(`  log  ${r.prism_id}`);
        ok++;
      } else if (r.resolution === 'keep_sqlite') {
        const props = notionPropertyUpdates(r);
        if (Object.keys(props).length === 0) {
          logStream.write(JSON.stringify({ ...base, action: 'skipped-no-mappable-fields' }) + '\n');
          console.log(`  skip ${r.prism_id} (no mappable conflict fields)`);
          skipped++;
        } else {
          await patchNotionPage(r.notion_page_id, props);
          logStream.write(JSON.stringify({ ...base, action: 'notion-patched', props_pushed: Object.keys(props) }) + '\n');
          console.log(`  ok   ${r.prism_id} → Notion PATCH ${Object.keys(props).join(',')}`);
          ok++;
        }
      } else if (r.resolution === 'archive_both') {
        await archiveNotionPage(r.notion_page_id);
        logStream.write(JSON.stringify({ ...base, action: 'notion-archived' }) + '\n');
        console.log(`  ok   ${r.prism_id} → Notion archived`);
        ok++;
      } else if (r.resolution === 'merge_manual') {
        logStream.write(JSON.stringify({ ...base, action: 'skipped-merge-manual' }) + '\n');
        console.log(`  skip ${r.prism_id} (merge_manual — handle in Notion UI)`);
        skipped++;
      } else {
        logStream.write(JSON.stringify({ ...base, action: 'unknown-resolution', resolution: r.resolution }) + '\n');
        console.log(`  WARN ${r.prism_id} unknown resolution '${r.resolution}'`);
        skipped++;
      }
    } catch (e) {
      fail++;
      logStream.write(JSON.stringify({ ...base, action: 'error', error: e.message }) + '\n');
      console.log(`  FAIL ${r.prism_id} — ${e.message}`);
    }
    if (r.resolution === 'keep_sqlite' || r.resolution === 'archive_both') {
      await sleep(REQ_INTERVAL_MS);
    }
  }
  logStream.end();

  console.log(`\nDone. ok=${ok} skipped=${skipped} fail=${fail}`);
  console.log(`Log: ${LOG_PATH}`);
  if (fail > 0) process.exit(1);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
