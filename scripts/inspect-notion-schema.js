#!/usr/bin/env node
// One-shot read-only inspector for the Notion "Prism AI Tickets" DB schema.
// Used during T-023 to verify which properties are available to the read-path
// adapter. Re-runnable; no writes.

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
} catch (_) {}

const apiKey = process.env.NOTION_API_KEY;
const dbId = process.env.NOTION_TICKETS_DB_ID;
if (!apiKey || !dbId) { console.error('Missing NOTION_API_KEY or NOTION_TICKETS_DB_ID'); process.exit(1); }

(async () => {
  const r = await fetch(`https://api.notion.com/v1/databases/${dbId}`, {
    headers: { Authorization: `Bearer ${apiKey}`, 'Notion-Version': '2022-06-28' },
  });
  const j = await r.json();
  if (!r.ok) { console.error('Failed:', r.status, j.code, j.message); process.exit(1); }

  const props = j.properties || {};
  console.log(`Database: ${(j.title?.[0]?.plain_text) || '(untitled)'}\n`);
  console.log('Properties:\n');
  const rows = Object.entries(props).map(([name, p]) => ({ name, type: p.type }));
  rows.sort((a, b) => a.name.localeCompare(b.name));
  for (const r of rows) {
    let extra = '';
    const p = props[r.name];
    if (p.type === 'select' && p.select?.options) extra = ` [${p.select.options.map(o => o.name).join(' | ')}]`;
    if (p.type === 'status' && p.status?.options) extra = ` [${p.status.options.map(o => o.name).join(' | ')}]`;
    if (p.type === 'multi_select' && p.multi_select?.options) extra = ` [${p.multi_select.options.map(o => o.name).join(' | ')}]`;
    console.log(`  ${r.name.padEnd(28)} ${r.type}${extra}`);
  }

  console.log(`\nTotal properties: ${rows.length}`);

  // Sample 3 pages so we can see the actual field shape, not just the schema header
  console.log('\nSample pages (first 3):\n');
  const q = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
    body: JSON.stringify({ page_size: 3 }),
  });
  const qj = await q.json();
  for (const page of qj.results || []) {
    const ps = page.properties || {};
    const title = ps.Ticket?.title?.[0]?.plain_text || ps.Name?.title?.[0]?.plain_text || '(no title)';
    console.log(`  • ${title.slice(0, 60)}`);
    for (const [k, v] of Object.entries(ps)) {
      let display = '(empty)';
      if (v.type === 'title' || v.type === 'rich_text') display = (v[v.type]?.[0]?.plain_text || '(empty)').slice(0, 50);
      else if (v.type === 'select') display = v.select?.name || '(empty)';
      else if (v.type === 'status') display = v.status?.name || '(empty)';
      else if (v.type === 'date') display = v.date?.start || '(empty)';
      else if (v.type === 'multi_select') display = (v.multi_select || []).map(o => o.name).join(',') || '(empty)';
      else if (v.type === 'people') display = (v.people || []).map(p => p.name || p.id).join(',') || '(empty)';
      else if (v.type === 'relation') display = `(${(v.relation || []).length} relations)`;
      else if (v.type === 'number') display = v.number ?? '(empty)';
      else if (v.type === 'checkbox') display = v.checkbox;
      else if (v.type === 'created_time' || v.type === 'last_edited_time') display = v[v.type] || '(empty)';
      console.log(`      ${k.padEnd(28)} ${v.type.padEnd(16)} ${display}`);
    }
    console.log('');
  }
})();
