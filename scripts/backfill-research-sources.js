#!/usr/bin/env node
/**
 * backfill-research-sources.js (T-113)
 *
 * Idempotent loader: reads config/research-sources-backfill.json and POSTs each
 * record to /api/research-sources, skipping any (url, cited_in) pair already
 * present so re-runs are safe.
 *
 * Usage:
 *   node scripts/backfill-research-sources.js                 # dry-run vs prod (no writes)
 *   node scripts/backfill-research-sources.js --local         # dry-run vs localhost:3000
 *   node scripts/backfill-research-sources.js --local --apply # write to localhost:3000
 *   node scripts/backfill-research-sources.js --apply         # write to prod (needs API_KEY)
 *   node scripts/backfill-research-sources.js --base=https://… --apply
 *
 * Auth: sends `Authorization: Bearer $API_KEY` when API_KEY is set in env.
 * Default base is the production dashboard; default mode is dry-run.
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const has = (f) => args.includes(`--${f}`);
const getArg = (name, def) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : def;
};

const PROD = 'https://portal.prismaianalytics.com';
const base = (getArg('base', has('local') ? 'http://localhost:3000' : PROD)).replace(/\/$/, '');
const apply = has('apply');
const API_KEY = process.env.API_KEY || '';
const DATA = path.resolve(__dirname, '..', 'config', 'research-sources-backfill.json');

const authHeaders = (extra = {}) => (API_KEY ? { Authorization: `Bearer ${API_KEY}`, ...extra } : { ...extra });

async function existingUrlsFor(citedIn) {
  const url = `${base}/api/research-sources?cited_in=${encodeURIComponent(citedIn)}&limit=1000`;
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) throw new Error(`GET ${citedIn} → HTTP ${res.status}`);
  const data = await res.json();
  return new Set((data.sources || []).map((s) => s.url));
}

async function main() {
  if (!fs.existsSync(DATA)) {
    console.error(`Backfill data not found at ${DATA}. Run: node scripts/generate-research-backfill.js`);
    process.exit(1);
  }
  const { records } = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  console.log(`Target: ${base}  ·  mode: ${apply ? 'APPLY (writes)' : 'dry-run'}  ·  auth: ${API_KEY ? 'Bearer' : 'none'}`);
  console.log(`Loaded ${records.length} candidate records.\n`);

  // Group by cited_in so we query existing URLs once per blog.
  const byCited = new Map();
  for (const r of records) {
    if (!byCited.has(r.cited_in)) byCited.set(r.cited_in, []);
    byCited.get(r.cited_in).push(r);
  }

  let created = 0, skipped = 0, failed = 0;
  for (const [citedIn, group] of byCited) {
    let existing;
    try {
      existing = await existingUrlsFor(citedIn);
    } catch (e) {
      console.error(`! ${citedIn}: could not read existing (${e.message}) — skipping group`);
      failed += group.length;
      continue;
    }
    for (const rec of group) {
      if (existing.has(rec.url)) { skipped++; continue; }
      if (!apply) { created++; continue; } // dry-run counts what WOULD be created
      try {
        const res = await fetch(`${base}/api/research-sources`, {
          method: 'POST',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify(rec),
        });
        if (res.status === 201) { created++; existing.add(rec.url); }
        else { failed++; console.error(`! POST ${rec.url} → HTTP ${res.status}`); }
      } catch (e) {
        failed++; console.error(`! POST ${rec.url} → ${e.message}`);
      }
    }
  }

  console.log(`\n${apply ? 'Created' : 'Would create'}: ${created} · Skipped (already present): ${skipped} · Failed: ${failed}`);
  if (!apply) console.log('Dry-run only — re-run with --apply to write.');
}

main().catch((e) => { console.error(e); process.exit(1); });
