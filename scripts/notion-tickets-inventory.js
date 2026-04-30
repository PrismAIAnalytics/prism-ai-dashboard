#!/usr/bin/env node
// notion-tickets-inventory.js — read-only audit of the Notion "Prism AI Tickets" DB.
// Output: a markdown triage doc grouping pages by duplicate clusters, stale T-IDs,
// stale-completed, and active-by-category. Pre-cleanup planning tool for T-021 (or
// pre-T-019 sync). NEVER writes to Notion.
//
// Usage:
//   node scripts/notion-tickets-inventory.js                        # writes to stdout
//   node scripts/notion-tickets-inventory.js > notion-triage.md     # save to file

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

const NOTION_KEY = process.env.NOTION_API_KEY;
const NOTION_DB = process.env.NOTION_TICKETS_DB_ID;
const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

if (!NOTION_KEY || !NOTION_DB) {
  console.error('Missing NOTION_API_KEY or NOTION_TICKETS_DB_ID');
  process.exit(1);
}

const STALE_DAYS = 30;
const NOW = Date.now();

function readProp(props, key, type) {
  const p = props[key];
  if (!p) return null;
  switch (type) {
    case 'title':     return p.title?.[0]?.plain_text || '';
    case 'rich_text': return p.rich_text?.[0]?.plain_text || '';
    case 'select':    return p.select?.name || null;
    case 'status':    return p.status?.name || null;
    case 'date':      return p.date?.start || null;
    case 'unique_id': return p.unique_id ? `${p.unique_id.prefix}-${p.unique_id.number}` : null;
    default:          return null;
  }
}

function normTitle(t) {
  return (t || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').replace(/\bthe\b|\ba\b|\ban\b/g, '').replace(/\s+/g, ' ').trim();
}

(async () => {
  const all = [];
  let cursor;
  for (let i = 0; i < 50; i++) {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const r = await fetch(`${NOTION_API}/databases/${NOTION_DB}/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${NOTION_KEY}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!r.ok) { console.error('Notion query failed:', j); process.exit(1); }
    all.push(...(j.results || []));
    if (!j.has_more) break;
    cursor = j.next_cursor;
  }

  const rows = all.map(p => {
    const props = p.properties || {};
    const title = readProp(props, 'Ticket', 'title');
    const lastEditedISO = p.last_edited_time;
    const createdISO = p.created_time;
    const ageDays = lastEditedISO ? Math.floor((NOW - new Date(lastEditedISO).getTime()) / (24 * 3600 * 1000)) : null;
    return {
      page_id: p.id,
      url: p.url,
      title,
      ticketId: readProp(props, 'Ticket ID', 'unique_id') || '?',
      tId: readProp(props, 'T-ID', 'rich_text') || '',
      dashId: readProp(props, 'Dashboard Ticket ID', 'rich_text') || '',
      status: readProp(props, 'Status', 'status') || '?',
      category: readProp(props, 'Category', 'select') || '?',
      priority: readProp(props, 'Priority', 'select') || '?',
      source: readProp(props, 'Source', 'rich_text') || '',
      created: (createdISO || '').slice(0, 10),
      lastEdited: (lastEditedISO || '').slice(0, 10),
      ageDays,
      norm: normTitle(title),
    };
  });

  // ─── Duplicate clusters (by normalized title) ──────────────────────
  const titleGroups = new Map();
  for (const r of rows) {
    if (!r.norm) continue;
    if (!titleGroups.has(r.norm)) titleGroups.set(r.norm, []);
    titleGroups.get(r.norm).push(r);
  }
  const dupClusters = [...titleGroups.entries()].filter(([, arr]) => arr.length > 1);

  // ─── Stale T-### pages (T-ID set but not in current TASKS.md) ──────
  // We don't have TASKS.md here easily, so use a proxy: T-ID set + not edited recently
  const tidPages = rows.filter(r => r.tId);
  const tidStale = tidPages.filter(r => r.ageDays !== null && r.ageDays > STALE_DAYS);

  // ─── Stale-completed (status=Done, age > 30 days) ──────────────────
  const staleDone = rows.filter(r => r.status === 'Done' && r.ageDays !== null && r.ageDays > STALE_DAYS);

  // ─── Categories breakdown ──────────────────────────────────────────
  const byCat = {};
  for (const r of rows) byCat[r.category] = (byCat[r.category] || 0) + 1;
  const byStatus = {};
  for (const r of rows) byStatus[r.status] = (byStatus[r.status] || 0) + 1;

  // ─── Output ────────────────────────────────────────────────────────
  const out = [];
  out.push(`# Notion Tickets DB — Inventory & Triage`);
  out.push('');
  out.push(`Generated: ${new Date().toISOString().slice(0, 19)}Z`);
  out.push(`Database : Prism AI Tickets (\`${NOTION_DB}\`)`);
  out.push(`Total    : ${rows.length} pages`);
  out.push('');
  out.push(`## Summary`);
  out.push('');
  out.push(`**By status:** ${Object.entries(byStatus).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  out.push('');
  out.push(`**By category:** ${Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  out.push('');
  out.push(`**Cross-link state:**`);
  out.push(`- T-ID set: ${rows.filter(r => r.tId).length}`);
  out.push(`- Dashboard Ticket ID set: ${rows.filter(r => r.dashId).length}`);
  out.push(`- Both set: ${rows.filter(r => r.tId && r.dashId).length}`);
  out.push(`- Neither: ${rows.filter(r => !r.tId && !r.dashId).length}`);
  out.push('');
  out.push(`---`);
  out.push('');

  // ─── Duplicates ────────────────────────────────────────────────────
  out.push(`## 1. Duplicate clusters (${dupClusters.length} groups, ${dupClusters.reduce((s, [, a]) => s + a.length, 0)} pages)`);
  out.push('');
  out.push(`Pages grouped by normalized title (lowercase, articles stripped). Most actionable cleanup category — pick one to keep per cluster.`);
  out.push('');
  out.push(`**Decision shorthand for each row:** \`K\` keep · \`A\` archive in Notion · \`D\` delete · leave blank to defer.`);
  out.push('');
  if (dupClusters.length === 0) {
    out.push(`_No duplicate clusters detected._`);
    out.push('');
  } else {
    for (const [norm, arr] of dupClusters.sort((a, b) => b[1].length - a[1].length)) {
      out.push(`### "${arr[0].title}" — ${arr.length} pages`);
      out.push('');
      out.push(`| Decision | PRISM ID | Status | Category | Last edited | Age | Page |`);
      out.push(`|---|---|---|---|---|---|---|`);
      for (const r of arr.sort((a, b) => (b.ageDays || 0) - (a.ageDays || 0))) {
        out.push(`|   | ${r.ticketId} | ${r.status} | ${r.category} | ${r.lastEdited} | ${r.ageDays}d | [open](${r.url}) |`);
      }
      out.push('');
    }
  }
  out.push(`---`);
  out.push('');

  // ─── T-### pages older than threshold ──────────────────────────────
  out.push(`## 2. T-### pages with no recent activity (last edit > ${STALE_DAYS} days)`);
  out.push('');
  out.push(`Likely stale TASKS.md state — engineering tickets from older sessions that may not appear in current TASKS.md. Spot-check a few and decide policy: keep all (history) or trim to only currently-active T-IDs.`);
  out.push('');
  out.push(`Total T-ID pages: ${tidPages.length}, of which ${tidStale.length} are stale.`);
  out.push('');
  if (tidStale.length === 0) {
    out.push(`_None._`);
    out.push('');
  } else {
    out.push(`| Decision | T-ID | Status | Last edited | Age | Title |`);
    out.push(`|---|---|---|---|---|---|`);
    for (const r of tidStale.sort((a, b) => (b.ageDays || 0) - (a.ageDays || 0))) {
      out.push(`|   | ${r.tId} | ${r.status} | ${r.lastEdited} | ${r.ageDays}d | ${r.title.slice(0, 70)} |`);
    }
    out.push('');
  }
  out.push(`---`);
  out.push('');

  // ─── Stale-completed (non T-ID) ────────────────────────────────────
  const staleDoneNonTid = staleDone.filter(r => !r.tId);
  out.push(`## 3. Stale completed pages (non-T-ID, status=Done, age > ${STALE_DAYS} days)`);
  out.push('');
  out.push(`Candidates to archive or delete — finished work that isn't worth surfacing in the dashboard.`);
  out.push('');
  if (staleDoneNonTid.length === 0) {
    out.push(`_None._`);
    out.push('');
  } else {
    out.push(`| Decision | PRISM ID | Category | Last edited | Age | Title |`);
    out.push(`|---|---|---|---|---|---|`);
    for (const r of staleDoneNonTid.sort((a, b) => (b.ageDays || 0) - (a.ageDays || 0))) {
      out.push(`|   | ${r.ticketId} | ${r.category} | ${r.lastEdited} | ${r.ageDays}d | ${r.title.slice(0, 70)} |`);
    }
    out.push('');
  }
  out.push(`---`);
  out.push('');

  // ─── Active by category (non T-ID, not stale-done) ─────────────────
  const active = rows.filter(r => !r.tId && !staleDoneNonTid.includes(r) && !dupClusters.flatMap(([, a]) => a).includes(r));
  const activeByCat = {};
  for (const r of active) {
    if (!activeByCat[r.category]) activeByCat[r.category] = [];
    activeByCat[r.category].push(r);
  }
  out.push(`## 4. Active pages by category (non-T-ID, not duplicates, not stale-done): ${active.length}`);
  out.push('');
  out.push(`These are the candidates that should sync into the dashboard once cleanup is done. Spot-check by category.`);
  out.push('');
  for (const [cat, arr] of Object.entries(activeByCat).sort((a, b) => b[1].length - a[1].length)) {
    out.push(`### ${cat} — ${arr.length}`);
    out.push('');
    out.push(`| Decision | PRISM ID | Status | Last edited | Title |`);
    out.push(`|---|---|---|---|---|`);
    for (const r of arr.sort((a, b) => a.title.localeCompare(b.title))) {
      out.push(`|   | ${r.ticketId} | ${r.status} | ${r.lastEdited} | ${r.title.slice(0, 70)} |`);
    }
    out.push('');
  }
  out.push(`---`);
  out.push('');
  out.push(`## How to use this triage`);
  out.push('');
  out.push(`1. Mark each row's **Decision** column: \`K\` keep · \`A\` archive · \`D\` delete · leave blank for now.`);
  out.push(`2. Save the file.`);
  out.push(`3. Run \`node scripts/apply-notion-cleanup.js path/to/this-file.md\` (will be built next).`);
  out.push(`4. Apply script reads decisions, executes deletes/archives in Notion, reports what it did.`);

  console.log(out.join('\n'));
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
