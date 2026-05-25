#!/usr/bin/env node
/*
 * T-076 — Rebuild Knowledgebase manifest.
 *
 * Crawls prism_website_project + the dashboard's own public/prism-*.html
 * infographic previews, classifies each item by topic + content type, and
 * writes config/knowledgebase-manifest.json. The runtime endpoint
 * (services/knowledgebaseScanner.js + GET /api/knowledgebase) reads the
 * committed manifest — Railway never executes this script.
 *
 * Run locally after publishing new content:
 *   npm run knowledgebase:rebuild
 *
 * Override the website root with PRISM_WEBSITE_ROOT if non-default.
 */
const fs = require('fs');
const path = require('path');

const DASHBOARD_ROOT = path.resolve(__dirname, '..');
const DEFAULT_WEBSITE_ROOT = path.resolve(DASHBOARD_ROOT, '..', '..', 'prism_website_project');
const WEBSITE_ROOT = process.env.PRISM_WEBSITE_ROOT
  ? path.resolve(process.env.PRISM_WEBSITE_ROOT)
  : DEFAULT_WEBSITE_ROOT;
const MANIFEST_PATH = path.join(DASHBOARD_ROOT, 'config', 'knowledgebase-manifest.json');

// Order matters — more specific rules first. The first matching rule wins.
const TOPIC_RULES = [
  { topic: 'Configuration Management',  match: /\b(config|configuration|drift|cm-?ai|aigp|control[- ]plane)\b/i },
  { topic: 'Compliance & Regulation',   match: /\b(nist|regulation|regulatory|2026|compliance|cis|benchmark|rmf|policy|eu[- ]ai[- ]act)\b/i },
  { topic: 'AI Readiness',              match: /\b(readiness|5-signs|five-signs|assessment|catch-up|roadmap)\b/i },
  { topic: 'Advisory & Practice',       match: /\b(fractional|advisor|certified|architect|claude-certified|practice)\b/i },
  { topic: 'Data & Analytics',          match: /\b(spreadsheets?|dashboards?|silos?|behind-on-data|analytics|reporting)\b/i },
  { topic: 'AI Agent Governance',       match: /\b(agent|agentic|governance|kri|observability|microsoft|toolkit)\b/i },
  { topic: 'Architecture & Platform',   match: /\b(architecture|3-layer|control-plane|inside-the-prism|platform|engine)\b/i },
];
const DEFAULT_TOPIC = 'General';

function inferTopic(...candidates) {
  const haystack = candidates.filter(Boolean).join(' ').toLowerCase();
  for (const rule of TOPIC_RULES) {
    if (rule.match.test(haystack)) return rule.topic;
  }
  return DEFAULT_TOPIC;
}

function parseFrontmatter(raw) {
  if (!raw.startsWith('---')) return { fm: {}, body: raw };
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return { fm: {}, body: raw };
  const fmBlock = raw.slice(3, end).trim();
  const body = raw.slice(end + 4).replace(/^\n/, '');
  const fm = {};
  for (const line of fmBlock.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    fm[m[1]] = value;
  }
  return { fm, body };
}

function extractMeta(html) {
  const meta = {};
  const title = html.match(/<title>([^<]+)<\/title>/i);
  if (title) meta.title = decodeHtml(title[1].replace(/\s*\|\s*Prism AI Analytics.*$/, '').trim());
  const desc = html.match(/<meta\s+name="description"\s+content="([^"]+)"/i);
  if (desc) meta.description = decodeHtml(desc[1]);
  const ogDesc = html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i);
  if (ogDesc && !meta.description) meta.description = decodeHtml(ogDesc[1]);
  const ogType = html.match(/<meta\s+property="og:type"\s+content="([^"]+)"/i);
  if (ogType) meta.og_type = ogType[1];
  return meta;
}

function decodeHtml(str) {
  return str
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&rsquo;/g, '’')
    .replace(/&lsquo;/g, '‘')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'");
}

function scanBlogPosts() {
  const items = [];
  const blogDir = path.join(WEBSITE_ROOT, 'blog');
  if (!fs.existsSync(blogDir)) return items;

  const sourcesDir = path.join(WEBSITE_ROOT, 'blog-sources');
  const sources = {};
  if (fs.existsSync(sourcesDir)) {
    for (const file of fs.readdirSync(sourcesDir)) {
      if (!file.endsWith('.md')) continue;
      const slug = file.replace(/\.md$/, '');
      const raw = fs.readFileSync(path.join(sourcesDir, file), 'utf8');
      const { fm } = parseFrontmatter(raw);
      sources[slug] = fm;
    }
  }

  for (const entry of fs.readdirSync(blogDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const slug = entry.name;
    const htmlPath = path.join(blogDir, slug, 'index.html');
    if (!fs.existsSync(htmlPath)) continue;
    const html = fs.readFileSync(htmlPath, 'utf8');
    const meta = extractMeta(html);
    const fm = sources[slug] || {};
    const title = fm.title || meta.title || slug;
    const description = meta.description || '';
    const topic = inferTopic(fm.category, fm.series, slug, title, description);
    items.push({
      id: `blog/${slug}`,
      slug,
      title,
      url: `/blog/${slug}/`,
      content_type: 'blog',
      topic,
      category: fm.category || null,
      series: fm.series || null,
      series_part: fm.series_part || null,
      date: fm.date || null,
      read_time: fm.read_time || null,
      author: fm.author || null,
      description,
    });
  }
  return items;
}

function scanWebsitePages() {
  const items = [];
  const pages = [
    { rel: 'services', title: 'Services', content_type: 'service-page', topic: 'Advisory & Practice' },
    { rel: 'ai-readiness', title: 'AI Readiness Assessment', content_type: 'assessment', topic: 'AI Readiness' },
    { rel: 'podcast', title: 'Podcast', content_type: 'podcast-index', topic: 'General' },
    { rel: 'about', title: 'About Prism AI', content_type: 'page', topic: 'General' },
  ];
  for (const p of pages) {
    const dir = path.join(WEBSITE_ROOT, p.rel);
    if (!fs.existsSync(dir)) continue;
    items.push({
      id: `site/${p.rel}`,
      slug: p.rel,
      title: p.title,
      url: `/${p.rel}/`,
      content_type: p.content_type,
      topic: p.topic,
      description: '',
    });
  }
  return items;
}

function scanDownloads() {
  const items = [];
  const dir = path.join(WEBSITE_ROOT, 'downloads');
  if (!fs.existsSync(dir)) return items;
  for (const file of fs.readdirSync(dir)) {
    if (file === 'desktop.ini' || file.startsWith('.')) continue;
    const lower = file.toLowerCase();
    if (!/\.(pdf|docx|xlsx|zip)$/.test(lower)) continue;
    const title = file.replace(/\.(pdf|docx|xlsx|zip)$/i, '').replace(/[-_]/g, ' ');
    items.push({
      id: `download/${file}`,
      slug: file,
      title,
      url: `/downloads/${file}`,
      content_type: 'download',
      topic: inferTopic(file, title),
      description: '',
    });
  }
  return items;
}

function scanDashboardInfographics() {
  const items = [];
  const publicDir = path.join(DASHBOARD_ROOT, 'public');
  if (!fs.existsSync(publicDir)) return items;
  for (const file of fs.readdirSync(publicDir)) {
    if (!/^prism-.+\.html$/.test(file)) continue;
    const slug = file.replace(/\.html$/, '');
    const html = fs.readFileSync(path.join(publicDir, file), 'utf8');
    const meta = extractMeta(html);
    const title = (meta.title || slug).replace(/^PRISM AI\s*[—-]\s*/, '');
    items.push({
      id: `dashboard/${slug}`,
      slug,
      title,
      url: `/${slug}.html`,
      content_type: 'infographic',
      topic: inferTopic(slug, title),
      description: '',
    });
  }
  return items;
}

// Central drop folder — Michele dumps any new artifact here and it gets indexed.
// Folder is served at /knowledgebase/<file> by express.static. Walks recursively
// so she can use optional subfolders for organization.
function scanCentralDropFolder() {
  const items = [];
  const dropDir = path.join(DASHBOARD_ROOT, 'public', 'knowledgebase');
  if (!fs.existsSync(dropDir)) return items;

  const walk = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name.toLowerCase() === 'desktop.ini' || entry.name.toLowerCase() === 'readme.md') continue;
      const abs = path.join(dir, entry.name);
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { walk(abs, next); continue; }
      const ext = path.extname(entry.name).toLowerCase();
      const base = entry.name.slice(0, entry.name.length - ext.length);

      let contentType = null;
      let title = base.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
      let description = '';
      let fm = {};

      if (ext === '.md') {
        contentType = 'article';
        const raw = fs.readFileSync(abs, 'utf8');
        const parsed = parseFrontmatter(raw);
        fm = parsed.fm;
        if (fm.title) title = fm.title;
        if (fm.description) description = fm.description;
      } else if (ext === '.html') {
        contentType = 'infographic';
        const html = fs.readFileSync(abs, 'utf8');
        const meta = extractMeta(html);
        if (meta.title) title = meta.title.replace(/^PRISM AI\s*[—-]\s*/, '');
        if (meta.description) description = meta.description;
      } else if (/^\.(pdf|docx|xlsx|zip|pptx)$/.test(ext)) {
        contentType = 'download';
      } else if (/^\.(png|jpe?g|svg|gif|webp|avif)$/.test(ext)) {
        contentType = 'image';
      } else {
        continue;
      }

      items.push({
        id: `kb/${next}`,
        slug: next,
        title,
        url: `/knowledgebase/${next}`,
        content_type: contentType,
        topic: inferTopic(fm.category, fm.series, next, title, description),
        category: fm.category || null,
        series: fm.series || null,
        series_part: fm.series_part || null,
        date: fm.date || null,
        read_time: fm.read_time || null,
        author: fm.author || null,
        description,
      });
    }
  };
  walk(dropDir, '');
  return items;
}

function buildManifest() {
  const items = [
    ...scanBlogPosts(),
    ...scanWebsitePages(),
    ...scanDownloads(),
    ...scanDashboardInfographics(),
    ...scanCentralDropFolder(),
  ];

  const byTopic = new Map();
  const byContentType = new Map();
  for (const item of items) {
    if (!byTopic.has(item.topic)) byTopic.set(item.topic, []);
    byTopic.get(item.topic).push(item);
    byContentType.set(item.content_type, (byContentType.get(item.content_type) || 0) + 1);
  }

  const topics = [...byTopic.entries()]
    .map(([topic, topicItems]) => ({
      topic,
      count: topicItems.length,
      items: topicItems.sort((a, b) => {
        const da = a.date || '';
        const db = b.date || '';
        if (da !== db) return db.localeCompare(da);
        return a.title.localeCompare(b.title);
      }),
    }))
    .sort((a, b) => b.count - a.count || a.topic.localeCompare(b.topic));

  return {
    generated_at: new Date().toISOString(),
    website_root: WEBSITE_ROOT,
    counts: {
      total: items.length,
      by_topic: Object.fromEntries([...byTopic.entries()].map(([k, v]) => [k, v.length])),
      by_content_type: Object.fromEntries(byContentType),
    },
    topics,
  };
}

function main() {
  if (!fs.existsSync(WEBSITE_ROOT)) {
    console.error(`[knowledgebase] website root not found: ${WEBSITE_ROOT}`);
    console.error('Set PRISM_WEBSITE_ROOT to override.');
    process.exit(1);
  }
  const manifest = buildManifest();
  fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log(`[knowledgebase] wrote ${manifest.counts.total} items across ${manifest.topics.length} topics → ${path.relative(DASHBOARD_ROOT, MANIFEST_PATH)}`);
  for (const t of manifest.topics) {
    console.log(`  ${t.count.toString().padStart(3)} · ${t.topic}`);
  }
}

if (require.main === module) main();

module.exports = { buildManifest, inferTopic };
