import Anthropic from '@anthropic-ai/sdk';
import initSqlJs from 'sql.js';
import { readFileSync } from 'fs';
import { join } from 'path';

// ─── Anthropic client (lazy init) ──────────────────────────────────────────
let anthropic = null;
function getAnthropic() {
  if (!anthropic && process.env.ANTHROPIC_API_KEY) {
    anthropic = new Anthropic();
  }
  return anthropic;
}

// ─── SQLite via sql.js (WASM, no native deps) ─────────────────────────────
let db = null;
async function getDB() {
  if (db) return db;
  if (db === false) return null; // previously failed, don't retry
  try {
    // Locate the WASM file from sql.js package
    const wasmPaths = [
      join('/var/task', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
      join(process.cwd(), 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
    ];
    let wasmBinary = null;
    for (const p of wasmPaths) {
      try { wasmBinary = readFileSync(p); break; } catch (_) {}
    }

    const SQL = await initSqlJs(wasmBinary ? { wasmBinary } : undefined);

    // Try bundled DB file
    const dbPaths = [
      join(process.cwd(), 'prism.db'),
      join('/var/task', 'prism.db'),
      join('/var/task', 'netlify', 'functions', 'prism.db'),
    ];
    for (const p of dbPaths) {
      try {
        const buf = readFileSync(p);
        db = new SQL.Database(buf);
        console.log('[Chat Function] Loaded DB from', p);
        return db;
      } catch (_) { /* try next */ }
    }
    console.warn('[Chat Function] No prism.db found — chat will work without CIS context');
  } catch (e) {
    console.warn('[Chat Function] sql.js init failed:', e.message);
    db = false; // mark as failed
  }
  return null;
}

// ─── System prompt ─────────────────────────────────────────────────────────
const CIS_SYSTEM_PROMPT = `You are PRISMA — Prism Risk Intelligence & Security Management Advisor.
You are an AI compliance analyst for Prism AI Analytics.
Answer questions about security benchmarks using ONLY the provided context from CIS Benchmark rules.
Always cite the CIS UID (e.g. CIS-2026-00012.045) and Rule ID in your answers so users can look them up in the dashboard.
When listing rules, format each as: **[CIS UID]** Rule X.X: Title
If the context doesn't contain relevant information, say so clearly.
Be precise and actionable in your recommendations.
Format your responses with clear headings and bullet points for readability.
When product details are provided, use them to answer questions about versions, vendors, drift detection, automation capabilities, and coverage.
Keep answers concise but thorough.`;

// ─── Search helpers (mirror server.js logic) ───────────────────────────────
const STOPWORDS = new Set(['the','a','an','is','are','for','to','in','on','of','and','or','what','how','which','that','this','with','can','do','does','should','would','about','from','key','rules','ensure']);

function searchProducts(database, query) {
  const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
  if (terms.length === 0) return [];
  try {
    const conditions = terms.map(() => `LOWER(bp.product_name) LIKE ?`).join(' OR ');
    const params = terms.map(t => `%${t}%`);
    const stmt = database.prepare(`
      SELECT bp.*,
        (SELECT COUNT(*) FROM benchmark_rules br WHERE br.product_id = bp.id AND br.rule_type = 'rule' AND (br.benchmark_status = 'active' OR br.benchmark_status IS NULL)) as active_rule_count
      FROM benchmark_products bp
      WHERE bp.is_active = 1 AND (${conditions})
      LIMIT 5
    `);
    stmt.bind(params);
    const results = [];
    while (stmt.step()) results.push(stmt.getAsObject());
    stmt.free();
    return results;
  } catch (e) { return []; }
}

function searchRules(database, query, limit = 12) {
  const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2 && !STOPWORDS.has(t));
  if (terms.length === 0) return [];

  const conditions = terms.map(() =>
    `(LOWER(br.title) LIKE ? OR LOWER(br.description) LIKE ? OR LOWER(br.remediation) LIKE ? OR LOWER(br.rule_id) LIKE ?)`
  );
  const matchScores = terms.map(() =>
    `(CASE WHEN LOWER(br.title) LIKE ? THEN 3 ELSE 0 END + CASE WHEN LOWER(br.description) LIKE ? THEN 1 ELSE 0 END + CASE WHEN LOWER(br.remediation) LIKE ? THEN 1 ELSE 0 END)`
  );

  const params = [];
  for (const t of terms) {
    const like = `%${t}%`;
    params.push(like, like, like, like);
  }
  const scoreParams = [];
  for (const t of terms) {
    const like = `%${t}%`;
    scoreParams.push(like, like, like);
  }

  const sql = `
    SELECT br.rule_id, br.cis_uid, br.title, br.description, br.rationale, br.remediation,
           br.cis_profile, br.check_type, br.benchmark_version, br.benchmark_status,
           br.product_id, bp.product_name, bp.vendor, bp.category,
           (${matchScores.join(' + ')}) as relevance
    FROM benchmark_rules br
    JOIN benchmark_products bp ON br.product_id = bp.id
    WHERE br.rule_type = 'rule' AND (${conditions.join(' OR ')})
    ORDER BY relevance DESC
    LIMIT ?
  `;

  try {
    const stmt = database.prepare(sql);
    stmt.bind([...params, ...scoreParams, limit]);
    const results = [];
    while (stmt.step()) results.push(stmt.getAsObject());
    stmt.free();
    return results;
  } catch (e) {
    console.error('[Chat Search Error]', e.message);
    return [];
  }
}

function buildContext(rules) {
  if (rules.length === 0) return 'No relevant CIS Benchmark rules were found for this query.';
  return rules.map(r => {
    let ctx = `--- [${r.product_name}] CIS UID: ${r.cis_uid || 'N/A'} | Rule ${r.rule_id}: ${r.title} (${r.cis_profile}, ${r.check_type}, v${r.benchmark_version || '?'})`;
    if (r.description) ctx += `\nDescription: ${String(r.description).substring(0, 600)}`;
    if (r.rationale) ctx += `\nRationale: ${String(r.rationale).substring(0, 400)}`;
    if (r.remediation) ctx += `\nRemediation: ${String(r.remediation).substring(0, 400)}`;
    return ctx;
  }).join('\n\n');
}

function buildProductContext(products) {
  if (products.length === 0) return '';
  return '\n\n=== PRODUCT DETAILS FROM DASHBOARD ===\n' + products.map(p =>
    `Product: ${p.product_name} | Vendor: ${p.vendor} | Version: ${p.version || 'N/A'} | Category: ${p.category}/${p.subcategory || ''}\n` +
    `CIS Benchmark: ${p.cis_benchmark} (${p.cis_benchmark_version || 'N/A'}) | DISA STIG: ${p.disa_stig} (${p.disa_stig_id || 'N/A'})\n` +
    `Discovery: ${p.discovery_method || 'N/A'} | Drift Detection: ${p.drift_detection_capability} — ${p.drift_detection_details || 'N/A'}\n` +
    `Automation: ${p.automation_ceiling} | Architecture: ${p.architecture_type || 'N/A'} | Service Approach: ${p.service_approach || 'N/A'}\n` +
    `Active Rules: ${p.active_rule_count} | Frameworks: ${p.applicable_frameworks || 'N/A'}\n` +
    `Notes: ${p.notes || 'N/A'}`
  ).join('\n\n');
}

// ─── Netlify Function handler ──────────────────────────────────────────────
export async function handler(event) {
  // CORS headers
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  // Handle preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ ok: false, error: 'Method not allowed' }) };
  }

  // Check Anthropic key
  const client = getAnthropic();
  if (!client) {
    return { statusCode: 503, headers, body: JSON.stringify({ ok: false, error: 'ANTHROPIC_API_KEY not set. Set it as an environment variable to enable AI chat.' }) };
  }

  // Parse body
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (_) {
    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Invalid JSON' }) };
  }

  const { message, history } = body;
  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Message is required' }) };
  }

  try {
    // Search CIS knowledge base if DB is available
    const database = await getDB();
    let rules = [];
    let products = [];
    if (database) {
      rules = searchRules(database, message.trim(), 12);
      products = searchProducts(database, message.trim());
    }
    const context = buildContext(rules) + buildProductContext(products);

    // Build messages with history
    const messages = [];
    if (Array.isArray(history)) {
      for (const h of history.slice(-10)) {
        if (h.role === 'user' || h.role === 'assistant') {
          messages.push({ role: h.role, content: h.content });
        }
      }
    }
    messages.push({
      role: 'user',
      content: `Context from CIS Benchmark knowledge base (${rules.length} rules found):\n\n${context}\n\n---\nUser question: ${message.trim()}`
    });

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      system: CIS_SYSTEM_PROMPT,
      messages
    });

    const answer = response.content[0].text;
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, answer, rulesFound: rules.length })
    };
  } catch (e) {
    console.error('[Chat Error]', e.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ ok: false, error: 'AI chat error: ' + e.message })
    };
  }
}
