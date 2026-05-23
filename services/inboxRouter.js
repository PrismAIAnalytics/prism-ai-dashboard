// inboxRouter.js — Mission Control Inbox capture/list/triage logic.
//
// T-037 (Phase 1 of T-036–T-055 Mission Control roadmap).
//
// Sticky text-input on every Dashboard page creates an inbox capture: a
// Notion ticket with source='cowork:inbox', Status='Not started',
// Priority='Medium'. Inbox panel on Daily Agenda lists open captures and
// triages them into real tickets, open questions, or archives them.
//
// Encapsulated here (away from server.js routes) so each piece is unit-
// testable in isolation without spinning up Express. The adapter is
// injected by the caller — defaults to the live notionAdapter — so tests
// can pass a stub.

'use strict';

const realNotionAdapter = require('./notionAdapter');

const SOURCE_PREFIX = 'cowork:inbox';
const TITLE_MAX = 60;
const CAPTURE_MAX = 5000;
const SLA_THRESHOLD = 20;

const ALLOWED_CATEGORIES = new Set([
  'delivery', 'engineering', 'marketing', 'admin', 'sales',
  'content', 'finance', 'training', 'prism_studio',
]);

const ALLOWED_ACTIONS = new Set(['ticket', 'open_question', 'dismiss']);

// Title derivation: first line of the capture, trimmed and truncated to
// TITLE_MAX chars with an ellipsis when cut. The full text rides as the
// `description` field where Notion's page body would be once T-040 ships.
function deriveTitle(text) {
  const firstLine = String(text).split(/\r?\n/)[0].trim();
  if (firstLine.length <= TITLE_MAX) return firstLine;
  return firstLine.slice(0, TITLE_MAX - 1).trimEnd() + '…';
}

function validateCaptureText(text) {
  if (text == null) return 'text is required';
  const s = String(text).trim();
  if (!s) return 'text is required';
  if (s.length > CAPTURE_MAX) return `text exceeds ${CAPTURE_MAX} chars`;
  return null;
}

function makeRouter(adapter = realNotionAdapter) {
  async function createCapture(text, capturedBy = null) {
    const err = validateCaptureText(text);
    if (err) {
      const e = new Error(err);
      e.status = 400;
      throw e;
    }
    const trimmed = String(text).trim();
    const title = deriveTitle(trimmed);
    // Priority Medium / Status backlog (= Notion 'Not started') per leverage
    // brief. Category intentionally omitted — triage assigns it.
    // capturedBy is the dashboard session username (null when not authenticated
    // via a session token — e.g., raw API_KEY use). Adapter writes it to the
    // optional "Captured By" Notion property; missing-property is safe (see
    // notionAdapter.createTicket fallback).
    const ticket = await adapter.createTicket({
      title,
      status: 'backlog',
      priority: 'medium',
      source: SOURCE_PREFIX,
      captured_by: capturedBy || null,
    });
    return ticket;
  }

  async function listCaptures() {
    const { tickets, stale } = await adapter.listTickets({
      source_prefix: SOURCE_PREFIX,
      status: 'backlog',
    });
    // Newest captures surface first — created_at desc.
    const ordered = (tickets || []).slice().sort((a, b) =>
      (b.created_at || '').localeCompare(a.created_at || '')
    );
    return {
      captures: ordered,
      count: ordered.length,
      sla_threshold: SLA_THRESHOLD,
      sla_breached: ordered.length > SLA_THRESHOLD,
      stale: !!stale,
    };
  }

  async function triage(pageId, action, params = {}) {
    if (!pageId) {
      const e = new Error('page id is required');
      e.status = 400;
      throw e;
    }
    if (!ALLOWED_ACTIONS.has(action)) {
      const e = new Error(`action must be one of: ${[...ALLOWED_ACTIONS].join(', ')}`);
      e.status = 400;
      throw e;
    }

    if (action === 'dismiss') {
      await adapter.archiveTicket(pageId);
      return { ok: true, action, page_id: pageId, archived: true };
    }

    if (action === 'ticket') {
      const updates = {};
      if (params.category !== undefined && params.category !== null && params.category !== '') {
        if (!ALLOWED_CATEGORIES.has(params.category)) {
          const e = new Error(`category must be one of: ${[...ALLOWED_CATEGORIES].join(', ')}`);
          e.status = 400;
          throw e;
        }
        updates.category = params.category;
      }
      if (params.due_date !== undefined && params.due_date !== null && params.due_date !== '') {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(params.due_date))) {
          const e = new Error('due_date must be ISO YYYY-MM-DD');
          e.status = 400;
          throw e;
        }
        updates.due_date = params.due_date;
      }
      // Triaged into a real ticket — flip source off the inbox prefix so it
      // drops out of the inbox view. `manual:cowork-triaged` keeps a paper
      // trail without re-categorizing into a real source enum.
      updates.source = 'manual:cowork-triaged';
      if (Object.keys(updates).length === 1 && 'source' in updates) {
        // No category or due_date supplied — still triage, just less metadata.
      }
      const ticket = await adapter.updateTicket(pageId, updates);
      return { ok: true, action, ticket };
    }

    if (action === 'open_question') {
      // Vault writer (T-040) is the dependency for writing into
      // open-questions.md. Until it ships, surface a clear 503 so the
      // frontend can fall back to "promote to ticket instead".
      const e = new Error(
        'open_question triage requires T-040 vault writer; promote to ticket instead'
      );
      e.status = 503;
      throw e;
    }

    // Unreachable — ALLOWED_ACTIONS guard above.
    const e = new Error('unknown action');
    e.status = 400;
    throw e;
  }

  return { createCapture, listCaptures, triage };
}

const _default = makeRouter();

module.exports = {
  createCapture: (text, capturedBy) => _default.createCapture(text, capturedBy),
  listCaptures: () => _default.listCaptures(),
  triage: (pageId, action, params) => _default.triage(pageId, action, params),
  // Factory + constants exposed for tests / route handlers.
  makeRouter,
  SOURCE_PREFIX,
  TITLE_MAX,
  CAPTURE_MAX,
  SLA_THRESHOLD,
  ALLOWED_CATEGORIES,
  ALLOWED_ACTIONS,
  deriveTitle,
  validateCaptureText,
};
