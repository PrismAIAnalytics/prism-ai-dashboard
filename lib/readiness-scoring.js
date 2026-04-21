// readiness-scoring.js
// AI Readiness Assessment scoring module — canonical 6-dimension taxonomy.
//
// Input:  { "1.1": 4, "1.2": 3, "1.3": "Central cloud database", "2.2": ["Cloud storage", "BI/dashboard tool"], ... }
// Output: { dimensions: { data_infra, tech_stack, process_maturity, team_readiness, governance, strategic_alignment },
//           overall: 3.4, band: "Developing" }

'use strict';

// Dimension → sub-question IDs (text questions are not scored)
const DIMENSION_QUESTIONS = {
  data_infra:          ['1.1', '1.2', '1.3', '1.4'],
  tech_stack:          ['2.1', '2.2', '2.3', '2.4'],
  process_maturity:    ['3.1', '3.2', '3.3', '3.4'],
  team_readiness:      ['4.1', '4.2', '4.3', '4.4'],
  governance:          ['5.1', '5.2', '5.3', '5.4'],
  strategic_alignment: ['6.1', '6.2'], // 6.3 and 6.4 are narrative text
};

// Single-select dropdowns: option label → 1–5 score
const SCALE_OPTIONS = {
  '1.3': {
    'Paper / manual records': 1,
    "People's heads / not documented": 1,
    'Excel / Google Sheets': 2,
    'Mix of tools': 3,
    'Central cloud database': 4,
    'Integrated warehouse': 5,
  },
  '2.3': {
    'Not at all': 1,
    'A little': 2,
    'Somewhat': 3,
    'Well': 4,
    'Fully integrated': 5,
  },
  '3.3': {
    '>75%': 1,
    '51–75%': 2,
    '26–50%': 3,
    '10–25%': 4,
    '<10%': 5,
  },
  '4.2': {
    'None': 1,
    'Self-taught': 2,
    '1–2 workshops': 3,
    'Formal for some': 4,
    'Ongoing program': 5,
  },
  '4.3': {
    "Don't know where to start": 2,
    'Fear of job loss': 1,
    'Lack of time': 2,
    'Too technical': 2,
    'Budget': 3,
    'No ROI case': 2,
    'Already adopting': 5,
  },
  '5.1': {
    'No & not considering': 1,
    'No but discussing': 2,
    'Informal only': 3,
    'Written policy': 4,
    'Written & enforced': 5,
  },
  '6.2': {
    'Skeptical': 1,
    'Cautious': 2,
    'Interested': 3,
    'Committed': 4,
    'Fully invested': 5,
  },
};

// Multi-select checkbox scoring: selected array → 1–5 score
const MULTI_SCORING = {
  // 2.2 — tools in use
  '2.2': (selected) => {
    if (!Array.isArray(selected) || selected.length === 0) return 1;
    if (selected.includes('None of the above') || selected.includes('None')) return 1;
    const c = selected.length;
    if (c >= 5) return 5;
    if (c === 4) return 4;
    if (c === 3) return 3;
    if (c >= 1) return 2;
    return 1;
  },
  // 3.2 — process descriptors; net score → 1–5
  '3.2': (selected) => {
    if (!Array.isArray(selected) || selected.length === 0) return 3;
    const weights = {
      'Written SOPs for most tasks': 1,
      'Some but outdated': 0,
      'Rely on 1–2 people': -1,
      'Manual weekly tasks': 0,
      'Identified automation candidates': 1,
      'No documentation': -2,
    };
    const net = selected.reduce((acc, s) => acc + (weights[s] || 0), 0);
    // Map net [-3..+2] → 1..5
    if (net >= 2) return 5;
    if (net === 1) return 4;
    if (net === 0) return 3;
    if (net === -1) return 2;
    return 1;
  },
  // 5.2 — data protections
  '5.2': (selected) => {
    if (!Array.isArray(selected) || selected.length === 0) return 1;
    if (selected.includes('None of the above') || selected.includes('None')) return 1;
    const c = selected.length;
    if (c >= 6) return 5;
    if (c >= 4) return 4;
    if (c >= 2) return 3;
    if (c >= 1) return 2;
    return 1;
  },
};

// Resolve a single question's answer to a numeric 1–5 score. Returns null if unscored/missing.
function resolveScore(questionId, answer) {
  if (answer === null || answer === undefined) return null;

  // Numeric Likert scale answers (1–5) come through as-is
  if (typeof answer === 'number' && answer >= 1 && answer <= 5) {
    return answer;
  }
  // Coerce numeric strings
  if (typeof answer === 'string' && /^[1-5]$/.test(answer)) {
    return Number(answer);
  }

  // Multi-select
  if (MULTI_SCORING[questionId]) {
    return MULTI_SCORING[questionId](answer);
  }

  // Single-select dropdown
  if (SCALE_OPTIONS[questionId] && typeof answer === 'string') {
    const s = SCALE_OPTIONS[questionId][answer];
    return typeof s === 'number' ? s : null;
  }

  return null;
}

// Readiness band bucketing for overall score
function bandFor(overall) {
  if (overall >= 4.3) return 'Advanced';
  if (overall >= 3.3) return 'Ready';
  if (overall >= 2.3) return 'Developing';
  return 'Emerging';
}

// Main scoring function
function score(responses) {
  if (!responses || typeof responses !== 'object') {
    throw new Error('responses must be an object keyed by question ID');
  }

  const dimensions = {};
  let overallSum = 0;
  let overallCount = 0;

  for (const [dim, qIds] of Object.entries(DIMENSION_QUESTIONS)) {
    let sum = 0;
    let count = 0;
    for (const qId of qIds) {
      const s = resolveScore(qId, responses[qId]);
      if (s !== null) {
        sum += s;
        count += 1;
      }
    }
    // Dimension = avg of answered sub-questions; null if no answers
    const dimScore = count > 0 ? Math.round((sum / count) * 10) / 10 : null;
    dimensions[dim] = dimScore;
    if (dimScore !== null) {
      overallSum += dimScore;
      overallCount += 1;
    }
  }

  const overall = overallCount > 0 ? Math.round((overallSum / overallCount) * 10) / 10 : null;
  const band = overall !== null ? bandFor(overall) : null;

  return { dimensions, overall, band };
}

module.exports = {
  score,
  bandFor,
  resolveScore,
  DIMENSION_QUESTIONS,
  SCALE_OPTIONS,
  MULTI_SCORING,
};
