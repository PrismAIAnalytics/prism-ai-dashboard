#!/usr/bin/env node
/**
 * Read-only FK inspection for the migration-candidate tables on the legacy
 * snapshot. For each table in the allowlist, prints PRAGMA foreign_key_list
 * output so we know which columns reference clients (skipped) or other
 * tables we may also be skipping.
 *
 * Usage:
 *   node scripts/inspect-fks.js [legacyDbPath]
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const ALLOWLIST_TABLES = [
  'industries', 'lead_sources', 'team_members', 'services', 'tools',
  'users', 'business_assets', 'action_items', 'expenses', 'invoices',
  'payments', 'projects', 'tickets', 'time_entries', 'contacts'
];

// Tables we are NOT migrating from legacy. Any FK pointing here needs
// to be NULLed (or the row dropped) when copying.
const SKIPPED_TABLES = new Set([
  'clients', 'contacts',
  'daily_reviews', 'maturity_scores',
  'dev_sessions', 'dev_facets', 'dev_insight_tickets',
  'activity_log', 'sessions', 'magic_link_tokens'
]);

function latestSnapshot(backupDir, prefix) {
  if (!fs.existsSync(backupDir)) return null;
  const files = fs.readdirSync(backupDir)
    .filter(n => n.startsWith(prefix) && n.endsWith('.db'))
    .map(n => ({ n, t: fs.statSync(path.join(backupDir, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return files.length ? path.join(backupDir, files[0].n) : null;
}

function main() {
  const backupDir = path.join(__dirname, '..', 'backups');
  const legacy = process.argv[2] || latestSnapshot(backupDir, 'prism-7058a-');
  if (!legacy || !fs.existsSync(legacy)) {
    console.error(`Legacy snapshot not found: ${legacy}`);
    process.exit(1);
  }
  console.log(`Legacy snapshot: ${legacy}\n`);

  const db = new Database(legacy, { readonly: true, fileMustExist: true });

  for (const t of ALLOWLIST_TABLES) {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
    if (!exists) {
      console.log(`${t}: TABLE DOES NOT EXIST on legacy — skipping`);
      console.log('');
      continue;
    }
    const fks = db.prepare(`PRAGMA foreign_key_list(${t})`).all();
    const cols = db.prepare(`PRAGMA table_info(${t})`).all();
    const rows = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;

    console.log(`### ${t}  (rows=${rows})`);

    if (fks.length === 0) {
      console.log('  no FKs');
    } else {
      for (const f of fks) {
        const tgtSkipped = SKIPPED_TABLES.has(f.table) ? '  ⚠ SKIPPED TARGET' : '';
        console.log(`  ${f.from} → ${f.table}.${f.to}${tgtSkipped}`);
      }
    }

    // Distinct values for FK columns (only if rows > 0 and FK targets a skipped table)
    if (rows > 0) {
      for (const f of fks) {
        if (!SKIPPED_TABLES.has(f.table)) continue;
        try {
          const stat = db.prepare(`SELECT COUNT(*) AS total, COUNT(${f.from}) AS nonnull, COUNT(DISTINCT ${f.from}) AS distinct_ids FROM ${t}`).get();
          console.log(`    ${f.from}: total=${stat.total}, nonnull=${stat.nonnull}, distinct=${stat.distinct_ids}  → must null-out on copy`);
        } catch (e) {
          console.log(`    ${f.from}: error querying — ${e.message}`);
        }
      }
    }

    // Note PK type
    const pks = cols.filter(c => c.pk).map(c => `${c.name} (${c.type || 'no type'})`);
    if (pks.length) console.log(`  PK: ${pks.join(', ')}`);

    console.log('');
  }

  db.close();
}

main();
