#!/usr/bin/env node
// One-off audit: how many tickets in the dashboard have no upstream source?
const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '..', 'prism.db'), { readonly: true });

const total = db.prepare('SELECT COUNT(*) c FROM tickets').get().c;
const linked = db.prepare("SELECT COUNT(*) c FROM tickets WHERE notion_page_id IS NOT NULL AND notion_page_id != ''").get().c;
const orphans = db.prepare(`
  SELECT id, ticket_key, title, status, category, tags
  FROM tickets
  WHERE (notion_page_id IS NULL OR notion_page_id = '')
  ORDER BY id DESC
  LIMIT 20
`).all();

console.log('total tickets       :', total);
console.log('linked to notion    :', linked);
console.log('orphans (no source) :', total - linked);
console.log('---first 20 orphans:');
for (const t of orphans) {
  console.log(' ', t.ticket_key, '|', t.category, '|', t.status, '|', (t.title || '').slice(0, 60), '| tags:', t.tags);
}
