/*
 * T-076 — Knowledgebase runtime reader.
 *
 * Reads the committed manifest at config/knowledgebase-manifest.json that
 * scripts/rebuild-knowledgebase-manifest.js produces. Railway only ever
 * reads — the scan itself happens locally pre-commit. Graceful degradation
 * when the manifest is missing (returns an empty, well-shaped payload).
 */
const fs = require('fs');
const path = require('path');

const MANIFEST_PATH = path.join(__dirname, '..', 'config', 'knowledgebase-manifest.json');

let cache = null;
let cacheMtimeMs = 0;

function loadManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    return {
      available: false,
      reason: 'manifest-missing',
      generated_at: null,
      counts: { total: 0, by_topic: {}, by_content_type: {} },
      topics: [],
    };
  }
  const stat = fs.statSync(MANIFEST_PATH);
  if (cache && stat.mtimeMs === cacheMtimeMs) return cache;
  try {
    const raw = fs.readFileSync(MANIFEST_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    cache = { available: true, ...parsed };
    cacheMtimeMs = stat.mtimeMs;
    return cache;
  } catch (err) {
    return {
      available: false,
      reason: 'manifest-parse-error',
      error: err.message,
      counts: { total: 0, by_topic: {}, by_content_type: {} },
      topics: [],
    };
  }
}

function getManifest() {
  return loadManifest();
}

function clearCache() {
  cache = null;
  cacheMtimeMs = 0;
}

module.exports = { getManifest, clearCache, MANIFEST_PATH };
