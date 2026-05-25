/*
 * T-076 — Knowledgebase visibility curation.
 *
 * Maintains config/knowledgebase-visibility.json as an explicit allowlist of
 * item IDs marked "public". Items not present in the allowlist default to
 * "non-public" — conservative default so newly auto-scanned content does not
 * appear publicly until explicitly promoted.
 *
 * File shape:
 *   {
 *     "updated_at": "2026-05-25T...Z",
 *     "public": ["blog/configuration-drift-...", "dashboard/prism-3-layer-delivery", ...]
 *   }
 *
 * Atomic writes via tmp-file + rename so a crash mid-write cannot corrupt
 * the JSON.
 */
const fs = require('fs');
const path = require('path');

const VISIBILITY_PATH = path.join(__dirname, '..', 'config', 'knowledgebase-visibility.json');

function readState() {
  if (!fs.existsSync(VISIBILITY_PATH)) {
    return { updated_at: null, public: [] };
  }
  try {
    const raw = fs.readFileSync(VISIBILITY_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      updated_at: parsed.updated_at || null,
      public: Array.isArray(parsed.public) ? parsed.public : [],
    };
  } catch (err) {
    console.warn('[kb-visibility] parse failed, treating as empty:', err.message);
    return { updated_at: null, public: [] };
  }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(VISIBILITY_PATH), { recursive: true });
  const tmp = VISIBILITY_PATH + '.tmp';
  const payload = {
    updated_at: new Date().toISOString(),
    public: [...new Set(state.public || [])].sort(),
  };
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, VISIBILITY_PATH);
  return payload;
}

function getPublicSet() {
  return new Set(readState().public);
}

function setVisibility(itemId, visibility) {
  if (!itemId || typeof itemId !== 'string') {
    throw new Error('item_id required');
  }
  if (visibility !== 'public' && visibility !== 'non-public') {
    throw new Error('visibility must be "public" or "non-public"');
  }
  const state = readState();
  const current = new Set(state.public);
  if (visibility === 'public') {
    current.add(itemId);
  } else {
    current.delete(itemId);
  }
  const payload = writeState({ public: [...current] });
  return { item_id: itemId, visibility, updated_at: payload.updated_at };
}

function decorateManifest(manifest) {
  if (!manifest || !manifest.topics) return manifest;
  const publicSet = getPublicSet();
  let publicCount = 0;
  let nonPublicCount = 0;
  const topics = manifest.topics.map(topic => ({
    ...topic,
    items: (topic.items || []).map(item => {
      const visibility = publicSet.has(item.id) ? 'public' : 'non-public';
      if (visibility === 'public') publicCount += 1; else nonPublicCount += 1;
      return { ...item, visibility };
    }),
  }));
  return {
    ...manifest,
    topics,
    visibility_counts: { public: publicCount, 'non-public': nonPublicCount },
  };
}

module.exports = {
  VISIBILITY_PATH,
  readState,
  setVisibility,
  decorateManifest,
};
