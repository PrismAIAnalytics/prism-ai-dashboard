/**
 * One-shot script for T-031: inject the brand CSS <link> tags into every
 * HTML page under public/. Additive only — never modifies existing markup.
 * Idempotent: re-running detects existing links and skips.
 *
 * Run from repo root:
 *   node scripts/inject-brand-css-links.js
 *
 * Safe to delete after T-031 merges. Kept committed so the diff is auditable
 * in PR review.
 */
const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const LINKS = [
  '<link rel="stylesheet" href="/styles/tokens.css">',
  '<link rel="stylesheet" href="/styles/base.css">',
  '<link rel="stylesheet" href="/styles/components.css">',
].join('\n');

const STYLE_TAG = '<style>';
const SENTINEL = '/styles/tokens.css';

function processFile(filePath) {
  const original = fs.readFileSync(filePath, 'utf8');
  if (original.includes(SENTINEL)) {
    return { file: path.basename(filePath), status: 'skipped (already linked)' };
  }
  const idx = original.indexOf(STYLE_TAG);
  if (idx === -1) {
    return { file: path.basename(filePath), status: 'no <style> tag — skipped' };
  }
  // Preserve the existing line ending convention by detecting it once.
  const lineEnding = original.includes('\r\n') ? '\r\n' : '\n';
  const insertion = LINKS.split('\n').join(lineEnding) + lineEnding;
  const before = original.slice(0, idx);
  const after = original.slice(idx);
  const next = before + insertion + after;
  fs.writeFileSync(filePath, next, 'utf8');
  return { file: path.basename(filePath), status: 'updated' };
}

function main() {
  const files = fs
    .readdirSync(PUBLIC_DIR)
    .filter(f => f.toLowerCase().endsWith('.html'))
    .map(f => path.join(PUBLIC_DIR, f));

  const results = files.map(processFile);
  const updated = results.filter(r => r.status === 'updated').length;
  const skipped = results.filter(r => r.status.startsWith('skipped')).length;
  const missing = results.filter(r => r.status.includes('no <style>')).length;

  for (const r of results) console.log(`  ${r.status.padEnd(28)}  ${r.file}`);
  console.log(`\nSummary: ${updated} updated · ${skipped} skipped · ${missing} no-style-tag`);
}

main();
