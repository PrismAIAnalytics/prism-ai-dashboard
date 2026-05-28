#!/usr/bin/env node
// stamp-pre-audit-tickets.js — T-090 Phase 5 (post-merge operational tool).
//
// Background: T-090 establishes the audit-defensible ticket body standard
// (Origin / Context / Trail block written into the Notion page body at
// creation). Tickets created before 2026-05-28 frequently have empty bodies —
// the inbox capture path silently truncated past line 1 + 60 chars and stored
// nothing else. There is no reliable way to recover the original capture text
// from session transcripts (compactions, retention).
//
// What this script does: scan the Notion Tickets DB, find pages whose body is
// empty (no child blocks) AND not already stamped, and append a one-block
// admonition explaining that the ticket predates the audit-defensible standard.
// Idempotent — re-running is safe; already-stamped pages are skipped.
//
// Usage:
//   node scripts/stamp-pre-audit-tickets.js --dry-run        # report-only
//   node scripts/stamp-pre-audit-tickets.js                  # actually stamp
//   node scripts/stamp-pre-audit-tickets.js --limit 25       # cap pass size
//
// Reads NOTION_API_KEY + NOTION_TICKETS_DB_ID from .env (same path as
// inspect-notion-schema.js). Never deletes content; only appends.

'use strict';

const fs = require('fs');
const path = require('path');

try {
  const envFile = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
  for (const line of envFile.split('\n')) {
    const m = line.replace(/\r$/, '').match(/^\s*([^#=]+?)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) {
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      process.env[m[1]] = v;
    }
  }
} catch (_) { /* .env optional */ }

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

const apiKey = process.env.NOTION_API_KEY;
const dbId = process.env.NOTION_TICKETS_DB_ID;
if (!apiKey || !dbId) {
  console.error('Missing NOTION_API_KEY or NOTION_TICKETS_DB_ID in env');
  process.exit(1);
}

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const limitIdx = process.argv.indexOf('--limit');
const limit = limitIdx >= 0 ? parseInt(process.argv[limitIdx + 1], 10) : Infinity;

// Marker phrase — checked on every page to detect already-stamped tickets.
const STAMP_MARKER = 'pre-2026-05-28 audit-defensible ticket standard';

function notionHeaders() {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  };
}

async function listAllTicketPages() {
  const pages = [];
  let cursor = null;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const r = await fetch(`${NOTION_API}/databases/${dbId}/query`, {
      method: 'POST',
      headers: notionHeaders(),
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(`list pages failed: ${r.status} ${j.code || ''} ${j.message || ''}`);
    }
    const data = await r.json();
    pages.push(...(data.results || []));
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return pages;
}

async function listBlockChildren(pageId) {
  const blocks = [];
  let cursor = null;
  do {
    const url = cursor
      ? `${NOTION_API}/blocks/${pageId}/children?page_size=100&start_cursor=${cursor}`
      : `${NOTION_API}/blocks/${pageId}/children?page_size=100`;
    const r = await fetch(url, { headers: notionHeaders() });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(`list blocks failed: ${r.status} ${j.code || ''} ${j.message || ''}`);
    }
    const data = await r.json();
    blocks.push(...(data.results || []));
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return blocks;
}

function blockHasMarker(block) {
  const rt = block?.[block.type]?.rich_text;
  if (!Array.isArray(rt)) return false;
  return rt.some((r) => (r?.text?.content || r?.plain_text || '').includes(STAMP_MARKER));
}

async function appendStampBlock(pageId) {
  const stampParagraph = {
    object: 'block',
    type: 'callout',
    callout: {
      icon: { type: 'emoji', emoji: '⚠️' },
      rich_text: [
        {
          type: 'text',
          text: {
            content: `This ticket predates the ${STAMP_MARKER}. Origin context was not captured at creation. Treat title + Source + Created-at as the only authoritative fields. Stamped by scripts/stamp-pre-audit-tickets.js on ${new Date().toISOString()}.`,
          },
        },
      ],
    },
  };
  const r = await fetch(`${NOTION_API}/blocks/${pageId}/children`, {
    method: 'PATCH',
    headers: notionHeaders(),
    body: JSON.stringify({ children: [stampParagraph] }),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(`stamp append failed: ${r.status} ${j.code || ''} ${j.message || ''}`);
  }
}

function pageTitle(page) {
  const titleProp = Object.values(page.properties || {}).find((p) => p?.type === 'title');
  const rt = titleProp?.title || [];
  return rt.map((t) => t?.plain_text || '').join('') || '(untitled)';
}

(async () => {
  console.log(`stamp-pre-audit-tickets.js ${dryRun ? '(DRY RUN)' : '(LIVE)'}`);
  console.log(`DB: ${dbId}\n`);

  const pages = await listAllTicketPages();
  console.log(`Found ${pages.length} total ticket pages.`);

  let inspected = 0;
  let stamped = 0;
  let alreadyStamped = 0;
  let hasContent = 0;
  let errors = 0;

  for (const page of pages) {
    if (inspected >= limit) break;
    inspected++;
    const title = pageTitle(page);
    try {
      const blocks = await listBlockChildren(page.id);
      if (blocks.length === 0) {
        if (dryRun) {
          console.log(`  [DRY] would stamp empty-body page: ${title} (${page.id})`);
        } else {
          await appendStampBlock(page.id);
          console.log(`  [STAMP] ${title} (${page.id})`);
        }
        stamped++;
      } else if (blocks.some(blockHasMarker)) {
        alreadyStamped++;
      } else {
        hasContent++;
      }
    } catch (e) {
      errors++;
      console.error(`  [ERROR] ${title} (${page.id}): ${e.message}`);
    }
  }

  console.log('\nSummary');
  console.log(`  Inspected:       ${inspected}`);
  console.log(`  Stamped:         ${stamped}${dryRun ? ' (dry-run, not written)' : ''}`);
  console.log(`  Already stamped: ${alreadyStamped}`);
  console.log(`  Has content:     ${hasContent}`);
  console.log(`  Errors:          ${errors}`);
  if (dryRun) {
    console.log('\nDry-run complete. Re-run without --dry-run to stamp for real.');
  }
})().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
