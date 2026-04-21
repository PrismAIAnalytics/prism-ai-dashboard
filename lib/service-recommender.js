// service-recommender.js
// Given an assessment (band, dimension scores, stated category of interest,
// and narrative responses), rank the 15 catalog services and return the top N.
//
// Usage:
//   const { recommend } = require('./service-recommender');
//   const recs = recommend({ band, dimensions, category, responses }, db);
//   // recs = [{ service_id, name, price_min, price_max, price_unit, why }, ...]

'use strict';

// Service catalog name → "track" classification. Used for filtering by category.
// Sourced from the services table; keep in sync when the catalog changes.
const TRACK_BY_NAME = {
  // Data & Analytics track
  'AI Starter Kit for Small Business':    'analytics',
  'Data Health Audit':                    'analytics',
  'AI Readiness Assessment':              'analytics',   // the paid debrief engagement
  'AI Workflow Automation':               'analytics',
  'Analytics & Reporting Modernization':  'analytics',
  'Analytics Support Retainer':           'analytics',
  'Fractional AI Advisor Retainer':       'analytics',
  'Lunch & Learn Workshop':               'analytics',
  // Compliance & Security track
  'AI Governance & Hardening Assessment': 'compliance',
  'CIS/STIG Coverage Gap Assessment':     'compliance',
  'Audit Evidence Automation':            'compliance',
  'Compliance Data Hub':                  'compliance',
  'Drift Detection Blueprint':            'compliance',
  'Remediation Automation Sprint':        'compliance',
  'Managed Compliance Engineering':       'compliance',
};

// Public website dropdown "Service of Interest" → internal track.
// If the prospect didn't pick a category, default to 'both' and rely on responses.
const CATEGORY_TO_TRACK = {
  'AI & Analytics Consulting':            'analytics',
  'Reporting Modernization':              'analytics',
  'Data Pipeline & Automation':           'analytics',
  'Power BI Dashboard Development':       'analytics',
  'Data Quality & QA Testing':            'analytics',
  'Stakeholder Reporting & Visualizations': 'analytics',
  'Compliance Automation Engineering':    'compliance',
  'Managed Compliance Operations':        'compliance',
  'Audit Evidence & Reporting':           'compliance',
  'AI Governance & Hardening':            'compliance',
  'Other / Not Sure Yet':                 'both',
};

// Band → service-name preference list, ordered by fit (best first).
// Kept intentionally separate from price to keep the logic readable.
const BAND_PREFERENCE = {
  Emerging: [
    'AI Starter Kit for Small Business',   // $499 — cheapest entry point
    'Data Health Audit',                   // $750-1,200 — fix foundation
    'Lunch & Learn Workshop',              // $500-800 — team enablement
    'Analytics Support Retainer',          // $800-1,500/mo — ongoing help
    'AI Readiness Assessment',             // $1,500-3,000 — paid debrief
  ],
  Developing: [
    'AI Readiness Assessment',             // paid debrief = Michele's core engagement
    'Data Health Audit',                   // usually still needed
    'AI Workflow Automation',              // one targeted pilot
    'Analytics & Reporting Modernization', // if analytics-flavored
    'Analytics Support Retainer',
  ],
  Ready: [
    'AI Workflow Automation',              // project sized to their band
    'Analytics & Reporting Modernization',
    'AI Readiness Assessment',             // formal debrief still valuable
    'Fractional AI Advisor Retainer',      // ongoing strategy
  ],
  Advanced: [
    'Fractional AI Advisor Retainer',      // monthly strategy
    'AI Workflow Automation',              // scale projects
    'Analytics & Reporting Modernization',
  ],
};

// Compliance track overrides per band — used when prospect signals compliance
// interest or shows weak governance.
const BAND_COMPLIANCE_PREFERENCE = {
  Emerging: [
    'AI Governance & Hardening Assessment',
    'CIS/STIG Coverage Gap Assessment',
    'AI Starter Kit for Small Business',
    'Lunch & Learn Workshop',
  ],
  Developing: [
    'AI Governance & Hardening Assessment',
    'CIS/STIG Coverage Gap Assessment',
    'Audit Evidence Automation',
    'AI Readiness Assessment',
  ],
  Ready: [
    'Audit Evidence Automation',
    'Drift Detection Blueprint',
    'Remediation Automation Sprint',
    'Managed Compliance Engineering',
  ],
  Advanced: [
    'Managed Compliance Engineering',
    'Compliance Data Hub',
    'Remediation Automation Sprint',
    'Drift Detection Blueprint',
  ],
};

// Per-service "why this fits" rationale templates. Rendered in admin view
// so Michele sees why each rec was generated.
const RATIONALE = {
  'AI Starter Kit for Small Business':   'Cheapest entry point ($499). Good for Emerging bands to build one working AI use case before committing to larger projects.',
  'Data Health Audit':                   'Foundation work. Recommended when data_infra < 3.5 — the data needs cleaning before any AI can add value.',
  'AI Readiness Assessment':             'Paid engagement: formal 6-dimension debrief + 90-day roadmap deliverable. Core Michele offering, good fit across most bands.',
  'AI Workflow Automation':              'Project-sized pilot ($4-12k). Best fit when band is Developing+ and process_maturity is at least moderate.',
  'Analytics & Reporting Modernization': 'For clients whose stated outcome involves reporting, dashboards, or replacing spreadsheet workflows.',
  'Analytics Support Retainer':          'Ongoing support ($800-1,500/mo) — good for Emerging/Developing bands where the client needs a technical partner but not a full project yet.',
  'Fractional AI Advisor Retainer':      'Strategic monthly engagement ($1.5-3k/mo). Best fit for Ready+ clients who want ongoing guidance.',
  'Lunch & Learn Workshop':              'Team enablement ($500-800). Low-commitment way to warm up a team when team_readiness is low.',
  'AI Governance & Hardening Assessment':'Governance-focused diagnostic. Recommended when governance score is weak or prospect selected a compliance service.',
  'CIS/STIG Coverage Gap Assessment':    'Baseline compliance posture check. Fits prospects with compliance obligations and low governance scores.',
  'Audit Evidence Automation':           'For clients under audit regimes (SOC 2, HIPAA, etc.) — automates evidence collection.',
  'Compliance Data Hub':                 'Large compliance platform build ($15-40k). Advanced clients with multi-framework obligations.',
  'Drift Detection Blueprint':           'Continuous compliance monitoring design. Ready+ compliance clients.',
  'Remediation Automation Sprint':       'Closing identified compliance gaps. Ready+ clients with known findings to fix.',
  'Managed Compliance Engineering':      'Ongoing compliance ops as a service ($3-8.5k/mo). Best for Advanced or compliance-heavy clients.',
};

// Resolve a human-readable category string from whatever the form sent.
// Accepts either the public dropdown label or a bare 'analytics'/'compliance' hint.
function resolveTrack(category, dimensions, responses) {
  if (!category) category = '';
  const known = CATEGORY_TO_TRACK[category];
  if (known && known !== 'both') return known;

  // Signal from responses: if they listed a compliance regime in 5.4_regimes, lean compliance
  const regimes = responses && responses['5.4_regimes'];
  if (Array.isArray(regimes)) {
    const realRegimes = regimes.filter(r => r && r !== 'None');
    if (realRegimes.length > 0) return 'compliance';
  }
  // Signal from governance score — very low governance + no category often means
  // they don't realize they have compliance risk; keep it analytics-track but
  // we'll still include at least one compliance rec (handled in recommend()).
  return 'analytics';
}

// Main entry point.
// Input:
//   { band, dimensions, category, responses }
//   db — better-sqlite3 handle (for pulling service rows with ids + prices)
// Output:
//   { services: [ { service_id, name, price_min, price_max, price_unit, why, rank } ], track, total_low, total_high }
function recommend(input, db) {
  const { band, dimensions, category, responses } = input || {};
  if (!band) return { services: [], track: null, total_low: 0, total_high: 0 };

  const track = resolveTrack(category, dimensions, responses);
  const primaryList = track === 'compliance'
    ? BAND_COMPLIANCE_PREFERENCE[band] || []
    : BAND_PREFERENCE[band] || [];

  // Build the top 3 list. If the band-preference has fewer than 3, fill from
  // the other track so we always have at least 2-3 suggestions.
  const ordered = [...primaryList];

  // Always ensure AI Readiness Assessment (the paid debrief) appears at least
  // once when band is Emerging/Developing/Ready, since that's Michele's core engagement.
  if (['Emerging', 'Developing', 'Ready'].includes(band) && !ordered.includes('AI Readiness Assessment')) {
    ordered.push('AI Readiness Assessment');
  }

  // Governance boost: if governance score < 2.5 and it's not already compliance-track,
  // surface one compliance rec to flag the gap.
  const govScore = dimensions && dimensions.governance;
  if (track !== 'compliance' && typeof govScore === 'number' && govScore < 2.5) {
    if (!ordered.includes('AI Governance & Hardening Assessment')) {
      ordered.push('AI Governance & Hardening Assessment');
    }
  }

  // Data-infra boost: if data_infra score < 2.5, surface Data Health Audit.
  const dataScore = dimensions && dimensions.data_infra;
  if (typeof dataScore === 'number' && dataScore < 2.5 && !ordered.includes('Data Health Audit')) {
    // Insert near the top (right after the #1 pick) so it's visible
    ordered.splice(1, 0, 'Data Health Audit');
  }

  // Top 3 unique service names
  const picks = [];
  for (const n of ordered) {
    if (!picks.includes(n)) picks.push(n);
    if (picks.length >= 3) break;
  }

  // Resolve names → DB rows (for current ids + prices)
  const rows = db
    .prepare('SELECT id, name, service_type, price_min, price_max, price_unit FROM services WHERE is_active = 1 AND name IN (' + picks.map(() => '?').join(',') + ')')
    .all(...picks);
  const byName = Object.fromEntries(rows.map(r => [r.name, r]));

  const services = picks
    .map((name, idx) => {
      const row = byName[name];
      if (!row) return null;
      return {
        service_id: row.id,
        name: row.name,
        service_type: row.service_type,
        price_min: row.price_min,
        price_max: row.price_max,
        price_unit: row.price_unit,
        why: RATIONALE[name] || '',
        rank: idx + 1,
      };
    })
    .filter(Boolean);

  const totalLow  = services.reduce((acc, s) => acc + (s.price_min || 0), 0);
  const totalHigh = services.reduce((acc, s) => acc + (s.price_max || 0), 0);

  return {
    services,
    track,
    total_low: totalLow,
    total_high: totalHigh,
  };
}

module.exports = {
  recommend,
  resolveTrack,
  TRACK_BY_NAME,
  CATEGORY_TO_TRACK,
  BAND_PREFERENCE,
  BAND_COMPLIANCE_PREFERENCE,
  RATIONALE,
};
