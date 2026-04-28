#!/usr/bin/env node
/**
 * Read-only offline inspection of two SQLite snapshots.
 * Produces a side-by-side report comparing schemas and row counts,
 * plus FK-resolution stats for tickets and a spot-check of legacy tickets.
 *
 * Usage (from Development/dashboard/):
 *   node scripts/inspect-snapshots.js [dabeDbPath] [legacyDbPath]
 *
 * Defaults look in ./backups for the most recent prism-dabe-*.db and
 * prism-7058a-*.db files.
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

function latestSnapshot(backupDir, prefix) {
  if (!fs.existsSync(backupDir)) return null;
  const files = fs.readdirSync(backupDir)
    .filter(n => n.startsWith(prefix) && n.endsWith('.db'))
    .map(n => ({ n, t: fs.statSync(path.join(backupDir, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return files.length ? path.join(backupDir, files[0].n) : null;
}

function openReadOnly(file) {
  if (!file || !fs.existsSync(file)) {
    throw new Error(`Snapshot not found: ${file}`);
  }
  return new Database(file, { readonly: true, fileMustExist: true });
}

function tableList(db) {
  return db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().map(r => r.name);
}

function columnList(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all()
    .map(c => ({ name: c.name, type: c.type, pk: c.pk, notnull: c.notnull }));
}

function rowCount(db, table) {
  try {
    return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  } catch { return null; }
}

function fmtCount(n) {
  return n == null ? '—' : String(n);
}

function main() {
  const backupDir = path.join(__dirname, '..', 'backups');
  const dabePath = process.argv[2] || latestSnapshot(backupDir, 'prism-dabe-');
  const legacyPath = process.argv[3] || latestSnapshot(backupDir, 'prism-7058a-');

  console.log('Inspection report');
  console.log('=================');
  console.log('dabe:   ' + dabePath);
  console.log('legacy: ' + legacyPath);
  console.log('');

  const d = openReadOnly(dabePath);
  const l = openReadOnly(legacyPath);

  // --- 1. Table-level comparison ---
  const dTables = new Set(tableList(d));
  const lTables = new Set(tableList(l));
  const allTables = [...new Set([...dTables, ...lTables])].sort();

  console.log('Table-level comparison');
  console.log('----------------------');
  console.log('Table                            |   dabe |  legacy | delta');
  console.log('---------------------------------+--------+---------+-------');
  for (const t of allTables) {
    const inD = dTables.has(t), inL = lTables.has(t);
    const dc = inD ? rowCount(d, t) : null;
    const lc = inL ? rowCount(l, t) : null;
    let delta;
    if (!inD) delta = 'legacy-only';
    else if (!inL) delta = 'dabe-only';
    else if (lc != null && dc != null) delta = (lc - dc > 0 ? '+' : '') + (lc - dc);
    else delta = '?';
    console.log(
      t.padEnd(32, ' ') + ' | ' +
      fmtCount(dc).padStart(6, ' ') + ' | ' +
      fmtCount(lc).padStart(7, ' ') + ' | ' +
      delta
    );
  }
  console.log('');

  // --- 2. Schema diff on migration-candidate tables ---
  const candidates = ['tickets', 'business_health', 'services', 'clients'];
  console.log('Schema diffs on migration-candidate tables');
  console.log('------------------------------------------');
  for (const t of candidates) {
    if (!dTables.has(t) || !lTables.has(t)) {
      console.log(`${t}: missing on one side (dabe=${dTables.has(t)} legacy=${lTables.has(t)}) — skipping diff`);
      continue;
    }
    const dCols = new Map(columnList(d, t).map(c => [c.name, c]));
    const lCols = new Map(columnList(l, t).map(c => [c.name, c]));
    const added = [...dCols.keys()].filter(k => !lCols.has(k));   // in dabe, not in legacy
    const removed = [...lCols.keys()].filter(k => !dCols.has(k)); // in legacy, not in dabe
    const common = [...dCols.keys()].filter(k => lCols.has(k));
    const typeChanged = common.filter(k => dCols.get(k).type !== lCols.get(k).type);

    console.log(`\n${t}:`);
    console.log(`  cols common:      ${common.length}`);
    console.log(`  only on dabe:     ${added.length ? added.join(', ') : '(none)'}`);
    console.log(`  only on legacy:   ${removed.length ? removed.join(', ') : '(none)'}`);
    console.log(`  type mismatches:  ${typeChanged.length ? typeChanged.map(k => `${k}(dabe=${dCols.get(k).type}|legacy=${lCols.get(k).type})`).join(', ') : '(none)'}`);
  }
  console.log('');

  // --- 3. Tickets FK resolution (legacy → dabe) ---
  if (lTables.has('tickets') && lTables.has('clients') && dTables.has('clients')) {
    console.log('Tickets FK resolution (legacy → dabe)');
    console.log('-------------------------------------');
    const legacyTickets = l.prepare('SELECT id, client_id FROM tickets').all();
    const legacyClientIds = new Set(l.prepare('SELECT id FROM clients').all().map(r => r.id));
    const dabeClientIds = new Set(d.prepare('SELECT id FROM clients').all().map(r => r.id));

    let nullClient = 0, legacyResolvable = 0, dabeResolvable = 0, orphan = 0;
    for (const t of legacyTickets) {
      if (t.client_id == null) { nullClient++; continue; }
      const inLegacy = legacyClientIds.has(t.client_id);
      const inDabe = dabeClientIds.has(t.client_id);
      if (inDabe) dabeResolvable++;
      else if (inLegacy) legacyResolvable++;
      else orphan++;
    }
    console.log(`  legacy tickets total:                 ${legacyTickets.length}`);
    console.log(`  with client_id = NULL:                ${nullClient}`);
    console.log(`  client_id resolves on dabe already:   ${dabeResolvable}  (safe to copy as-is)`);
    console.log(`  client_id only on legacy:             ${legacyResolvable}  (needs remap or null-out)`);
    console.log(`  client_id orphan on both sides:       ${orphan}  (legacy data corruption, null-out)`);
    console.log('');
  }

  // --- 4. Legacy ticket sample + breakdown ---
  if (lTables.has('tickets')) {
    const lTicketCols = new Set(columnList(l, 'tickets').map(c => c.name));
    const hasSource = lTicketCols.has('source');
    const hasTicketKey = lTicketCols.has('ticket_key');

    console.log('Legacy ticket breakdown');
    console.log('-----------------------');

    if (hasSource) {
      const bySrc = l.prepare(`SELECT COALESCE(source, '(null)') AS source, COUNT(*) AS n FROM tickets GROUP BY source ORDER BY n DESC`).all();
      console.log('  By source:');
      for (const r of bySrc) console.log(`    ${r.source.padEnd(20, ' ')} ${r.n}`);
    } else {
      console.log('  (legacy has no `source` column — all tickets will need synthetic source tag)');
    }

    const bySt = l.prepare(`SELECT COALESCE(status, '(null)') AS status, COUNT(*) AS n FROM tickets GROUP BY status ORDER BY n DESC`).all();
    console.log('  By status:');
    for (const r of bySt) console.log(`    ${r.status.padEnd(20, ' ')} ${r.n}`);

    console.log('');
    console.log('Spot-check — 8 legacy tickets (newest first):');
    const sampleCols = ['id', hasTicketKey ? 'ticket_key' : null, 'title', 'status', 'priority', 'created_at', hasSource ? 'source' : null]
      .filter(Boolean).join(', ');
    const sample = l.prepare(`SELECT ${sampleCols} FROM tickets ORDER BY created_at DESC LIMIT 8`).all();
    for (const row of sample) {
      const key = row.ticket_key || row.id.slice(0, 8);
      const src = row.source ? `  [${row.source}]` : '';
      console.log(`  ${key.padEnd(12, ' ')} ${String(row.created_at).slice(0, 10)}  ${(row.status || '').padEnd(12)}  ${row.title}${src}`);
    }
    console.log('');
  }

  // --- 5. Business health / services snapshots ---
  for (const t of ['business_health', 'services']) {
    if (!lTables.has(t)) continue;
    const lCount = rowCount(l, t);
    const dCount = dTables.has(t) ? rowCount(d, t) : 0;
    if (lCount > 0) {
      console.log(`${t}: legacy=${lCount} rows, dabe=${dCount} rows`);
      // Show columns so we can plan
      console.log('  columns: ' + columnList(l, t).map(c => c.name).join(', '));
      // Show a couple of samples
      const sample = l.prepare(`SELECT * FROM ${t} LIMIT 3`).all();
      sample.forEach((row, i) => {
        const keys = Object.keys(row).slice(0, 6);
        console.log(`  sample[${i}]: ` + keys.map(k => `${k}=${JSON.stringify(row[k])}`).join(', '));
      });
      console.log('');
    }
  }

  d.close();
  l.close();
  console.log('Done. (both snapshots closed, read-only — no writes occurred)');
}

main();
