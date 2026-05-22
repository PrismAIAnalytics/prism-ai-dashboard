#!/usr/bin/env node
// migrate-content-calendar.js — Excel → Notion Content Calendar migration (T-044).
//
// Reads Marketing/*Content_Calendar*.xlsx (case-insensitive glob), finds sheets
// that match the canonical content header (Date | Day | Channel | Format |
// Topic / Title | CTA | Status | Notes), maps rows via
// scripts/content-calendar-mapping.json, and creates pages in the Content
// Calendar Notion DB (created by T-043). Idempotent via the "Source row" audit
// field: <filename>:<sheet>:<row_number>.
//
// Usage:
//   node scripts/migrate-content-calendar.js --dry-run          # plan + report, no writes
//   node scripts/migrate-content-calendar.js                    # live: create Notion pages
//   node scripts/migrate-content-calendar.js --file=<path>      # override single file
//   node scripts/migrate-content-calendar.js --year=2026        # override year context
//   node scripts/migrate-content-calendar.js --limit=10         # cap rows for testing
//
// Env required (loaded from Development/dashboard/.env):
//   NOTION_API_KEY                — Notion internal integration token
//   NOTION_CONTENT_CALENDAR_DB_ID — DB ID from T-043 (default in .env.example)
//
// Output:
//   reports/content-calendar-migration-YYYY-MM-DD.md — summary report (always)
//
// Per the leverage brief PRISM-Vault/Admin/Leverage-Briefs/T-044.md.

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

// ─── .env loader ────────────────────────────────────────────────────────────
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
const FILE_FLAG = process.argv.find(a => a.startsWith('--file='));
const YEAR_FLAG = process.argv.find(a => a.startsWith('--year='));
const LIMIT_FLAG = process.argv.find(a => a.startsWith('--limit='));
const LIMIT = LIMIT_FLAG ? parseInt(LIMIT_FLAG.slice('--limit='.length), 10) : Infinity;

const REPO_ROOT = path.resolve(path.join(__dirname, '..', '..', '..'));
const MARKETING_ROOT = path.join(REPO_ROOT, 'Marketing');
const REPORTS_DIR = path.join(__dirname, '..', 'reports');
const MAPPING_PATH = path.join(__dirname, 'content-calendar-mapping.json');

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';
const NOTION_TEXT_LIMIT = 1990;
const NOTION_ERROR_BODY_SLICE = 200;
const NOTION_QUERY_PAGE_SIZE = 100;

// ─── Notion HTTP helper ─────────────────────────────────────────────────────
async function notionFetch(p, opts = {}) {
  if (!process.env.NOTION_API_KEY) throw new Error('NOTION_API_KEY not set');
  const headers = {
    'Authorization': `Bearer ${process.env.NOTION_API_KEY}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
    ...(opts.headers || {}),
  };
  const r = await fetch(`${NOTION_API}${p}`, { ...opts, headers });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`Notion ${opts.method || 'GET'} ${p}: ${r.status} ${body.slice(0, NOTION_ERROR_BODY_SLICE)}`);
  }
  if (r.status === 204) return {};
  return r.json();
}

// ─── Containment ────────────────────────────────────────────────────────────
// Inputs must live under Marketing/. Reject any --file= or globbed
// path that resolves outside that subtree.
function assertContained(filePath, root) {
  const resolved = path.resolve(filePath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Path escapes containment: ${resolved} not under ${root}`);
  }
  return resolved;
}

// Sanitize values that flow into console output — strip CR/LF to prevent log
// injection from a maliciously-named Excel file or sheet. Mirrors the helper
// in scripts/sync-briefs.js.
function safeForLog(s) {
  return String(s).replace(/[\r\n]/g, '\\n');
}

// ─── Mapping ────────────────────────────────────────────────────────────────
let mapping;
function loadMapping() {
  const raw = fs.readFileSync(MAPPING_PATH, 'utf8');
  mapping = JSON.parse(raw);
  if (mapping.version !== 1) throw new Error(`Unsupported mapping version: ${mapping.version}`);
}

// ─── File discovery ─────────────────────────────────────────────────────────
function discoverFiles() {
  if (FILE_FLAG) {
    const f = FILE_FLAG.slice('--file='.length).replace(/^["']|["']$/g, '');
    // Constrain to Marketing/ (not just REPO_ROOT) — prevents an operator
    // pointing the script at e.g. HR/ or Clients/ by mistake.
    return [assertContained(f, MARKETING_ROOT)];
  }
  if (!fs.existsSync(MARKETING_ROOT)) {
    throw new Error(`Marketing directory not found: ${MARKETING_ROOT}`);
  }
  return fs.readdirSync(MARKETING_ROOT)
    .filter(name => /content[_ ]calendar.*\.xlsx?$/i.test(name) && !/^~\$/.test(name))
    .sort()
    .map(name => path.join(MARKETING_ROOT, name));
}

// ─── Year resolution ────────────────────────────────────────────────────────
function resolveYear(filePath) {
  if (YEAR_FLAG) return parseInt(YEAR_FLAG.slice('--year='.length), 10);
  const m = path.basename(filePath).match(/(\d{4})/);
  return m ? parseInt(m[1], 10) : new Date().getFullYear();
}

// ─── Header detection ───────────────────────────────────────────────────────
function findHeaderRow(sheet) {
  const sig = mapping.sheet_filter.header_row_signature.map(s => s.toLowerCase().trim());
  const maxScan = Math.min(10, sheet.rowCount);
  for (let r = 1; r <= maxScan; r++) {
    const row = sheet.getRow(r);
    const values = [];
    for (let c = 1; c <= sig.length; c++) {
      const v = row.getCell(c).value;
      values.push(v == null ? '' : String(typeof v === 'object' && v.text ? v.text : v).toLowerCase().trim());
    }
    if (values.every((v, i) => v === sig[i])) return r;
  }
  return null;
}

// ─── Non-data-row detection ─────────────────────────────────────────────────
function isNonDataRow(rowValues) {
  if (!Array.isArray(rowValues) || rowValues.length === 0) return true;

  // Rule: skip if column A spans all 8 columns (every cell equals column A)
  if (mapping.non_data_row_rules.skip_if_column_a_spans_all) {
    const a = rowValues[0];
    if (a != null && rowValues.length === 8 && rowValues.every(v => v === a)) return true;
  }

  // Rule: skip if columns B–H are all NULL
  if (mapping.non_data_row_rules.skip_if_columns_b_through_h_all_null) {
    const restNull = rowValues.slice(1).every(v => v == null || String(v).trim() === '');
    if (restNull) return true;
  }
  return false;
}

// ─── Cell value normalization ───────────────────────────────────────────────
// exceljs cell.value can be: primitive, Date, { text, hyperlink }, { richText: [] }, formula result, etc.
function cellToString(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if (v.text) return String(v.text);
    if (v.richText && Array.isArray(v.richText)) return v.richText.map(p => p.text || '').join('');
    if (v.result != null) return cellToString(v.result);
    if (v.hyperlink) return String(v.hyperlink);
  }
  return String(v);
}

// ─── Transforms ─────────────────────────────────────────────────────────────
function parseDate(value, year, warnings) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const s = String(value).trim();
  if (!s) return null;
  // ISO already?
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // Excel serial?
  if (/^\d+$/.test(s)) {
    const serial = parseInt(s, 10);
    if (serial > 25569 && serial < 60000) {
      // Excel epoch: 1899-12-30, days since
      const ms = (serial - 25569) * 86400 * 1000;
      return new Date(ms).toISOString().slice(0, 10);
    }
  }
  // "Mon Apr 27" style
  const m = s.match(/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+([A-Za-z]+)\s+(\d{1,2})$/i);
  if (m) {
    const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
    const month = months[m[1].slice(0, 3).toLowerCase()];
    const day = parseInt(m[2], 10);
    if (month != null) {
      const d = new Date(Date.UTC(year, month, day));
      return d.toISOString().slice(0, 10);
    }
  }
  warnings.push(`Unparseable date: "${s}"`);
  return null;
}

function parsePlatforms(value, warnings) {
  if (value == null) return { values: [], raw: null };
  const raw = String(value).trim();
  if (!raw || raw === '—' || raw === '-') return { values: [], raw };

  // Strip parentheticals (e.g. "LinkedIn (founder-led)" → "LinkedIn")
  const stripped = raw.replace(/\([^)]*\)/g, '').trim();

  // Split on / and +
  const parts = stripped.split(/[\/+]/).map(p => p.trim()).filter(Boolean);

  const out = [];
  const unmappedThisCell = [];
  for (const part of parts) {
    // Strip trailing qualifiers like "5 Shorts" (a count + format, not a separate platform)
    const cleaned = part.replace(/^\d+\s+/, '').trim();
    // Look up canonical (case-insensitive). Use an explicit `found` flag rather
    // than relying on `mapped === null` to mean "not found" — keeps the explicit
    // null mappings (Press, Zoom, em-dash) unambiguous.
    let mapped = null;
    let found = false;
    for (const key of Object.keys(mapping.platform_map)) {
      if (key.startsWith('_')) continue;
      if (cleaned.toLowerCase() === key.toLowerCase()) {
        mapped = mapping.platform_map[key];
        found = true;
        break;
      }
    }
    if (found) {
      // Explicit null = skip silently (the value mapped to "not a platform")
      if (mapped === null) continue;
      if (!out.includes(mapped)) out.push(mapped);
    } else {
      unmappedThisCell.push(cleaned);
    }
  }
  if (unmappedThisCell.length) {
    warnings.push(`Unmapped Channel "${raw}" → unmapped parts: ${unmappedThisCell.join(', ')} (defaulted to N/A)`);
    if (!out.includes('N/A')) out.push('N/A');
  }
  return { values: out, raw };
}

function mapType(value, warnings) {
  if (value == null) return { value: 'Other', raw: null };
  const raw = String(value).trim();
  if (!raw || raw === '—') return { value: 'Other', raw };

  // Try exact match first, then case-insensitive
  if (mapping.type_map[raw]) return { value: mapping.type_map[raw], raw };
  for (const key of Object.keys(mapping.type_map)) {
    if (key.startsWith('_')) continue;
    if (raw.toLowerCase() === key.toLowerCase()) return { value: mapping.type_map[key], raw };
  }
  // Substring fallback for common patterns (Newsletter #N, "Newsletter #9 + LinkedIn", etc.).
  // Patterns are scoped: avoid bare "post" because it false-matches "post-launch",
  // "Postcast", etc. — the explicit type_map already covers "Founder post" / "Recap post".
  const lc = raw.toLowerCase();
  if (/^newsletter\b/.test(lc) || /\bnewsletter\s*#/.test(lc)) return { value: 'Newsletter', raw };
  if (/\bpodcast\b/.test(lc)) return { value: 'Podcast', raw };
  if (/\b(blog|article)\b/.test(lc)) return { value: 'Blog', raw };
  if (/\b(carousel|reel|shorts?|story|teaser|recap)\b/.test(lc)) return { value: 'Social', raw };
  warnings.push(`Unmapped Format "${raw}" → defaulted to Other`);
  return { value: 'Other', raw };
}

function mapStatus(value, warnings) {
  if (value == null) return { value: 'Draft', raw: null };
  const raw = String(value).trim();
  if (!raw) return { value: 'Draft', raw };
  if (mapping.status_map[raw]) return { value: mapping.status_map[raw], raw };
  for (const key of Object.keys(mapping.status_map)) {
    if (key.startsWith('_')) continue;
    if (raw.toLowerCase() === key.toLowerCase()) return { value: mapping.status_map[key], raw };
  }
  warnings.push(`Unmapped Status "${raw}" → defaulted to Draft`);
  return { value: 'Draft', raw };
}

// ─── Row → Notion page builder ──────────────────────────────────────────────
function rowToNotionPage(rowData, sourceRow, year, warnings) {
  const cm = mapping.column_to_property;
  const title = (cellToString(rowData['Topic / Title']) || '').trim();
  if (!title) {
    warnings.push(`Row skipped: missing Title (Source row: ${sourceRow})`);
    return null;
  }
  const dateStr = parseDate(rowData['Date'], year, warnings);
  if (!dateStr) {
    warnings.push(`Row skipped: missing/unparseable Date (Source row: ${sourceRow})`);
    return null;
  }

  const platforms = parsePlatforms(rowData['Channel'], warnings);
  const typeMapped = mapType(rowData['Format'], warnings);
  const statusMapped = mapStatus(rowData['Status'], warnings);
  const series = (cellToString(rowData['Day']) || '').trim();
  const cta = (cellToString(rowData['CTA']) || '').trim();
  const notes = (cellToString(rowData['Notes']) || '').trim();

  // Build the description block (CTA + Notes go into the page body, not properties)
  const bodyParts = [];
  if (cta) bodyParts.push(`**CTA:** ${cta}`);
  if (notes) bodyParts.push(`**Notes:** ${notes}`);

  return {
    properties: {
      'Title': { title: [{ text: { content: title.slice(0, NOTION_TEXT_LIMIT) } }] },
      'Publish Date': { date: { start: dateStr } },
      'Platform': { multi_select: platforms.values.map(name => ({ name })) },
      'Type': { select: { name: typeMapped.value } },
      'Status': { select: { name: statusMapped.value } },
      'Series': series ? { rich_text: [{ text: { content: series.slice(0, NOTION_TEXT_LIMIT) } }] } : { rich_text: [] },
      'Source row': { rich_text: [{ text: { content: sourceRow } }] },
    },
    children: bodyParts.length
      ? bodyParts.map(text => ({
          object: 'block',
          type: 'paragraph',
          paragraph: { rich_text: [{ type: 'text', text: { content: text.slice(0, NOTION_TEXT_LIMIT) } }] },
        }))
      : undefined,
    _audit: {
      sourceRow,
      title,
      dateStr,
      platforms: platforms.values,
      platformRaw: platforms.raw,
      type: typeMapped.value,
      typeRaw: typeMapped.raw,
      status: statusMapped.value,
      statusRaw: statusMapped.raw,
      series,
      hasCta: !!cta,
      hasNotes: !!notes,
    },
  };
}

// ─── Idempotency: fetch existing Source row values ──────────────────────────
async function fetchExistingSourceRows() {
  if (!process.env.NOTION_CONTENT_CALENDAR_DB_ID) {
    throw new Error('NOTION_CONTENT_CALENDAR_DB_ID not set');
  }
  const dbId = process.env.NOTION_CONTENT_CALENDAR_DB_ID;
  const existing = new Set();
  let cursor = null;
  do {
    const body = { page_size: NOTION_QUERY_PAGE_SIZE };
    if (cursor) body.start_cursor = cursor;
    const resp = await notionFetch(`/databases/${dbId}/query`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    for (const page of resp.results) {
      const sr = page.properties?.['Source row']?.rich_text?.[0]?.plain_text;
      if (sr) existing.add(sr);
    }
    cursor = resp.has_more ? resp.next_cursor : null;
  } while (cursor);
  return existing;
}

async function createNotionPage(pageObj) {
  const dbId = process.env.NOTION_CONTENT_CALENDAR_DB_ID;
  const { children, _audit, ...rest } = pageObj;
  const payload = {
    parent: { database_id: dbId },
    properties: rest.properties,
  };
  if (children) payload.children = children;
  return notionFetch('/pages', { method: 'POST', body: JSON.stringify(payload) });
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  loadMapping();

  console.log(`Mode:       ${DRY_RUN ? 'DRY RUN' : 'LIVE WRITE'}`);
  console.log(`Marketing:  ${MARKETING_ROOT}`);
  console.log(`Mapping:    ${MAPPING_PATH}`);
  if (LIMIT !== Infinity) console.log(`Limit:      ${LIMIT}`);
  console.log('');

  if (!DRY_RUN) {
    if (!process.env.NOTION_API_KEY) throw new Error('NOTION_API_KEY not set (check .env)');
    if (!process.env.NOTION_CONTENT_CALENDAR_DB_ID) throw new Error('NOTION_CONTENT_CALENDAR_DB_ID not set');
    await notionFetch('/users/me'); // fail-fast on auth
  }

  const files = discoverFiles();
  if (files.length === 0) {
    console.log('No matching xlsx files found.');
    return;
  }
  console.log(`Found ${files.length} file${files.length === 1 ? '' : 's'}:`);
  for (const f of files) console.log(`  ${path.relative(REPO_ROOT, f)}`);
  console.log('');

  // In live mode, pre-fetch existing Source row values for idempotency
  let existing = new Set();
  if (!DRY_RUN) {
    process.stdout.write('Fetching existing Source rows... ');
    existing = await fetchExistingSourceRows();
    console.log(`${existing.size} existing rows in Notion DB.`);
    console.log('');
  }

  const allRows = []; // for the report
  const warnings = [];
  const stats = {
    files: files.length,
    sheets_processed: 0,
    sheets_skipped: 0,
    rows_planned: 0,
    rows_skipped_non_data: 0,
    rows_skipped_validation: 0,
    rows_already_in_notion: 0,
    rows_created: 0,
    rows_failed: 0,
  };

  for (const filePath of files) {
    const year = resolveYear(filePath);
    const filename = path.basename(filePath);
    const safeFilename = safeForLog(filename);
    console.log(`\n=== ${safeFilename} (year context: ${year})`);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(filePath);

    for (const sheet of wb.worksheets) {
      const safeSheetName = safeForLog(sheet.name);
      const headerRow = findHeaderRow(sheet);
      if (headerRow == null) {
        console.log(`  [${safeSheetName}] no header — skipped`);
        stats.sheets_skipped++;
        continue;
      }
      console.log(`  [${safeSheetName}] header at R${headerRow}; ${sheet.rowCount - headerRow} candidate row(s)`);
      stats.sheets_processed++;

      for (let r = headerRow + 1; r <= sheet.rowCount; r++) {
        if (stats.rows_planned >= LIMIT) break;
        const row = sheet.getRow(r);
        const values = [];
        for (let c = 1; c <= 8; c++) values.push(row.getCell(c).value);

        if (isNonDataRow(values)) {
          stats.rows_skipped_non_data++;
          continue;
        }

        const rowData = {
          'Date': values[0],
          'Day': values[1],
          'Channel': values[2],
          'Format': values[3],
          'Topic / Title': values[4],
          'CTA': values[5],
          'Status': values[6],
          'Notes': values[7],
        };
        const sourceRow = `${filename}:${sheet.name}:${r}`;
        const rowWarnings = [];
        const pageObj = rowToNotionPage(rowData, sourceRow, year, rowWarnings);

        if (!pageObj) {
          stats.rows_skipped_validation++;
          warnings.push(...rowWarnings);
          continue;
        }

        warnings.push(...rowWarnings);
        stats.rows_planned++;

        if (!DRY_RUN) {
          if (existing.has(sourceRow)) {
            stats.rows_already_in_notion++;
            allRows.push({ ...pageObj._audit, action: 'skipped-already-exists' });
            continue;
          }
          try {
            await createNotionPage(pageObj);
            stats.rows_created++;
            allRows.push({ ...pageObj._audit, action: 'created' });
            // Light throttle so we don't pin Notion's 3 req/sec cap
            await new Promise(res => setTimeout(res, 350));
          } catch (e) {
            stats.rows_failed++;
            warnings.push(`Notion create failed for ${sourceRow}: ${e.message}`);
            allRows.push({ ...pageObj._audit, action: 'failed', error: e.message });
          }
        } else {
          allRows.push({ ...pageObj._audit, action: 'would-create' });
        }
      }
    }
  }

  // Write report
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const reportPath = path.join(REPORTS_DIR, `content-calendar-migration-${today}.md`);
  const report = renderReport({ stats, warnings, rows: allRows, files });
  fs.writeFileSync(reportPath, report, 'utf8');

  console.log('');
  console.log('Summary:');
  console.log(`  Sheets:           ${stats.sheets_processed} processed · ${stats.sheets_skipped} skipped (no header)`);
  console.log(`  Rows planned:     ${stats.rows_planned}`);
  console.log(`  Skipped (blank/header rows): ${stats.rows_skipped_non_data}`);
  console.log(`  Skipped (validation):        ${stats.rows_skipped_validation}`);
  if (!DRY_RUN) {
    console.log(`  Already in Notion: ${stats.rows_already_in_notion}`);
    console.log(`  Created:          ${stats.rows_created}`);
    console.log(`  Failed:           ${stats.rows_failed}`);
  }
  console.log(`  Warnings:         ${warnings.length}`);
  console.log('');
  console.log(`Report: ${path.relative(REPO_ROOT, reportPath)}`);
}

// ─── Report renderer ────────────────────────────────────────────────────────
function renderReport({ stats, warnings, rows, files }) {
  const lines = [];
  const today = new Date().toISOString().slice(0, 10);
  lines.push(`# Content Calendar Migration Report — ${today}`);
  lines.push('');
  lines.push(`**Mode:** ${DRY_RUN ? 'DRY RUN — no writes' : 'LIVE — pages created in Notion'}`);
  lines.push(`**Files scanned:** ${files.length}`);
  for (const f of files) lines.push(`- \`${path.relative(REPO_ROOT, f)}\``);
  lines.push('');

  lines.push('## Summary');
  lines.push('');
  lines.push(`- Sheets processed: **${stats.sheets_processed}** (${stats.sheets_skipped} skipped — no header)`);
  lines.push(`- Rows planned: **${stats.rows_planned}**`);
  lines.push(`- Non-data rows skipped: ${stats.rows_skipped_non_data}`);
  lines.push(`- Validation-failed rows: ${stats.rows_skipped_validation}`);
  if (!DRY_RUN) {
    lines.push(`- Already in Notion (idempotent skip): ${stats.rows_already_in_notion}`);
    lines.push(`- **Created:** ${stats.rows_created}`);
    lines.push(`- Failed: ${stats.rows_failed}`);
  }
  lines.push(`- Warnings: ${warnings.length}`);
  lines.push('');

  // Group warnings by type for easier scanning
  if (warnings.length > 0) {
    lines.push('## Warnings & unmapped values');
    lines.push('');
    const grouped = { unmappedChannel: [], unmappedFormat: [], unmappedStatus: [], unparseableDate: [], rowSkipped: [], notionFail: [], other: [] };
    for (const w of warnings) {
      if (/Unmapped Channel/.test(w)) grouped.unmappedChannel.push(w);
      else if (/Unmapped Format/.test(w)) grouped.unmappedFormat.push(w);
      else if (/Unmapped Status/.test(w)) grouped.unmappedStatus.push(w);
      else if (/Unparseable date/.test(w)) grouped.unparseableDate.push(w);
      else if (/Row skipped/.test(w)) grouped.rowSkipped.push(w);
      else if (/Notion create failed/.test(w)) grouped.notionFail.push(w);
      else grouped.other.push(w);
    }
    for (const [label, items] of Object.entries(grouped)) {
      if (items.length === 0) continue;
      lines.push(`### ${label} (${items.length})`);
      lines.push('');
      // Dedupe
      const seen = new Set();
      for (const w of items) {
        if (seen.has(w)) continue;
        seen.add(w);
        lines.push(`- ${w}`);
      }
      lines.push('');
    }
  }

  // Per-row audit table
  lines.push('## Per-row audit');
  lines.push('');
  if (rows.length === 0) {
    lines.push('_No rows._');
  } else {
    lines.push('| # | Action | Date | Title | Type | Platform | Status | Series | Source row |');
    lines.push('|---|--------|------|-------|------|----------|--------|--------|------------|');
    rows.forEach((r, i) => {
      const title = (r.title || '').replace(/\|/g, '\\|').slice(0, 80);
      const platform = (r.platforms || []).join(', ');
      const series = (r.series || '').replace(/\|/g, '\\|').slice(0, 30);
      lines.push(`| ${i + 1} | ${r.action} | ${r.dateStr || ''} | ${title} | ${r.type || ''} | ${platform} | ${r.status || ''} | ${series} | \`${r.sourceRow}\` |`);
    });
  }
  lines.push('');

  lines.push('---');
  lines.push(`Generated by \`scripts/migrate-content-calendar.js\` (T-044).`);
  return lines.join('\n');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
