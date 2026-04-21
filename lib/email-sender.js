// email-sender.js
// Thin email abstraction. Currently stubs to console + persists a record to the
// `email_log` table so nothing is lost before Resend is wired up. When
// process.env.RESEND_API_KEY is set, it uses Resend instead of stubbing.
//
// Usage:
//   const email = require('./email-sender');
//   await email.send({ to, subject, html, text, tags, db });

'use strict';

const FROM_DEFAULT = process.env.EMAIL_FROM || 'Prism AI Analytics <michele@prismaianalytics.com>';
const REPLY_TO_DEFAULT = process.env.EMAIL_REPLY_TO || 'michele@prismaianalytics.com';

let resendClient = null;
function getResendClient() {
  if (resendClient !== null) return resendClient;
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    resendClient = false; // cache "not configured" so we don't keep re-checking
    return false;
  }
  try {
    const { Resend } = require('resend');
    resendClient = new Resend(apiKey);
    return resendClient;
  } catch (e) {
    console.warn('[email] resend package not installed — falling back to stub. Run: npm install resend');
    resendClient = false;
    return false;
  }
}

// Ensure the email_log table exists. Idempotent.
function ensureEmailLog(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS email_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sent_at TEXT DEFAULT (datetime('now')),
    to_address TEXT NOT NULL,
    from_address TEXT,
    subject TEXT,
    body_text TEXT,
    body_html TEXT,
    tags_json TEXT,
    status TEXT,              -- 'sent' | 'stubbed' | 'failed'
    provider TEXT,            -- 'resend' | 'stub'
    provider_message_id TEXT,
    error TEXT
  )`);
}

async function send({ to, subject, html, text, tags, from, replyTo, db }) {
  if (!to || !subject) throw new Error('email.send: to + subject required');
  if (db) ensureEmailLog(db);

  const resolvedFrom = from || FROM_DEFAULT;
  const resolvedReplyTo = replyTo || REPLY_TO_DEFAULT;
  const client = getResendClient();

  // Stub path: Resend not configured
  if (!client) {
    console.log('\n[email STUB] (set RESEND_API_KEY to actually send)');
    console.log('  from:', resolvedFrom);
    console.log('  to:  ', to);
    console.log('  subj:', subject);
    console.log('  text:', (text || '').slice(0, 400));
    console.log();
    if (db) {
      db.prepare(`INSERT INTO email_log (to_address, from_address, subject, body_text, body_html, tags_json, status, provider)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        Array.isArray(to) ? to.join(',') : to,
        resolvedFrom, subject, text || null, html || null,
        tags ? JSON.stringify(tags) : null, 'stubbed', 'stub'
      );
    }
    return { ok: true, stubbed: true };
  }

  // Real send via Resend
  try {
    const res = await client.emails.send({
      from: resolvedFrom,
      to: Array.isArray(to) ? to : [to],
      replyTo: resolvedReplyTo,
      subject,
      html,
      text,
      tags: tags ? Object.entries(tags).map(([k, v]) => ({ name: k, value: String(v) })) : undefined,
    });
    const messageId = res?.data?.id || null;
    if (db) {
      db.prepare(`INSERT INTO email_log (to_address, from_address, subject, body_text, body_html, tags_json, status, provider, provider_message_id)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        Array.isArray(to) ? to.join(',') : to,
        resolvedFrom, subject, text || null, html || null,
        tags ? JSON.stringify(tags) : null, 'sent', 'resend', messageId
      );
    }
    return { ok: true, stubbed: false, messageId };
  } catch (e) {
    if (db) {
      db.prepare(`INSERT INTO email_log (to_address, from_address, subject, body_text, body_html, tags_json, status, provider, error)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        Array.isArray(to) ? to.join(',') : to,
        resolvedFrom, subject, text || null, html || null,
        tags ? JSON.stringify(tags) : null, 'failed', 'resend', e.message
      );
    }
    return { ok: false, error: e.message };
  }
}

module.exports = { send, ensureEmailLog };
