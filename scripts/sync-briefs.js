#!/usr/bin/env node
// sync-briefs.js — mirror Leverage-Briefs markdown files to Notion ticket page bodies.
//
// One-way sync: filesystem → Notion. The Notion ticket page body becomes display-only.
// Idempotent: a SHA256 hash of the brief content is embedded in a top marker callout
// block; re-runs with no brief changes are a no-op (skip after 1 API call to read the
// first child block).
//
// Brief filename convention: PRISM-Vault/Admin/Leverage-Briefs/T-###.md
//   The T-### portion is matched against the Notion `T-ID` rich_text property.
//   Non-matching filenames (e.g., WEB-V2-AB.md) are skipped in this version.
//
// Usage:
//   node scripts/sync-briefs.js                  # sync all T-*.md briefs
//   node scripts/sync-briefs.js --dry-run        # plan + diff, no writes
//   node scripts/sync-briefs.js --ticket=T-029   # single ticket
//   node scripts/sync-briefs.js --briefs-dir=... # override briefs path
//   node scripts/sync-briefs.js --force          # ignore hash, rewrite
//
// Env required (loaded from Development/dashboard/.env):
//   NOTION_API_KEY        — same key sync-tasks.js uses
//   NOTION_TICKETS_DB_ID  — same DB sync-tasks.js mirrors to
//
// Markdown features supported:
//   Headings (#, ##, ###), paragraphs, bulleted + numbered lists, fenced code blocks
//   (```), tables (GFM, with `\|` cell-escape), blockquotes (single paragraph each),
//   dividers (---). Inline: **bold**, *italic*, `code`, [text](url).
//
// Known limitations (acceptable for current brief corpus — file follow-ups if they
// start to bite):
//   - Nested lists, nested emphasis (e.g. `**bold *with italic***`), HTML, images,
//     footnotes: render as plain text.
//   - Tilde fences (`~~~`) are not recognized as code blocks; use backtick fences.
//   - Multi-paragraph blockquotes collapse into a single Notion quote block.
//   - Markdown links with `)` in the URL truncate at the first `)`. Encode as `%29`
//     if your URL needs a closing paren.
//   - YAML frontmatter at the top of a brief is stripped silently.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ─── .env loader (mirrors sync-tasks.js:23-39) ──────────────────────────────
try {
  const envPath = path.join(__dirname, '..', '.env');
  const envFile = fs.readFileSync(envPath, 'utf8');
  for (const line of envFile.split('\n')) {
    const trimmed = line.replace(/\r$/, '');
    const m = trimmed.match(/^\s*([^#=]+?)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) {
      let val = m[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      process.env[m[1]] = val;
    }
  }
} catch (e) {
  if (e.code !== 'ENOENT') console.warn('[.env] Failed to load:', e.message);
}

// ─── Config ──────────────────────────────────────────────────────────────────
const DRY_RUN = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');
const TICKET_FLAG = process.argv.find(a => a.startsWith('--ticket='));
const SINGLE_TICKET = TICKET_FLAG ? TICKET_FLAG.slice('--ticket='.length) : null;
const BRIEFS_DIR_FLAG = process.argv.find(a => a.startsWith('--briefs-dir='));
const BRIEFS_DIR = BRIEFS_DIR_FLAG
  ? BRIEFS_DIR_FLAG.slice('--briefs-dir='.length).replace(/^["']|["']$/g, '')
  : path.join(__dirname, '..', '..', '..', 'PRISM-Vault', 'Admin', 'Leverage-Briefs');

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';
const NOTION_TEXT_LIMIT = 1990; // <2000 per rich_text content
const NOTION_CHILDREN_BATCH = 100; // max children per append call
const NOTION_ERROR_BODY_SLICE = 80; // cap on echoed Notion error bodies to keep brief content out of logs

// HASH_LEN is the truncated SHA256 length stored in the marker callout.
// COUPLING: extractHashFromMarker()'s regex matches exactly this many hex chars.
// If HASH_LEN changes, every previously-synced page will read as "hash mismatch"
// on the next run and get rewritten (one-time cost, no data loss). 32 chars =
// 128 bits, eliminates any practical truncation-collision concern.
const HASH_LEN = 32;

const MARKER_PREFIX = 'Auto-synced from filesystem · DO NOT EDIT IN NOTION';
const MARKER_HASH_PREFIX = 'hash:';

// Containment root for --briefs-dir validation. Resolves to the workspace
// PRISM-Vault tree so an operator can't accidentally point the sync at an
// unrelated filesystem location.
const VAULT_ROOT_DEFAULT = path.resolve(path.join(__dirname, '..', '..', '..', 'PRISM-Vault'));

// ─── Notion HTTP helper ─────────────────────────────────────────────────────
async function notionFetch(p, opts = {}) {
  const headers = {
    'Authorization': `Bearer ${process.env.NOTION_API_KEY}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
    ...(opts.headers || {}),
  };
  const r = await fetch(`${NOTION_API}${p}`, { ...opts, headers });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    // Keep the slice short — Notion error bodies often echo offending property values back,
    // which can include brief content fragments we don't want to leak into logs.
    throw new Error(`Notion ${opts.method || 'GET'} ${p}: ${r.status} ${body.slice(0, NOTION_ERROR_BODY_SLICE)}`);
  }
  // Future-proof: Notion API has previously used 204 No Content on DELETE in beta versions.
  // Current (2022-06-28) returns the deleted block JSON.
  if (r.status === 204 || r.headers.get('content-length') === '0') return {};
  return r.json();
}

async function findNotionPage(tId) {
  const dbId = process.env.NOTION_TICKETS_DB_ID;
  const resp = await notionFetch(`/databases/${dbId}/query`, {
    method: 'POST',
    body: JSON.stringify({
      filter: { property: 'T-ID', rich_text: { equals: tId } },
      page_size: 1,
    }),
  });
  return resp.results[0] || null;
}

async function listChildBlocks(pageId) {
  const all = [];
  let cursor = null;
  do {
    const url = `/blocks/${pageId}/children?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ''}`;
    const resp = await notionFetch(url);
    all.push(...resp.results);
    cursor = resp.has_more ? resp.next_cursor : null;
  } while (cursor);
  return all;
}

async function deleteBlock(blockId) {
  await notionFetch(`/blocks/${blockId}`, { method: 'DELETE' });
}

async function appendChildren(pageId, children) {
  for (let i = 0; i < children.length; i += NOTION_CHILDREN_BATCH) {
    await notionFetch(`/blocks/${pageId}/children`, {
      method: 'PATCH',
      body: JSON.stringify({ children: children.slice(i, i + NOTION_CHILDREN_BATCH) }),
    });
  }
}

// ─── Inline rich_text parser ────────────────────────────────────────────────
// Supports **bold**, *italic*, `code`, [text](url). Returns array of rich_text objects.
// Splits long plain-text runs across multiple objects to stay under NOTION_TEXT_LIMIT.
function parseInline(text) {
  const out = [];
  let buf = '';

  const flushBuf = () => {
    if (!buf) return;
    for (let pos = 0; pos < buf.length; pos += NOTION_TEXT_LIMIT) {
      out.push({ type: 'text', text: { content: buf.slice(pos, pos + NOTION_TEXT_LIMIT) } });
    }
    buf = '';
  };

  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);

    let m = rest.match(/^\*\*([^*]+?)\*\*/);
    if (m) {
      flushBuf();
      out.push({ type: 'text', text: { content: m[1].slice(0, NOTION_TEXT_LIMIT) }, annotations: { bold: true } });
      i += m[0].length;
      continue;
    }

    m = rest.match(/^`([^`]+?)`/);
    if (m) {
      flushBuf();
      out.push({ type: 'text', text: { content: m[1].slice(0, NOTION_TEXT_LIMIT) }, annotations: { code: true } });
      i += m[0].length;
      continue;
    }

    m = rest.match(/^\[([^\]]+?)\]\(([^)]+?)\)/);
    if (m) {
      flushBuf();
      out.push({ type: 'text', text: { content: m[1].slice(0, NOTION_TEXT_LIMIT), link: { url: m[2] } } });
      i += m[0].length;
      continue;
    }

    // Italic — check AFTER bold to avoid matching the inner of **bold**.
    // Require word-boundary on both sides to skip `*` that appears mid-word.
    m = rest.match(/^\*([^*\s][^*]*?[^*\s]|[^*\s])\*/);
    if (m) {
      flushBuf();
      out.push({ type: 'text', text: { content: m[1].slice(0, NOTION_TEXT_LIMIT) }, annotations: { italic: true } });
      i += m[0].length;
      continue;
    }

    buf += text[i];
    i++;
  }
  flushBuf();
  if (out.length === 0) out.push({ type: 'text', text: { content: '' } });
  return out;
}

// ─── Markdown → Notion blocks ────────────────────────────────────────────────
function mdToBlocks(md) {
  const lines = md.split('\n');
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Frontmatter — strip silently (--- at line 0 to next ---)
    if (i === 0 && line.trim() === '---') {
      i++;
      while (i < lines.length && lines[i].trim() !== '---') i++;
      if (i < lines.length) i++; // skip closing ---
      continue;
    }

    // Heading — trimEnd to avoid trailing-space artifacts being rendered into the Notion heading
    const h = line.match(/^(#{1,3})\s+(.+)$/);
    if (h) {
      const level = h[1].length;
      const type = level === 1 ? 'heading_1' : level === 2 ? 'heading_2' : 'heading_3';
      blocks.push({ object: 'block', type, [type]: { rich_text: parseInline(h[2].trimEnd()) } });
      i++;
      continue;
    }

    // Fenced code block
    if (/^```/.test(line)) {
      const lang = line.slice(3).trim();
      i++;
      const codeLines = [];
      while (i < lines.length && !/^```/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // closing fence
      const content = codeLines.join('\n');
      const richText = [];
      for (let pos = 0; pos < content.length; pos += NOTION_TEXT_LIMIT) {
        richText.push({ type: 'text', text: { content: content.slice(pos, pos + NOTION_TEXT_LIMIT) } });
      }
      if (richText.length === 0) richText.push({ type: 'text', text: { content: '' } });
      blocks.push({
        object: 'block',
        type: 'code',
        code: { rich_text: richText, language: normalizeLanguage(lang) },
      });
      continue;
    }

    // Divider
    if (/^---+\s*$/.test(line)) {
      blocks.push({ object: 'block', type: 'divider', divider: {} });
      i++;
      continue;
    }

    // Blockquote
    if (/^>\s?/.test(line)) {
      const quoted = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoted.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      blocks.push({
        object: 'block',
        type: 'quote',
        quote: { rich_text: parseInline(quoted.join(' ')) },
      });
      continue;
    }

    // Table
    if (/^\|/.test(line) && i + 1 < lines.length && /^\|[\s\-:|]+\|/.test(lines[i + 1])) {
      const header = parseTableRow(lines[i]);
      i += 2;
      const dataRows = [];
      while (i < lines.length && /^\|/.test(lines[i])) {
        dataRows.push(parseTableRow(lines[i]));
        i++;
      }
      const allRows = [header, ...dataRows];
      const width = Math.max(...allRows.map(r => r.length));
      const normalized = allRows.map(r => {
        const padded = [...r];
        while (padded.length < width) padded.push('');
        return padded;
      });
      blocks.push({
        object: 'block',
        type: 'table',
        table: {
          table_width: width,
          has_column_header: true,
          has_row_header: false,
          children: normalized.map(row => ({
            object: 'block',
            type: 'table_row',
            table_row: { cells: row.map(cell => parseInline(cell)) },
          })),
        },
      });
      continue;
    }

    // Bulleted list
    if (/^\s*[-*]\s+\S/.test(line)) {
      while (i < lines.length && /^\s*[-*]\s+\S/.test(lines[i])) {
        const text = lines[i].replace(/^\s*[-*]\s+/, '');
        blocks.push({
          object: 'block',
          type: 'bulleted_list_item',
          bulleted_list_item: { rich_text: parseInline(text) },
        });
        i++;
      }
      continue;
    }

    // Numbered list
    if (/^\s*\d+\.\s+/.test(line)) {
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        const text = lines[i].replace(/^\s*\d+\.\s+/, '');
        blocks.push({
          object: 'block',
          type: 'numbered_list_item',
          numbered_list_item: { rich_text: parseInline(text) },
        });
        i++;
      }
      continue;
    }

    // Empty line
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Paragraph — collect contiguous non-special non-empty lines
    const para = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^#{1,3}\s/.test(lines[i]) &&
      !/^```/.test(lines[i]) &&
      !/^>\s/.test(lines[i]) &&
      !/^\s*[-*]\s+\S/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !/^\|/.test(lines[i]) &&
      !/^---+\s*$/.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    blocks.push({
      object: 'block',
      type: 'paragraph',
      paragraph: { rich_text: parseInline(para.join(' ')) },
    });
  }

  return blocks;
}

function parseTableRow(line) {
  // GFM-compatible: pre-replace `\|` (literal pipe inside a cell) with a placeholder
  // so the split doesn't treat escaped pipes as cell delimiters, then restore.
  const PLACEHOLDER = '\x00';
  const escaped = line.replace(/\\\|/g, PLACEHOLDER);
  return escaped
    .replace(/^\s*\||\|\s*$/g, '')
    .split('|')
    .map(s => s.trim().replace(new RegExp(PLACEHOLDER, 'g'), '|'));
}

// Notion code block language whitelist (subset of the official list)
const NOTION_LANGUAGES = new Set([
  'abap', 'arduino', 'bash', 'basic', 'c', 'clojure', 'coffeescript', 'c++', 'c#', 'css',
  'dart', 'diff', 'docker', 'elixir', 'elm', 'erlang', 'flow', 'fortran', 'f#', 'gherkin',
  'glsl', 'go', 'graphql', 'groovy', 'haskell', 'html', 'java', 'javascript', 'json',
  'julia', 'kotlin', 'latex', 'less', 'lisp', 'livescript', 'lua', 'makefile', 'markdown',
  'markup', 'matlab', 'mermaid', 'nix', 'objective-c', 'ocaml', 'pascal', 'perl', 'php',
  'plain text', 'powershell', 'prolog', 'protobuf', 'python', 'r', 'reason', 'ruby', 'rust',
  'sass', 'scala', 'scheme', 'scss', 'shell', 'sql', 'swift', 'typescript', 'vb.net',
  'verilog', 'vhdl', 'visual basic', 'webassembly', 'xml', 'yaml',
]);
function normalizeLanguage(lang) {
  const lower = (lang || '').toLowerCase().trim();
  if (!lower) return 'plain text';
  if (NOTION_LANGUAGES.has(lower)) return lower;
  if (lower === 'js') return 'javascript';
  if (lower === 'ts') return 'typescript';
  if (lower === 'sh' || lower === 'zsh') return 'shell';
  if (lower === 'py') return 'python';
  if (lower === 'md') return 'markdown';
  if (lower === 'yml') return 'yaml';
  return 'plain text';
}

// ─── Marker block ────────────────────────────────────────────────────────────
function makeMarkerBlock(filename, hash) {
  const shortHash = hash.slice(0, HASH_LEN);
  const now = new Date().toISOString();
  return {
    object: 'block',
    type: 'callout',
    callout: {
      rich_text: [{
        type: 'text',
        text: {
          content: `${MARKER_PREFIX} · source: ${filename} · ${MARKER_HASH_PREFIX}${shortHash} · synced: ${now}`,
        },
      }],
      icon: { type: 'emoji', emoji: '🤖' },
      color: 'gray_background',
    },
  };
}

function extractHashFromMarker(block) {
  if (!block || block.type !== 'callout') return null;
  const text = (block.callout?.rich_text || [])
    .map(rt => rt.plain_text || rt.text?.content || '')
    .join('');
  const m = text.match(new RegExp(MARKER_HASH_PREFIX + '([a-f0-9]{' + HASH_LEN + '})'));
  return m ? m[1] : null;
}

// ─── Single-brief sync ───────────────────────────────────────────────────────
// Sanitize values that flow into console output. The brief filename is the most
// likely injection vector (a file named `T-001\nADMIN: OVERRIDE.md` would otherwise
// inject newlines into log streams). Mirrors the fix applied in sync-tasks.js.
function safeForLog(s) {
  return String(s).replace(/[\r\n]/g, '\\n');
}

async function syncBrief(briefPath) {
  const filename = path.basename(briefPath);
  const tId = filename.replace(/\.md$/, '');
  if (!/^T-\d+[a-z]?$/.test(tId)) return { tId: filename, action: 'skipped-not-tid' };
  const safeTId = safeForLog(tId);

  const briefContent = fs.readFileSync(briefPath, 'utf8');
  const hash = crypto.createHash('sha256').update(briefContent).digest('hex');
  const shortHash = hash.slice(0, HASH_LEN);

  const page = await findNotionPage(tId);
  if (!page) {
    console.log(`  ${safeTId} → SKIPPED (no Notion page found)`);
    return { tId, action: 'skipped-no-page' };
  }

  const existing = await listChildBlocks(page.id);
  const existingHash = existing.length > 0 ? extractHashFromMarker(existing[0]) : null;
  if (existingHash === shortHash && !FORCE) {
    console.log(`  ${safeTId} → SKIPPED (unchanged, hash ${shortHash})`);
    return { tId, action: 'skipped-unchanged' };
  }

  const newBlocks = [makeMarkerBlock(filename, hash), ...mdToBlocks(briefContent)];

  if (DRY_RUN) {
    const verb = existing.length > 0 ? 'REPLACE' : 'WRITE';
    console.log(`  ${safeTId} → [dry] ${verb} (${newBlocks.length} blocks, hash ${shortHash})`);
    return { tId, action: existing.length > 0 ? 'would-replace' : 'would-write' };
  }

  // Delete existing children first, then append. Critical: if ANY delete fails we
  // must abort before appending, otherwise the page ends up with stale-plus-new
  // blocks stacked on top of each other with no visible error signal. Collect
  // failures and bail loud — the next run will recover (an empty page or partial
  // page reads as "no marker" and triggers a full rewrite).
  const failedDeletes = [];
  for (const b of existing) {
    try {
      await deleteBlock(b.id);
    } catch (e) {
      failedDeletes.push({ id: b.id, message: e.message });
    }
  }
  if (failedDeletes.length > 0) {
    const detail = failedDeletes.map(f => `${f.id.slice(0, 8)}:${f.message.slice(0, 60)}`).join('; ');
    throw new Error(`${failedDeletes.length} block delete(s) failed — aborted before append to avoid duplication. ${detail}`);
  }

  await appendChildren(page.id, newBlocks);
  const verb = existing.length > 0 ? 'REPLACED' : 'WRITTEN';
  console.log(`  ${safeTId} → ${verb} (${newBlocks.length} blocks, hash ${shortHash})`);
  return { tId, action: existing.length > 0 ? 'replaced' : 'written' };
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  if (!process.env.NOTION_API_KEY) throw new Error('NOTION_API_KEY not set (check .env)');
  if (!process.env.NOTION_TICKETS_DB_ID) throw new Error('NOTION_TICKETS_DB_ID not set');

  // Validate --ticket value against the T-ID shape before any network call.
  if (SINGLE_TICKET && !/^T-\d+[a-z]?$/.test(SINGLE_TICKET)) {
    throw new Error(`Invalid --ticket value: ${safeForLog(SINGLE_TICKET)} (expected T-### shape)`);
  }

  // Containment check on --briefs-dir: resolved path must live inside the PRISM-Vault tree.
  // Prevents accidental (or prompt-injected) sync from an unrelated filesystem location.
  const resolvedBriefs = path.resolve(BRIEFS_DIR);
  if (!resolvedBriefs.startsWith(VAULT_ROOT_DEFAULT)) {
    throw new Error(`--briefs-dir must resolve inside ${VAULT_ROOT_DEFAULT} — got ${resolvedBriefs}`);
  }

  console.log(`Mode:        ${DRY_RUN ? 'DRY RUN' : 'WRITE'}${FORCE ? ' (FORCE)' : ''}`);
  console.log(`Briefs dir:  ${resolvedBriefs}`);
  console.log(`Notion DB:   ${process.env.NOTION_TICKETS_DB_ID}`);
  if (SINGLE_TICKET) console.log(`Filter:      ${SINGLE_TICKET}`);
  console.log('');

  if (!fs.existsSync(resolvedBriefs)) {
    throw new Error(`Briefs directory not found: ${resolvedBriefs}`);
  }

  // Fail fast on Notion auth before any reads.
  await notionFetch('/users/me');

  const all = fs.readdirSync(resolvedBriefs)
    .filter(f => /^T-\d+[a-z]?\.md$/.test(f))
    .sort()
    .map(f => path.join(resolvedBriefs, f));

  const briefs = SINGLE_TICKET
    ? all.filter(p => path.basename(p, '.md') === SINGLE_TICKET)
    : all;

  if (briefs.length === 0) {
    console.log(SINGLE_TICKET ? `No brief found for ${SINGLE_TICKET}.` : 'No T-*.md briefs found.');
    return;
  }

  console.log(`Found ${briefs.length} brief${briefs.length === 1 ? '' : 's'}:`);
  for (const b of briefs) console.log(`  ${path.basename(b)}`);
  console.log('');

  const stats = {
    written: 0, replaced: 0,
    'skipped-unchanged': 0, 'skipped-no-page': 0, 'skipped-not-tid': 0,
    'would-write': 0, 'would-replace': 0, errors: 0,
  };
  for (const briefPath of briefs) {
    try {
      const r = await syncBrief(briefPath);
      stats[r.action] = (stats[r.action] || 0) + 1;
    } catch (e) {
      const safeTId = safeForLog(path.basename(briefPath, '.md'));
      console.error(`  ${safeTId} ERROR: ${e.message}`);
      stats.errors++;
    }
  }

  console.log('');
  const line = [
    `${stats.written} written`,
    `${stats.replaced} replaced`,
    `${stats['skipped-unchanged']} unchanged`,
    `${stats['skipped-no-page']} no-page`,
    `${stats.errors} errors`,
  ].join(' · ');
  console.log(`Summary: ${line}`);
  if (DRY_RUN) {
    console.log(`         (dry: ${stats['would-write']} would-write · ${stats['would-replace']} would-replace)`);
  }
  if (stats.errors > 0) process.exit(1);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
