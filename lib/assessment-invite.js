// assessment-invite.js
// Builds the AI Readiness Assessment invitation email — the single source of
// truth for the invite's copy and markup (T-108). Used by the manual
// send-assessment endpoint and the draft-and-approve flow (PR-5).
//
// Dual-legible by design: a warm first-person `text` body for a human invested
// in AI, AND a semantic `html` body whose actions are real, labeled links plus
// schema.org email actions so an agentic inbox can surface the next step. Every
// action is an explicit endpoint — never an image-only button.
//
// The email is framed as value ("your AI Readiness Assessment"), never as
// "intake". Brand voice: measured, first-person, no exclamation points.
'use strict';

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Build the assessment invitation email.
 * @param {object} opts
 * @param {string} opts.firstName       - recipient first name (greeting)
 * @param {string} opts.assessmentUrl   - the ?client=<id> assessment link
 * @param {string} [opts.schedulingUrl] - book-a-call link; omitted if falsy
 * @param {string} opts.personalLine    - REQUIRED one-line note from Michele
 * @param {string} opts.replyTo         - reply-to address (shown + linked)
 * @returns {{subject:string, text:string, html:string}}
 */
function buildAssessmentInvite({ firstName, assessmentUrl, schedulingUrl, personalLine, replyTo }) {
  const line = (personalLine || '').trim();
  if (!line) throw new Error('buildAssessmentInvite: personalLine is required');
  if (!assessmentUrl) throw new Error('buildAssessmentInvite: assessmentUrl is required');

  const first = (firstName || '').trim() || 'there';
  const reply = (replyTo || 'michele@prismaianalytics.com').trim();
  const sched = (schedulingUrl || '').trim();

  const subject = 'Your AI Readiness Assessment — Prism AI Analytics';

  const textLines = [
    `Hi ${first},`,
    '',
    line,
    '',
    'When you have about 15 minutes, the AI Readiness Assessment below gives us a',
    'shared, specific starting point. It maps where you are across six dimensions',
    'and returns tailored recommendations you can keep — whether or not we work',
    'together.',
    '',
    `Take the assessment: ${assessmentUrl}`,
  ];
  if (sched) textLines.push(`Prefer to talk it through first? Find a time: ${sched}`);
  textLines.push(
    '',
    'Reply to this email any time — it comes straight to me.',
    '',
    'Michele Fisher',
    'Prism AI Analytics',
    reply,
  );
  const text = textLines.join('\n');

  // schema.org email action — an agentic inbox / Gmail can surface "Take the
  // assessment" as the primary next step without scraping the prose.
  const jsonLd = {
    '@context': 'http://schema.org',
    '@type': 'EmailMessage',
    potentialAction: {
      '@type': 'ViewAction',
      target: assessmentUrl,
      name: 'Take the AI Readiness Assessment',
    },
    publisher: { '@type': 'Organization', name: 'Prism AI Analytics' },
  };

  const schedHtml = sched
    ? `<p style="margin:0 0 16px">Prefer to talk it through first? <a href="${escapeHtml(sched)}">Find a time that works</a>.</p>`
    : '';

  const html = [
    `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>`,
    '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#1B2F5E;max-width:560px">',
    `<p style="margin:0 0 16px">Hi ${escapeHtml(first)},</p>`,
    `<p style="margin:0 0 16px">${escapeHtml(line)}</p>`,
    '<p style="margin:0 0 16px">When you have about 15 minutes, the AI Readiness Assessment below gives us a shared, specific starting point. It maps where you are across six dimensions and returns tailored recommendations you can keep — whether or not we work together.</p>',
    `<p style="margin:0 0 16px"><a href="${escapeHtml(assessmentUrl)}" style="color:#5577C0;font-weight:600">Take the AI Readiness Assessment →</a></p>`,
    schedHtml,
    `<p style="margin:0 0 16px">Reply to this email any time — it comes straight to me, at <a href="mailto:${escapeHtml(reply)}">${escapeHtml(reply)}</a>.</p>`,
    '<p style="margin:24px 0 0">Michele Fisher<br>Prism AI Analytics</p>',
    '</div>',
  ].join('');

  return { subject, text, html };
}

module.exports = { buildAssessmentInvite, escapeHtml };
