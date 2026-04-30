// notionSync.js — one-way sync from Notion "Prism AI Tickets" DB → dashboard tickets table.
//
// PRISM-2 (T-019). Companion to scripts/sync-tasks.js (which goes the other direction
// for engineering tickets driven by TASKS.md).
//
// Match key: tickets.notion_page_id ← Notion page UUID.
// Skip:      Notion pages that have T-ID set — those are T-015's territory (TASKS.md
//            engineering tickets), and we never want two writers for one row.
//
// On create: also writes Dashboard Ticket ID back to the Notion page so the link
//            shows up on the Notion side.
//
// Idempotent: if no fields differ between Notion and dashboard, it's a no-op.
//
// Source on the dashboard side: 'notion' (prefix NTN-####). This marks the ticket
// as upstream-Notion-canonical for the view-only UI restriction in T-019.

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

const STATUS_NOTION_TO_DASH = {
  'Not started': 'backlog',
  'In progress': 'in_progress',
  'Blocked': 'blocked',
  'Done': 'done',
};
const PRIORITY_NOTION_TO_DASH = {
  Urgent: 'urgent',
  High: 'high',
  Medium: 'medium',
  Low: 'low',
};

// Explicit Notion → dashboard category mapping. Preserves existing dashboard
// conventions (e.g., AI Bridge engagement work → delivery, not ai_bridge) so
// sync doesn't reclassify already-categorized tickets. Unknown Notion categories
// fall through to a normalized lowercase form.
const CATEGORY_NOTION_TO_DASH = {
  'AI Bridge': 'delivery',
  'Client Work': 'delivery',
  'CRM Development': 'engineering',
  'Marketing': 'marketing',
  'Admin': 'admin',
  'Sales & Outreach': 'sales',
  'Content': 'content',
  'Finance': 'finance',
  'Training': 'training',
  'Prism Studio': 'prism_studio',
};

function categoryNotionToDash(notionCat) {
  if (!notionCat) return 'general';
  if (CATEGORY_NOTION_TO_DASH[notionCat]) return CATEGORY_NOTION_TO_DASH[notionCat];
  return notionCat.toLowerCase().replace(/\s*&\s*/g, '_').replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
}

function readProp(props, key, type) {
  const p = props[key];
  if (!p) return null;
  switch (type) {
    case 'title':     return p.title?.[0]?.plain_text || '';
    case 'rich_text': return p.rich_text?.[0]?.plain_text || '';
    case 'select':    return p.select?.name || null;
    case 'status':    return p.status?.name || null;
    case 'date':      return p.date?.start || null;
    default:          return null;
  }
}

async function fetchAllNotionTickets({ apiKey, dbId, since }) {
  const out = [];
  let cursor;

  // Optional cutoff: only fetch pages whose Notion-side created_time is on or after `since`.
  // Used to keep legacy pages (pre-cleanup) invisible to the sync. See T-019 / T-021.
  // `since` should be ISO 8601 (e.g., "2026-04-30" or "2026-04-30T00:00:00Z").
  const filter = since
    ? { filter: { timestamp: 'created_time', created_time: { on_or_after: since } } }
    : {};

  // Hard cap to prevent runaway loops on a misconfigured DB.
  for (let i = 0; i < 50; i++) {
    const body = { page_size: 100, ...filter };
    if (cursor) body.start_cursor = cursor;
    const r = await fetch(`${NOTION_API}/databases/${dbId}/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!r.ok || j.object === 'error') {
      throw new Error(`notion query failed: ${j.code || r.status} ${j.message || ''}`);
    }
    out.push(...(j.results || []));
    if (!j.has_more) return out;
    cursor = j.next_cursor;
  }
  throw new Error('notion query exceeded page cap (50 pages)');
}

function mapPage(page) {
  const props = page.properties || {};
  return {
    notion_page_id: page.id,
    title: readProp(props, 'Ticket', 'title'),
    status: STATUS_NOTION_TO_DASH[readProp(props, 'Status', 'status')] || 'backlog',
    priority: PRIORITY_NOTION_TO_DASH[readProp(props, 'Priority', 'select')] || 'medium',
    category: categoryNotionToDash(readProp(props, 'Category', 'select')),
    due_date: readProp(props, 'Due Date', 'date'),
    t_id: readProp(props, 'T-ID', 'rich_text'),
    dashboard_ticket_id: readProp(props, 'Dashboard Ticket ID', 'rich_text'),
  };
}

async function patchNotionDashboardId({ apiKey, pageId, ticketKey }) {
  const r = await fetch(`${NOTION_API}/pages/${pageId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      properties: {
        'Dashboard Ticket ID': { rich_text: [{ text: { content: ticketKey } }] },
      },
    }),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(`notion patch failed: ${j.code || r.status} ${j.message || ''}`);
  }
}

// Sync entry point. Caller passes in db (better-sqlite3) + nextTicketKey fn from server.js.
//
// Options:
//   dryRun (bool)        — if true, no DB writes, no Notion writes; report-only.
//   skipDoneOnFirstRun   — first-run sweep ignores pages whose status is already 'done'.
//                          Use this once when bringing a previously-empty dashboard online to
//                          avoid spamming hundreds of completed tickets in one burst.
async function syncNotionTickets({
  db,
  nextTicketKey,
  apiKey,
  dbId,
  since,
  log = () => {},
  dryRun = false,
  skipDoneOnFirstRun = false,
}) {
  const stats = { created: 0, updated: 0, skipped: 0, errors: 0, wouldCreate: 0, wouldUpdate: 0 };
  const startedAt = Date.now();

  if (!apiKey || !dbId) {
    throw new Error('notionSync: missing NOTION_API_KEY or NOTION_TICKETS_DB_ID');
  }

  const pages = await fetchAllNotionTickets({ apiKey, dbId, since });
  log(
    `[notion-sync] fetched ${pages.length} pages from Notion${since ? ` (since ${since})` : ''}${dryRun ? ' (DRY RUN)' : ''}`
  );

  for (const page of pages) {
    try {
      const m = mapPage(page);

      if (m.t_id) { stats.skipped++; continue; }       // T-015 owns these
      if (!m.title) { stats.skipped++; continue; }      // malformed

      // Match: notion_page_id is the strong key. Fall back to ticket_key if Notion
      // page advertises a Dashboard Ticket ID but the dashboard side lacks the
      // back-reference (legacy data from earlier syncs).
      let existing = db.prepare(
        'SELECT id, ticket_key, title, status, priority, category, due_date, notion_page_id FROM tickets WHERE notion_page_id = ?'
      ).get(m.notion_page_id);

      if (!existing && m.dashboard_ticket_id) {
        existing = db.prepare(
          'SELECT id, ticket_key, title, status, priority, category, due_date, notion_page_id FROM tickets WHERE ticket_key = ?'
        ).get(m.dashboard_ticket_id);
      }

      if (existing) {
        const needsBackfill = !existing.notion_page_id;
        const changed =
          needsBackfill ||
          existing.title !== m.title ||
          existing.status !== m.status ||
          existing.priority !== m.priority ||
          existing.category !== m.category ||
          (existing.due_date || null) !== (m.due_date || null);

        if (!changed) { stats.skipped++; continue; }

        if (dryRun) {
          stats.wouldUpdate++;
          log(`[notion-sync] WOULD UPDATE ${existing.ticket_key} ← ${m.notion_page_id.slice(0, 8)} (${needsBackfill ? 'backfill notion_page_id; ' : ''}${m.title.slice(0, 40)})`);
          continue;
        }

        db.prepare(
          `UPDATE tickets
           SET title = ?, status = ?, priority = ?, category = ?, due_date = ?, notion_page_id = ?, updated_at = datetime('now')
           WHERE id = ?`
        ).run(m.title, m.status, m.priority, m.category, m.due_date, m.notion_page_id, existing.id);

        log(`[notion-sync] UPDATED ${existing.ticket_key} (notion ${m.notion_page_id.slice(0, 8)}) — ${m.title.slice(0, 50)}`);
        stats.updated++;
        continue;
      }

      // First-run skip: don't create dashboard rows for already-completed Notion work
      if (skipDoneOnFirstRun && m.status === 'done') {
        stats.skipped++;
        continue;
      }

      // CREATE — new dashboard ticket from a Notion page that wasn't tracked before
      if (dryRun) {
        stats.wouldCreate++;
        log(`[notion-sync] WOULD CREATE NTN-???? ← ${m.notion_page_id.slice(0, 8)} (${m.category}/${m.status}) — ${m.title.slice(0, 50)}`);
        continue;
      }

      const newId = require('crypto').randomUUID();
      const newKey = nextTicketKey('notion');
      const tags = `notion,src:notion,notion-page:${m.notion_page_id}`;

      db.prepare(
        `INSERT INTO tickets
           (id, ticket_key, source, title, description, ticket_type, category, status, priority, tags, created_by, due_date, notion_page_id)
         VALUES (?, ?, 'notion', ?, '', 'internal', ?, ?, ?, ?, 'notion-sync', ?, ?)`
      ).run(newId, newKey, m.title, m.category, m.status, m.priority, tags, m.due_date, m.notion_page_id);

      // Cross-link back to Notion. Failure here doesn't roll back the dashboard insert —
      // the next run will reconcile, and the dashboard side already has notion_page_id.
      try {
        await patchNotionDashboardId({ apiKey, pageId: m.notion_page_id, ticketKey: newKey });
      } catch (e) {
        log(`[notion-sync] WARN: Notion write-back failed for ${newKey}: ${e.message}`);
      }

      log(`[notion-sync] CREATED ${newKey} ← notion ${m.notion_page_id.slice(0, 8)} — ${m.title.slice(0, 50)}`);
      stats.created++;
    } catch (e) {
      log(`[notion-sync] ERROR: ${e.message}`);
      stats.errors++;
    }
  }

  stats.durationMs = Date.now() - startedAt;
  if (dryRun) {
    log(
      `[notion-sync] dry-run done — ${stats.wouldCreate} would create · ${stats.wouldUpdate} would update · ${stats.skipped} skipped · ${stats.errors} errors · ${stats.durationMs}ms`
    );
  } else {
    log(
      `[notion-sync] done — ${stats.created} created · ${stats.updated} updated · ${stats.skipped} skipped · ${stats.errors} errors · ${stats.durationMs}ms`
    );
  }
  return stats;
}

module.exports = { syncNotionTickets, fetchAllNotionTickets, mapPage };
