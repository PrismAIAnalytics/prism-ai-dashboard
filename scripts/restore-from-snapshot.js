#!/usr/bin/env node
/**
 * Local driver for POST /api/admin/restore-from-snapshot.
 *
 * Defaults to dry-run. Use --confirm to perform live writes (requires
 * the server to also receive header X-Confirm-Token: LIVE-WRITE-CONFIRMED,
 * which this script will send when --confirm is set).
 *
 * Usage (from Development/dashboard/):
 *   # dry-run against local dev server (default)
 *   node scripts/restore-from-snapshot.js --target http://localhost:3000
 *
 *   # dry-run against prod
 *   $env:DABE_ADMIN_KEY = "..."
 *   node scripts/restore-from-snapshot.js
 *
 *   # live write against prod
 *   node scripts/restore-from-snapshot.js --confirm
 *
 * Env vars:
 *   DABE_ADMIN_KEY   ADMIN_KEY for the target (required unless --admin-key)
 *
 * Flags:
 *   --target <url>       base URL of target server
 *                        (default https://dashboard-api-production-dabe.up.railway.app)
 *   --snapshot <path>    path to snapshot .db file
 *                        (default: latest backups/prism-7058a-*.db)
 *   --admin-key <key>    overrides $DABE_ADMIN_KEY
 *   --confirm            disables dry-run; sends X-Confirm-Token. Off by default.
 */

const path = require('path');
const fs = require('fs');

function parseArgs(argv) {
  const args = { confirm: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--confirm') args.confirm = true;
    else if (a === '--target') args.target = argv[++i];
    else if (a === '--snapshot') args.snapshot = argv[++i];
    else if (a === '--admin-key') args.adminKey = argv[++i];
    else { console.error(`Unknown arg: ${a}`); process.exit(2); }
  }
  return args;
}

function latestSnapshot(backupDir, prefix) {
  if (!fs.existsSync(backupDir)) return null;
  const files = fs.readdirSync(backupDir)
    .filter(n => n.startsWith(prefix) && n.endsWith('.db'))
    .map(n => ({ n, t: fs.statSync(path.join(backupDir, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return files.length ? path.join(backupDir, files[0].n) : null;
}

function fmtNum(n) {
  return Number(n).toLocaleString('en-US');
}

function printReport(report) {
  console.log('');
  console.log(`Mode:           ${report.mode.toUpperCase()}`);
  console.log(`Live DB path:   ${report.liveDbPath}`);
  console.log(`Snapshot bytes: ${fmtNum(report.snapshotBytes)}`);
  console.log('');
  console.log('Per-table results:');
  console.log('  table              snapshot   live   planned   actual  dupes  fk-skip  errors  status');
  console.log('  ' + '-'.repeat(85));
  for (const t of report.tables) {
    const status = t.error ? `ERR: ${t.error.slice(0, 30)}` : (report.mode === 'dry-run' ? 'plan' : 'ok');
    console.log(
      '  ' +
      t.table.padEnd(18) +
      String(t.snapshotRows).padStart(8) +
      String(t.liveExisting).padStart(7) +
      String(t.plannedInserts).padStart(10) +
      String(t.actualInserts).padStart(9) +
      String(t.skippedDuplicates ?? '').padStart(7) +
      String(t.skippedFkViolation ?? '').padStart(9) +
      String(t.otherErrors ?? '').padStart(8) +
      '  ' + status
    );
  }
  console.log('  ' + '-'.repeat(85));
  console.log(
    '  TOTALS' + ' '.repeat(12) +
    String(report.totals.snapshotRows).padStart(8) +
    ' '.repeat(7) +
    String(report.totals.plannedInserts).padStart(10) +
    String(report.totals.actualInserts).padStart(9)
  );
  if (report.totals.tablesWithErrors > 0) {
    console.log(`  ${report.totals.tablesWithErrors} table(s) reported errors — review above.`);
  }
  console.log('');
}

async function main() {
  const args = parseArgs(process.argv);
  const target = args.target || 'https://dashboard-api-production-dabe.up.railway.app';
  const adminKey = args.adminKey || process.env.DABE_ADMIN_KEY;
  if (!adminKey) {
    console.error('Missing admin key. Set $env:DABE_ADMIN_KEY or pass --admin-key.');
    process.exit(1);
  }

  const backupDir = path.join(__dirname, '..', 'backups');
  const snapshotPath = args.snapshot || latestSnapshot(backupDir, 'prism-7058a-');
  if (!snapshotPath || !fs.existsSync(snapshotPath)) {
    console.error(`Snapshot not found: ${snapshotPath}`);
    process.exit(1);
  }

  const buf = fs.readFileSync(snapshotPath);
  const url = `${target.replace(/\/+$/, '')}/api/admin/restore-from-snapshot${args.confirm ? '?dry-run=false' : '?dry-run=true'}`;

  console.log(`Snapshot:    ${snapshotPath}`);
  console.log(`Bytes:       ${fmtNum(buf.length)}`);
  console.log(`Target:      ${url}`);
  console.log(`Mode:        ${args.confirm ? 'LIVE WRITE' : 'dry-run'}`);
  if (args.confirm) {
    console.log('             ⚠  Live mode is destructive (idempotent INSERT OR IGNORE,');
    console.log('             ⚠  but inserts cannot be undone except by restoring from backup).');
  }
  console.log('Posting...');

  const headers = {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(buf.length),
    'X-Admin-Key': adminKey
  };
  if (args.confirm) {
    headers['X-Confirm-Token'] = 'LIVE-WRITE-CONFIRMED';
  }

  let resp;
  try {
    resp = await fetch(url, { method: 'POST', headers, body: buf });
  } catch (e) {
    console.error('Network error:', e.message);
    process.exit(1);
  }

  const text = await resp.text();
  let json;
  try { json = JSON.parse(text); }
  catch {
    console.error(`Non-JSON response (HTTP ${resp.status}):`);
    console.error(text);
    process.exit(1);
  }

  if (!resp.ok || !json.ok) {
    console.error(`Server returned HTTP ${resp.status}:`);
    console.error(JSON.stringify(json, null, 2));
    process.exit(1);
  }

  printReport(json);
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
