#!/usr/bin/env node
/**
 * Compare table schemas between two SQLite snapshots for the tables that
 * silently failed during the T-009 live restore. Looks for columns that
 * exist on the live target but not on the legacy snapshot, and flags
 * NOT NULL columns without a default — those silently kill INSERT OR IGNORE.
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const TABLES = ['projects', 'invoices', 'time_entries', 'payments'];

function latestSnapshot(backupDir, prefix) {
  if (!fs.existsSync(backupDir)) return null;
  const files = fs.readdirSync(backupDir)
    .filter(n => n.startsWith(prefix) && n.endsWith('.db'))
    .map(n => ({ n, t: fs.statSync(path.join(backupDir, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return files.length ? path.join(backupDir, files[0].n) : null;
}

function cols(db, t) {
  return db.prepare(`PRAGMA table_info(${t})`).all();
}

function main() {
  const backupDir = path.join(__dirname, '..', 'backups');
  const legacy = latestSnapshot(backupDir, 'prism-7058a-');
  const dabe = latestSnapshot(backupDir, 'prism-dabe-');

  console.log(`legacy: ${legacy}`);
  console.log(`dabe:   ${dabe}\n`);

  const l = new Database(legacy, { readonly: true });
  const d = new Database(dabe, { readonly: true });

  for (const t of TABLES) {
    const lcols = new Map(cols(l, t).map(c => [c.name, c]));
    const dcols = new Map(cols(d, t).map(c => [c.name, c]));
    console.log(`### ${t}`);
    console.log(`  legacy cols: ${lcols.size}, dabe cols: ${dcols.size}`);

    const onlyOnDabe = [...dcols.keys()].filter(k => !lcols.has(k));
    const onlyOnLegacy = [...lcols.keys()].filter(k => !dcols.has(k));

    // Compare per-column attributes (notnull, default, type, pk) on shared cols
    const shared = [...lcols.keys()].filter(k => dcols.has(k));
    const attrDiffs = [];
    for (const k of shared) {
      const a = lcols.get(k), b = dcols.get(k);
      if (a.notnull !== b.notnull || a.dflt_value !== b.dflt_value || a.type !== b.type || a.pk !== b.pk) {
        attrDiffs.push({ col: k, legacy: a, dabe: b });
      }
    }

    if (onlyOnDabe.length === 0 && onlyOnLegacy.length === 0 && attrDiffs.length === 0) {
      console.log('  ✓ schemas match (names, types, notnull, defaults, pk)');
      // Still dump CREATE TABLE for visual sanity
      const lsql = l.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(t).sql;
      const dsql = d.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(t).sql;
      if (lsql !== dsql) {
        console.log('  ⚠ but CREATE TABLE SQL differs (table-level constraints?):');
        console.log('  --- legacy ---');
        console.log('  ' + lsql.replace(/\n/g, '\n  '));
        console.log('  --- dabe ---');
        console.log('  ' + dsql.replace(/\n/g, '\n  '));
      }
      console.log('');
      continue;
    }
    if (attrDiffs.length) {
      console.log('  per-column attribute drift:');
      for (const d of attrDiffs) {
        console.log(`    ${d.col}:`);
        console.log(`      legacy: type=${d.legacy.type} notnull=${d.legacy.notnull} default=${d.legacy.dflt_value} pk=${d.legacy.pk}`);
        console.log(`      dabe:   type=${d.dabe.type} notnull=${d.dabe.notnull} default=${d.dabe.dflt_value} pk=${d.dabe.pk}`);
      }
    }

    if (onlyOnDabe.length) {
      console.log('  columns only on dabe:');
      for (const k of onlyOnDabe) {
        const c = dcols.get(k);
        const nullable = c.notnull ? 'NOT NULL' : 'nullable';
        const def = c.dflt_value != null ? `default=${c.dflt_value}` : '(no default)';
        const danger = c.notnull && c.dflt_value == null ? '  ← SILENT KILLER (NOT NULL, no default)' : '';
        console.log(`    ${k} ${c.type} ${nullable} ${def}${danger}`);
      }
    }
    if (onlyOnLegacy.length) {
      console.log('  columns only on legacy (informational):');
      for (const k of onlyOnLegacy) {
        const c = lcols.get(k);
        console.log(`    ${k} ${c.type} ${c.notnull ? 'NOT NULL' : 'nullable'}`);
      }
    }
    console.log('');
  }
  l.close();
  d.close();
}

main();
