#!/usr/bin/env node
// extract-conflicts.js — utility for Phase 3 review. Reads a duplicates CSV
// produced by audit-duplicates.js and prints only the rows where
// conflict_fields is non-empty. Read-only.
//
// Usage: node scripts/extract-conflicts.js reports/duplicates-YYYY-MM-DD.csv
'use strict';
const fs = require('fs');
const path = require('path');

const file = process.argv[2];
if (!file) { console.error('Usage: extract-conflicts.js <csv>'); process.exit(1); }

const text = fs.readFileSync(file, 'utf8');
const lines = text.split(/\r?\n/).filter(Boolean);
const header = lines[0].split(',');
const CF = header.indexOf('conflict_fields');

function parseCsvLine(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQ = !inQ; continue; }
    if (c === ',' && !inQ) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

console.log(lines[0]);
let n = 0;
for (let i = 1; i < lines.length; i++) {
  const f = parseCsvLine(lines[i]);
  if (f[CF] && f[CF].trim()) {
    console.log(lines[i]);
    n++;
  }
}
console.error(`\nTotal rows with conflicts: ${n}`);
