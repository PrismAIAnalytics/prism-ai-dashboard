// prismStudioActivityLog.js — read-only proxy for the Notion "Prism Studio — Activity Log" page.
//
// PS-053. Companion to services/notionSync.js (which mirrors database rows).
// This one reads page-content, not database-rows. Different shape, different cadence.
//
// Stub semantics:
//   - If NOTION_API_KEY is missing, returns { blocks: [], stub: true } so local dev still loads.
//   - On any Notion API error, returns { blocks: [], error: <message> } — never throws to the caller.
//     The Live Activity card is non-critical; a Notion outage shouldn't break the dashboard page.
//
// Block rendering:
//   This module returns raw Notion blocks. The dashboard frontend decides how rich to render.
//   Stub-grade renderer in public/index.html handles: paragraph, heading_1/2/3, bulleted_list_item,
//   numbered_list_item, to_do, divider. Other block types fall through to "[unsupported block: <type>]".
//
// Page id is the production Notion page from PS-050 (Prism Studio — Activity Log).
// Override via PRISM_STUDIO_ACTIVITY_LOG_PAGE_ID env var if Michele moves the page.

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

const DEFAULT_PAGE_ID = '350236b6-b03a-816f-8d5c-e9f9d423f32a'; // PS-050 page; see workflow doc
const DEFAULT_LIMIT = 50;

async function notionFetch(path, { apiKey }) {
  const r = await fetch(`${NOTION_API}${path}`, {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Notion-Version': NOTION_VERSION,
    },
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`Notion ${path}: ${r.status} ${body.slice(0, 200)}`);
  }
  return r.json();
}

// Returns { blocks, updated_at, stub?, error? } — never throws.
async function fetchActivityLogTail({ apiKey, pageId, limit } = {}) {
  const effectivePageId = pageId || process.env.PRISM_STUDIO_ACTIVITY_LOG_PAGE_ID || DEFAULT_PAGE_ID;
  const effectiveLimit = limit || DEFAULT_LIMIT;

  if (!apiKey) {
    return { blocks: [], stub: true, page_id: effectivePageId };
  }

  try {
    // GET /v1/pages/{id} → page metadata for last_edited_time
    // GET /v1/blocks/{id}/children → block array (paginated; first page is enough for the tail)
    const [page, children] = await Promise.all([
      notionFetch(`/pages/${effectivePageId}`, { apiKey }),
      notionFetch(`/blocks/${effectivePageId}/children?page_size=${Math.min(effectiveLimit, 100)}`, { apiKey }),
    ]);

    const blocks = (children.results || []).slice(-effectiveLimit);

    return {
      blocks,
      updated_at: page.last_edited_time || null,
      page_id: effectivePageId,
      page_url: page.url || null,
      has_more: children.has_more || false,
    };
  } catch (err) {
    return {
      blocks: [],
      error: err.message,
      page_id: effectivePageId,
    };
  }
}

module.exports = { fetchActivityLogTail };
