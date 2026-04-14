// ─────────────────────────────────────────────────────────────────────────────
// PRISM AI Analytics — Admin Dashboard API (v2.0 — Hardened)
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { body, param, validationResult } = require('express-validator');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const stripeService = require('./services/stripeService');
const qboService = require('./services/quickbooksService');
const cacheService = require('./services/cacheService');
const os = require('os');
const CLAUDE_USAGE_PATH = process.env.CLAUDE_USAGE_PATH || path.join(os.homedir(), '.claude', 'usage-data');

// Load .env file (lightweight, no dependency)
try {
  const envFile = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  for (const line of envFile.split('\n')) {
    const trimmed = line.replace(/\r$/, '');
    const m = trimmed.match(/^\s*([^#=]+?)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) {
      // Strip surrounding quotes from value
      let val = m[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      process.env[m[1]] = val;
    }
  }
} catch (e) {
  if (e.code !== 'ENOENT') console.warn('[.env] Failed to load:', e.message);
}

const app = express();
const PORT = process.env.PORT || 3000;
const APP_ENV = process.env.APP_ENV || 'production';

// ─── Security middleware ────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc:   ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc:    ["'self'", "https://fonts.gstatic.com"],
      scriptSrc:  ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
      connectSrc: ["'self'", "https://cdnjs.cloudflare.com"],
      imgSrc:     ["'self'", "data:"],
      scriptSrcAttr: ["'unsafe-inline'"],
    }
  }
}));

app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',   // lock down in production
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,   // 15 minutes
  max: 200,                    // 200 requests per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many requests — try again later.' },
});
app.use(limiter);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '1mb' }));

// ─── Bearer-token auth middleware ───────────────────────────────────────────
const API_KEY = process.env.API_KEY || '';

function requireAuth(req, res, next) {
  // Local dev: skip if no API_KEY and no users
  if (!API_KEY) { try { if (db.prepare('SELECT COUNT(*) as n FROM users').get().n === 0) return next(); } catch(e) { return next(); } }

  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ ok: false, error: 'Missing or invalid Authorization header' });
  }
  const token = header.slice(7);
  if (API_KEY && token === API_KEY) return next();
  try {
    const session = db.prepare("SELECT s.*, u.id as uid, u.username, u.role, u.team_member_id FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.token = ? AND s.expires_at > datetime('now')").get(token);
    if (session) { req.user = { id: session.uid, username: session.username, role: session.role, team_member_id: session.team_member_id }; return next(); }
  } catch(e) {}
  return res.status(403).json({ ok: false, error: 'Invalid or expired token' });
}

// ─── Auth endpoints (public) ──────────────────────────────────────────────
app.post('/api/auth/login', express.json(), (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ ok: false, error: 'Username and password required' });
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.toLowerCase().trim());
    if (!user) return res.status(401).json({ ok: false, error: 'Invalid credentials' });
    const hash = hashPassword(password, user.salt);
    if (hash !== user.password_hash) return res.status(401).json({ ok: false, error: 'Invalid credentials' });
    db.prepare("DELETE FROM sessions WHERE user_id = ? OR expires_at < datetime('now')").run(user.id);
    const session = createSession(user.id);
    const member = user.team_member_id ? db.prepare('SELECT first_name, last_name FROM team_members WHERE id = ?').get(user.team_member_id) : null;
    res.json({ ok: true, token: session.token, expires_at: session.expires_at,
      user: { id: user.id, username: user.username, role: user.role, team_member_id: user.team_member_id,
              name: member ? member.first_name + ' ' + member.last_name : user.username } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/auth/logout', (req, res) => {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    try { db.prepare('DELETE FROM sessions WHERE token = ?').run(header.slice(7)); } catch(e) {}
  }
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return res.status(401).json({ ok: false });
  const token = header.slice(7);
  if (API_KEY && token === API_KEY) return res.json({ ok: true, user: { username: 'admin', role: 'admin', name: 'API Admin' } });
  try {
    const session = db.prepare("SELECT s.*, u.id as uid, u.username, u.role, u.team_member_id FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.token = ? AND s.expires_at > datetime('now')").get(token);
    if (!session) return res.status(401).json({ ok: false });
    const member = session.team_member_id ? db.prepare('SELECT first_name, last_name FROM team_members WHERE id = ?').get(session.team_member_id) : null;
    res.json({ ok: true, user: { id: session.uid, username: session.username, role: session.role,
      team_member_id: session.team_member_id, name: member ? member.first_name + ' ' + member.last_name : session.username } });
  } catch(e) { res.status(401).json({ ok: false }); }
});

app.post('/api/auth/change-password', express.json(), (req, res) => {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) return res.status(401).json({ ok: false });
    const token = header.slice(7);
    const session = db.prepare("SELECT s.*, u.id as uid FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.token = ? AND s.expires_at > datetime('now')").get(token);
    if (!session) return res.status(401).json({ ok: false });
    const { current_password, new_password } = req.body || {};
    if (!current_password || !new_password) return res.status(400).json({ ok: false, error: 'Both passwords required' });
    if (new_password.length < 8) return res.status(400).json({ ok: false, error: 'Min 8 characters' });
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(session.uid);
    if (hashPassword(current_password, user.salt) !== user.password_hash) return res.status(401).json({ ok: false, error: 'Current password incorrect' });
    const newSalt = crypto.randomBytes(16).toString('hex');
    db.prepare('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?').run(hashPassword(new_password, newSalt), newSalt, user.id);
    res.json({ ok: true, message: 'Password updated' });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});
// POST — admin: reset training tickets to current Anthropic curriculum.
// Protected by X-Admin-Key header matching process.env.ADMIN_KEY.
// Registered BEFORE requireAuth so it uses its own auth mechanism (destructive op).
app.post('/api/admin/reset-training-tickets', express.json(), (req, res) => {
  try {
    const adminKey = process.env.ADMIN_KEY;
    if (!adminKey) {
      return res.status(503).json({ ok: false, error: 'ADMIN_KEY not configured on server' });
    }
    const provided = req.header('X-Admin-Key');
    if (!provided || provided !== adminKey) {
      return res.status(401).json({ ok: false, error: 'Invalid or missing X-Admin-Key header' });
    }
    const { resetTrainingTickets } = require('./scripts/training-curriculum');
    const result = resetTrainingTickets(db);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Apply auth to all /api/* routes
app.use('/api', requireAuth);

// ─── Validation helper ──────────────────────────────────────────────────────
function handleValidation(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ ok: false, errors: errors.array() });
  }
  next();
}

// ─── Health check (no auth required — useful for uptime monitors) ───────────
app.get('/health', (req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.json({ status: 'healthy', uptime: process.uptime(), timestamp: new Date().toISOString() });
  } catch (e) {
    res.status(503).json({ status: 'unhealthy', error: e.message });
  }
});

// ─── SQLite setup (mirrors PostgreSQL schema) ───────────────────────────────
// In production (Railway), use the mounted volume so data persists across deploys.
// Locally, use the project directory.
// Railway mounts volumes AFTER the container starts, so we must wait for the
// volume to become writable before opening the database.
function isVolumeReady(dir) {
  // Check if the directory is actually writable (volume mounted), not just existing
  // (the Dockerfile creates /app/data but it's read-only until the volume mounts)
  try {
    const testFile = path.join(dir, '.write-test');
    fs.writeFileSync(testFile, 'ok');
    fs.unlinkSync(testFile);
    return true;
  } catch {
    return false;
  }
}

function waitForVolume(dir, retries = 15, delay = 2000) {
  for (let i = 0; i < retries; i++) {
    if (isVolumeReady(dir)) {
      console.log(`Volume ${dir} is ready (attempt ${i + 1})`);
      return true;
    }
    console.log(`Waiting for volume ${dir} (attempt ${i + 1}/${retries})...`);
    const waitUntil = Date.now() + delay;
    while (Date.now() < waitUntil) { /* sync wait */ }
  }
  return false;
}

function getDBPath() {
  if (process.env.NODE_ENV === 'production') {
    const volumeDir = '/app/data';
    if (waitForVolume(volumeDir)) {
      return path.join(volumeDir, 'prism.db');
    }
    console.warn('Volume not available — falling back to local directory');
  }
  return path.join(__dirname, 'prism.db');
}

const DB_PATH = getDBPath();
console.log(`Opening database at: ${DB_PATH}`);
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function initDB() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS industries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL
    );
    CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY,
      company_name TEXT NOT NULL,
      industry_id INTEGER REFERENCES industries(id),
      company_size TEXT,
      website TEXT, city TEXT, state TEXT, country TEXT DEFAULT 'US',
      notes TEXT, is_active INTEGER NOT NULL DEFAULT 1,
      acquired_date TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
      crm_status TEXT DEFAULT 'New Lead',
      crm_budget REAL,
      crm_project_name TEXT,
      crm_service TEXT,
      crm_lead_source TEXT,
      crm_contact_name TEXT,
      crm_contact_email TEXT,
      crm_contact_phone TEXT,
      crm_last_status_change TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY,
      client_id TEXT REFERENCES clients(id),
      first_name TEXT NOT NULL, last_name TEXT NOT NULL,
      email TEXT, phone TEXT, job_title TEXT,
      is_primary INTEGER NOT NULL DEFAULT 0,
      notes TEXT, created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS lead_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL, channel TEXT
    );
    CREATE TABLE IF NOT EXISTS leads (
      id TEXT PRIMARY KEY,
      contact_id TEXT REFERENCES contacts(id),
      client_id TEXT REFERENCES clients(id),
      lead_source_id INTEGER REFERENCES lead_sources(id),
      status TEXT NOT NULL DEFAULT 'new',
      estimated_value REAL, notes TEXT,
      discovery_date TEXT, close_date TEXT, lost_reason TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS services (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, service_type TEXT NOT NULL,
      description TEXT, price_min REAL, price_max REAL, price_unit TEXT,
      is_active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS team_members (
      id TEXT PRIMARY KEY,
      first_name TEXT NOT NULL, last_name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL, phone TEXT,
      role TEXT NOT NULL DEFAULT 'contractor',
      title TEXT, hourly_rate REAL,
      status TEXT NOT NULL DEFAULT 'active',
      start_date TEXT, created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL REFERENCES clients(id),
      service_id INTEGER REFERENCES services(id),
      assigned_to TEXT REFERENCES team_members(id),
      name TEXT NOT NULL, description TEXT,
      status TEXT NOT NULL DEFAULT 'scoping',
      budget REAL, start_date TEXT, target_end_date TEXT, actual_end_date TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS milestones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES projects(id),
      name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      due_date TEXT, completed_date TEXT, sort_order INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS retainers (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL REFERENCES clients(id),
      service_id INTEGER REFERENCES services(id),
      monthly_rate REAL NOT NULL, hours_included REAL,
      status TEXT NOT NULL DEFAULT 'active',
      start_date TEXT NOT NULL, end_date TEXT
    );
    CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY,
      invoice_number TEXT UNIQUE NOT NULL,
      client_id TEXT NOT NULL REFERENCES clients(id),
      project_id TEXT REFERENCES projects(id),
      retainer_id TEXT REFERENCES retainers(id),
      status TEXT NOT NULL DEFAULT 'draft',
      issue_date TEXT NOT NULL, due_date TEXT NOT NULL,
      subtotal REAL NOT NULL DEFAULT 0, tax_rate REAL DEFAULT 0,
      tax_amount REAL DEFAULT 0, total REAL NOT NULL DEFAULT 0,
      notes TEXT
    );
    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      invoice_id TEXT NOT NULL REFERENCES invoices(id),
      amount REAL NOT NULL, payment_date TEXT NOT NULL,
      payment_method TEXT, reference_number TEXT
    );
    CREATE TABLE IF NOT EXISTS expenses (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL, vendor TEXT,
      description TEXT NOT NULL, amount REAL NOT NULL,
      expense_date TEXT NOT NULL, is_recurring INTEGER DEFAULT 0,
      recurrence_freq TEXT, project_id TEXT REFERENCES projects(id)
    );
    CREATE TABLE IF NOT EXISTS time_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_member_id TEXT NOT NULL REFERENCES team_members(id),
      project_id TEXT REFERENCES projects(id),
      retainer_id TEXT REFERENCES retainers(id),
      client_id TEXT NOT NULL REFERENCES clients(id),
      entry_date TEXT NOT NULL, hours REAL NOT NULL,
      description TEXT, is_billable INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
      team_member_id TEXT REFERENCES team_members(id),
      action TEXT NOT NULL, summary TEXT,
      logged_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS referral_partners (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL, company TEXT, email TEXT,
      specialty TEXT, fee_percentage REAL DEFAULT 10.0,
      is_active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS referrals (
      id TEXT PRIMARY KEY,
      referral_type TEXT NOT NULL,
      referring_client_id TEXT REFERENCES clients(id),
      partner_id TEXT REFERENCES referral_partners(id),
      lead_id TEXT REFERENCES leads(id),
      fee_amount REAL, fee_paid INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS ai_readiness_assessments (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL REFERENCES clients(id),
      project_id TEXT REFERENCES projects(id),
      assessed_by TEXT REFERENCES team_members(id),
      assessment_date TEXT NOT NULL,
      data_quality INTEGER, data_accessibility INTEGER,
      process_documentation INTEGER, technology_stack INTEGER,
      team_ai_readiness INTEGER, leadership_commitment INTEGER,
      summary TEXT, recommendations TEXT
    );
    CREATE TABLE IF NOT EXISTS certifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_member_id TEXT NOT NULL REFERENCES team_members(id),
      name TEXT NOT NULL, provider TEXT,
      status TEXT NOT NULL DEFAULT 'planned',
      start_date TEXT, completion_date TEXT, expiry_date TEXT
    );
    CREATE TABLE IF NOT EXISTS training_programs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      provider TEXT,
      description TEXT,
      total_domains INTEGER DEFAULT 0,
      total_topics INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS training_domains (
      id TEXT PRIMARY KEY,
      program_id TEXT NOT NULL REFERENCES training_programs(id),
      name TEXT NOT NULL,
      weight INTEGER DEFAULT 0,
      sort_order INTEGER DEFAULT 0,
      color TEXT
    );
    CREATE TABLE IF NOT EXISTS training_topics (
      id TEXT PRIMARY KEY,
      domain_id TEXT NOT NULL REFERENCES training_domains(id),
      name TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS training_progress (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_member_id TEXT NOT NULL REFERENCES team_members(id),
      topic_id TEXT NOT NULL REFERENCES training_topics(id),
      completed INTEGER NOT NULL DEFAULT 0,
      completed_at TEXT,
      UNIQUE(team_member_id, topic_id)
    );
    CREATE TABLE IF NOT EXISTS training_notes (
      id TEXT PRIMARY KEY,
      team_member_id TEXT NOT NULL REFERENCES team_members(id),
      program_id TEXT NOT NULL REFERENCES training_programs(id),
      domain_tag TEXT NOT NULL DEFAULT 'general',
      note TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS daily_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      review_date TEXT NOT NULL UNIQUE,
      sprint_day INTEGER,
      sprint_week INTEGER,
      clients_revenue TEXT,
      sprint_progress TEXT,
      development TEXT,
      training TEXT,
      services_pricing TEXT,
      marketing TEXT,
      infrastructure TEXT,
      other_milestones TEXT,
      reminders TEXT,
      summary TEXT,
      sources_reviewed TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      category TEXT NOT NULL DEFAULT 'brand',
      visibility TEXT NOT NULL DEFAULT 'internal',
      doc_type TEXT NOT NULL DEFAULT 'Word Doc',
      drive_url TEXT,
      tags TEXT,
      linked_date TEXT,
      review_section TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
  // Migration: add review_section column if missing
  try {
    db.exec(`ALTER TABLE documents ADD COLUMN review_section TEXT`);
  } catch (e) {
    // Column already exists — ignore
  }
  // Auth tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      ticket_type TEXT NOT NULL DEFAULT 'internal',
      category TEXT DEFAULT 'general',
      status TEXT NOT NULL DEFAULT 'backlog',
      priority TEXT NOT NULL DEFAULT 'medium',
      assigned_to TEXT REFERENCES team_members(id),
      client_id TEXT REFERENCES clients(id),
      project_id TEXT REFERENCES projects(id),
      due_date TEXT,
      completed_date TEXT,
      created_by TEXT,
      tags TEXT,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ticket_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id TEXT NOT NULL REFERENCES tickets(id),
      author TEXT,
      comment TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      team_member_id TEXT REFERENCES team_members(id),
      role TEXT NOT NULL DEFAULT 'member',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      created_at TEXT DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS benchmark_products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_name TEXT NOT NULL,
      vendor TEXT NOT NULL,
      version TEXT,
      category TEXT NOT NULL,
      subcategory TEXT,
      cis_benchmark TEXT NOT NULL DEFAULT 'no',
      cis_benchmark_version TEXT,
      disa_stig TEXT NOT NULL DEFAULT 'no',
      disa_stig_id TEXT,
      discovery_method TEXT,
      drift_detection_capability TEXT NOT NULL DEFAULT 'none',
      drift_detection_details TEXT,
      external_tools_needed TEXT,
      architecture_type TEXT,
      automation_ceiling TEXT NOT NULL DEFAULT 'partial',
      service_approach TEXT,
      applicable_frameworks TEXT,
      notes TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS benchmark_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL REFERENCES benchmark_products(id),
      rule_id TEXT,
      title TEXT NOT NULL,
      section TEXT,
      subsection TEXT,
      level INTEGER DEFAULT 0,
      rule_type TEXT DEFAULT 'rule',
      source TEXT,
      severity TEXT,
      cis_profile TEXT,
      check_type TEXT,
      description TEXT,
      rationale TEXT,
      remediation TEXT,
      audit_command TEXT,
      default_value TEXT,
      recommended_value TEXT,
      config_parameter TEXT,
      config_location TEXT,
      benchmark_version TEXT,
      benchmark_status TEXT DEFAULT 'active',
      cis_uid TEXT,
      is_automatable INTEGER DEFAULT 1,
      is_active INTEGER DEFAULT 1,
      "references" TEXT,
      section_name TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- ─── Operational Inventory Tables ──────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS tools (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      suite TEXT,
      description TEXT,
      business_use TEXT,
      relevance TEXT,
      utilization TEXT,
      trigger_phrase TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS business_assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      folder TEXT NOT NULL,
      format TEXT,
      status TEXT,
      purpose TEXT,
      file_path TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS maturity_scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      area TEXT NOT NULL UNIQUE,
      score INTEGER NOT NULL,
      rating TEXT NOT NULL,
      analysis TEXT,
      assessed_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS action_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      priority INTEGER NOT NULL,
      urgency TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      tools_to_use TEXT,
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS dev_sessions (
      session_id TEXT PRIMARY KEY,
      project_path TEXT,
      start_time TEXT,
      duration_minutes INTEGER DEFAULT 0,
      user_message_count INTEGER DEFAULT 0,
      assistant_message_count INTEGER DEFAULT 0,
      tool_counts TEXT,
      tool_errors INTEGER DEFAULT 0,
      tool_error_categories TEXT,
      lines_added INTEGER DEFAULT 0,
      lines_removed INTEGER DEFAULT 0,
      files_modified INTEGER DEFAULT 0,
      git_commits INTEGER DEFAULT 0,
      languages TEXT,
      uses_mcp INTEGER DEFAULT 0,
      imported_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS dev_facets (
      session_id TEXT PRIMARY KEY REFERENCES dev_sessions(session_id),
      underlying_goal TEXT,
      goal_categories TEXT,
      outcome TEXT,
      friction_counts TEXT,
      friction_detail TEXT,
      primary_success TEXT,
      brief_summary TEXT,
      claude_helpfulness TEXT,
      session_type TEXT,
      imported_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS dev_insight_tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      insight_type TEXT NOT NULL,
      insight_key TEXT NOT NULL,
      ticket_id TEXT REFERENCES tickets(id),
      action_item_id INTEGER REFERENCES action_items(id),
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(session_id, insight_type, insight_key)
    );
  `);
}

function urgencyToPriority(urgency) {
  const map = { immediate: 'urgent', this_week: 'high', next_2_weeks: 'medium', this_month: 'medium', next_30_days: 'low', this_quarter: 'low' };
  return map[urgency] || 'medium';
}

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function seedIfEmpty() {
  const count = db.prepare('SELECT COUNT(*) as n FROM clients').get().n;
  if (count > 0) return;
  // Clean orphaned reference data to avoid UNIQUE conflicts on re-seed
  try { db.prepare('DELETE FROM industries').run(); } catch(e) {}
  try { db.prepare('DELETE FROM lead_sources').run(); } catch(e) {}
  try { db.prepare('DELETE FROM services').run(); } catch(e) {}

  // Industries
  const industries = ['Finance','Healthcare','Retail','Hospitality','Real Estate','Professional Services','Technology','Manufacturing','Education','Nonprofit'];
  const insInd = db.prepare('INSERT OR IGNORE INTO industries (name) VALUES (?)');
  industries.forEach(n => insInd.run(n));

  // Lead sources
  const sources = [['LinkedIn','social'],['Website/SEO','organic'],['Google Business Profile','organic'],['Email Newsletter','email'],['Charlotte Chamber','event'],['SBDC Partnership','referral'],['Speaking Engagement','event'],['Client Referral','referral'],['Partner Referral','referral'],['Cold Outreach','outbound']];
  const insLS = db.prepare('INSERT OR IGNORE INTO lead_sources (name, channel) VALUES (?, ?)');
  sources.forEach(s => insLS.run(...s));

  // Services
  const svcs = [
    ['AI Readiness Assessment','project',1500,3000,'fixed'],
    ['Analytics & Reporting Modernization','project',3000,8000,'fixed'],
    ['AI Workflow Automation','project',4000,12000,'fixed'],
    ['Fractional AI Advisor Retainer','retainer',1500,3000,'per_month'],
    ['Analytics Support Retainer','retainer',800,1500,'per_month'],
    ['AI Starter Kit for Small Business','productized',499,499,'fixed'],
    ['Data Health Audit','productized',750,1200,'fixed'],
    ['Lunch & Learn Workshop','workshop',500,800,'per_session'],
    // Compliance & Security Services
    ['CIS/STIG Coverage Gap Assessment','project',5000,15000,'fixed'],
    ['Drift Detection Blueprint','project',8000,20000,'fixed'],
    ['Remediation Automation Sprint','project',10000,30000,'fixed'],
    ['Compliance Data Hub','project',15000,40000,'fixed'],
    ['Managed Compliance Engineering','retainer',3000,8500,'per_month'],
    ['Audit Evidence Automation','project',5000,15000,'fixed'],
    ['AI Governance & Hardening Assessment','project',8000,20000,'fixed'],
  ];
  const insSvc = db.prepare('INSERT OR IGNORE INTO services (name, service_type, price_min, price_max, price_unit) VALUES (?,?,?,?,?)');
  svcs.forEach(s => insSvc.run(...s));

  // Founder — look up existing or create
  let mId = (db.prepare("SELECT id FROM team_members WHERE email = 'michele@prismaianalytics.com'").get() || {}).id;
  if (!mId) {
    mId = uuid();
    db.prepare('INSERT INTO team_members (id, first_name, last_name, email, role, title, hourly_rate, start_date) VALUES (?,?,?,?,?,?,?,?)')
      .run(mId, 'Michele', 'Fisher', 'michele@prismaianalytics.com', 'founder', 'Founder & AI Analytics Consultant', 135, '2026-03-01');
  }

  // Certifications
  const certCount = db.prepare('SELECT COUNT(*) as n FROM certifications WHERE team_member_id = ?').get(mId).n;
  if (certCount === 0) {
    const certs = [['Google AI Essentials','Google / Coursera','in_progress'],['PL-300: Power BI Data Analyst','Microsoft Learn','planned'],['AI for Everyone','Coursera / Andrew Ng','planned'],['AWS Certified AI Practitioner','AWS','planned'],['AI for Business Strategy','Wharton / Coursera','planned']];
    const insCert = db.prepare('INSERT INTO certifications (team_member_id, name, provider, status) VALUES (?,?,?,?)');
    certs.forEach(c => insCert.run(mId, ...c));
  }

  // Junior Engineer — look up existing or create
  let izId = (db.prepare("SELECT id FROM team_members WHERE email = 'izayah@prismaianalytics.com'").get() || {}).id;
  if (!izId) {
    izId = uuid();
    db.prepare('INSERT INTO team_members (id, first_name, last_name, email, role, title, hourly_rate, start_date) VALUES (?,?,?,?,?,?,?,?)')
      .run(izId, 'Izayah', 'Fisher', 'izayah@prismaianalytics.com', 'contractor', 'Junior AI/ML Engineer', 45, '2026-03-15');
  }

  // CCA Foundations Training Program — skip if already exists
  const existingProg = db.prepare("SELECT COUNT(*) as n FROM training_programs").get().n;
  if (existingProg > 0) return; // training data already exists, skip rest of seed

  const ccaId = uuid();
  db.prepare('INSERT INTO training_programs (id, name, provider, description, total_domains, total_topics) VALUES (?,?,?,?,?,?)')
    .run(ccaId, 'Claude Certified Architect — Foundations', 'Anthropic', 'Proctored 60-question architecture exam. 120 min. Pass: 720/1000.', 5, 35);

  const ccaDomains = [
    { name: 'Agentic architecture & orchestration', weight: 27, color: '#534AB7', topics: [
      'Agentic loop mechanics','Hub-and-spoke orchestration','Task decomposition patterns',
      'Hooks vs prompts decision framework','Session resumption & state management',
      'Multi-agent system design','Guardrails & safety in agents'] },
    { name: 'Tool design & MCP integration', weight: 18, color: '#1D9E75', topics: [
      'MCP server creation (Python)','MCP core primitives: tools, resources, prompts',
      'Tool interface design principles','Structured error responses (4 categories)',
      'Tool boundaries & reasoning overload','MCP advanced patterns & transport',
      'Grep vs Glob distinctions'] },
    { name: 'Claude Code configuration & workflows', weight: 20, color: '#D85A30', topics: [
      'CLAUDE.md hierarchy & structure','Path-specific rules with glob patterns',
      'Custom slash commands','Plan mode vs direct execution',
      'CI/CD integration (-p flag)','Skills creation & distribution',
      'Sub-agents in Claude Code'] },
    { name: 'Prompt engineering & structured output', weight: 20, color: '#378ADD', topics: [
      'Few-shot construction patterns','tool_use JSON schema design',
      'Required vs nullable field patterns','Validation-retry loops',
      'Batch vs synchronous decisions','Enforcing reliability via JSON schemas',
      'System prompt architecture'] },
    { name: 'Context management & reliability', weight: 15, color: '#888780', topics: [
      'Long-context preservation','Handoff patterns between agents',
      'Confidence calibration','Context window optimization',
      'Failure cascading prevention','Cost optimization strategies',
      'Governance & compliance patterns'] },
  ];

  const insDomain = db.prepare('INSERT INTO training_domains (id, program_id, name, weight, sort_order, color) VALUES (?,?,?,?,?,?)');
  const insTopic = db.prepare('INSERT INTO training_topics (id, domain_id, name, sort_order) VALUES (?,?,?,?)');

  ccaDomains.forEach((d, di) => {
    const domId = uuid();
    insDomain.run(domId, ccaId, d.name, d.weight, di + 1, d.color);
    d.topics.forEach((t, ti) => {
      insTopic.run(uuid(), domId, t, ti + 1);
    });
  });

  // Add CCA cert records for both Michele and Izayah
  insCert.run(mId, 'Claude Certified Architect — Foundations', 'Anthropic Academy / Skilljar', 'in_progress');
  insCert.run(izId, 'Claude Certified Architect — Foundations', 'Anthropic Academy / Skilljar', 'in_progress');

  // Clients
  const getInd = db.prepare('SELECT id FROM industries WHERE name = ?');
  const clientData = [
    { id: uuid(), name: 'Magnolia Financial Group', ind: 'Finance', size: '11-50', city: 'Charlotte', state: 'NC', acq: '2026-06-01' },
    { id: uuid(), name: 'QueenCity Dental Partners', ind: 'Healthcare', size: '51-200', city: 'Charlotte', state: 'NC', acq: '2026-06-15' },
    { id: uuid(), name: 'Barrel & Vine Hospitality', ind: 'Hospitality', size: '11-50', city: 'Charlotte', state: 'NC', acq: '2026-07-01' },
    { id: uuid(), name: 'Tryon Property Management', ind: 'Real Estate', size: '2-10', city: 'Charlotte', state: 'NC', acq: null },
    { id: uuid(), name: 'SouthEnd Accounting Co.', ind: 'Professional Services', size: '2-10', city: 'Charlotte', state: 'NC', acq: null },
  ];
  const insCli = db.prepare('INSERT INTO clients (id, company_name, industry_id, company_size, city, state, acquired_date, is_active) VALUES (?,?,?,?,?,?,?,1)');
  clientData.forEach(c => insCli.run(c.id, c.name, getInd.get(c.ind).id, c.size, c.city, c.state, c.acq));

  // Contacts
  const contactData = [
    { cid: clientData[0].id, fn: 'James', ln: 'Harwell', email: 'jharwell@magnoliafinancial.com', title: 'Managing Director', primary: 1 },
    { cid: clientData[0].id, fn: 'Diana', ln: 'Chu', email: 'dchu@magnoliafinancial.com', title: 'Operations Manager', primary: 0 },
    { cid: clientData[1].id, fn: 'Dr. Priya', ln: 'Nair', email: 'pnair@queencitydental.com', title: 'Practice Owner', primary: 1 },
    { cid: clientData[2].id, fn: 'Marcus', ln: 'Delgado', email: 'marcus@barrelandvine.com', title: 'Founder & GM', primary: 1 },
    { cid: clientData[2].id, fn: 'Aisha', ln: 'Brooks', email: 'aisha@barrelandvine.com', title: 'Marketing Director', primary: 0 },
    { cid: clientData[3].id, fn: 'Kendra', ln: 'Okafor', email: 'kendra@tryonpm.com', title: 'Owner', primary: 1 },
    { cid: clientData[4].id, fn: 'Robert', ln: 'Kim', email: 'rkim@southendaccounting.com', title: 'Managing Partner', primary: 1 },
  ];
  const insCon = db.prepare('INSERT INTO contacts (id, client_id, first_name, last_name, email, phone, is_primary) VALUES (?,?,?,?,?,?,?)');
  contactData.forEach(c => { c.id = uuid(); insCon.run(c.id, c.cid, c.fn, c.ln, c.email, c.title, c.primary); });

  // Leads
  const getLS = db.prepare('SELECT id FROM lead_sources WHERE name = ?');
  const leadData = [
    { id: uuid(), cid: clientData[0].id, conId: contactData[0].id, src: 'LinkedIn', status: 'won', val: 2500, disc: '2026-05-15', close: '2026-06-01' },
    { id: uuid(), cid: clientData[1].id, conId: contactData[2].id, src: 'Charlotte Chamber', status: 'won', val: 5000, disc: '2026-06-01', close: '2026-06-15' },
    { id: uuid(), cid: clientData[2].id, conId: contactData[3].id, src: 'Client Referral', status: 'won', val: 8000, disc: '2026-06-20', close: '2026-07-01' },
    { id: uuid(), cid: clientData[3].id, conId: contactData[5].id, src: 'Partner Referral', status: 'proposal_sent', val: 3000, disc: '2026-07-10', close: null },
    { id: uuid(), cid: clientData[4].id, conId: contactData[6].id, src: 'Speaking Engagement', status: 'discovery_complete', val: 6000, disc: '2026-07-20', close: null },
  ];
  const insLead = db.prepare('INSERT INTO leads (id, client_id, contact_id, lead_source_id, status, estimated_value, discovery_date, close_date) VALUES (?,?,?,?,?,?,?,?)');
  leadData.forEach(l => insLead.run(l.id, l.cid, l.conId, getLS.get(l.src).id, l.status, l.val, l.disc, l.close));

  // Projects
  const projData = [
    { id: uuid(), cid: clientData[0].id, svc: 1, name: 'Magnolia Financial — AI Readiness Assessment', status: 'completed', budget: 2500, start: '2026-06-01', end: '2026-06-21', actual: '2026-06-18' },
    { id: uuid(), cid: clientData[1].id, svc: 2, name: 'QueenCity Dental — Analytics Modernization', status: 'active', budget: 5000, start: '2026-06-15', end: '2026-08-15', actual: null },
    { id: uuid(), cid: clientData[2].id, svc: 3, name: 'Barrel & Vine — AI Workflow Automation', status: 'active', budget: 8000, start: '2026-07-01', end: '2026-09-01', actual: null },
  ];
  const insProj = db.prepare('INSERT INTO projects (id, client_id, service_id, assigned_to, name, status, budget, start_date, target_end_date, actual_end_date) VALUES (?,?,?,?,?,?,?,?,?,?)');
  projData.forEach(p => insProj.run(p.id, p.cid, p.svc, mId, p.name, p.status, p.budget, p.start, p.end, p.actual));

  // Milestones
  const msData = [
    [projData[0].id, 'Intake form & discovery session', 'completed', '2026-06-05', '2026-06-04', 1],
    [projData[0].id, 'Data & process analysis', 'completed', '2026-06-10', '2026-06-09', 2],
    [projData[0].id, 'Report drafting', 'completed', '2026-06-15', '2026-06-14', 3],
    [projData[0].id, 'Debrief presentation', 'completed', '2026-06-19', '2026-06-18', 4],
    [projData[0].id, 'Final report delivery', 'completed', '2026-06-21', '2026-06-18', 5],
    [projData[1].id, 'Current state audit', 'completed', '2026-06-22', '2026-06-21', 1],
    [projData[1].id, 'Dashboard requirements & wireframes', 'completed', '2026-07-01', '2026-06-30', 2],
    [projData[1].id, 'Power BI dashboard build', 'in_progress', '2026-07-20', null, 3],
    [projData[1].id, 'Legacy report migration', 'pending', '2026-08-01', null, 4],
    [projData[1].id, 'Training & handoff', 'pending', '2026-08-15', null, 5],
    [projData[2].id, 'Workflow audit & opportunity mapping', 'completed', '2026-07-10', '2026-07-09', 1],
    [projData[2].id, 'Automation design & approval', 'in_progress', '2026-07-25', null, 2],
    [projData[2].id, 'Build phase 1: reservations & inventory', 'pending', '2026-08-10', null, 3],
    [projData[2].id, 'Build phase 2: marketing & reviews', 'pending', '2026-08-25', null, 4],
    [projData[2].id, 'Testing, training & documentation', 'pending', '2026-09-01', null, 5],
  ];
  const insMS = db.prepare('INSERT INTO milestones (project_id, name, status, due_date, completed_date, sort_order) VALUES (?,?,?,?,?,?)');
  msData.forEach(m => insMS.run(...m));

  // Retainers
  db.prepare('INSERT INTO retainers (id, client_id, service_id, monthly_rate, hours_included, status, start_date) VALUES (?,?,?,?,?,?,?)')
    .run(uuid(), clientData[0].id, 4, 2000, 6, 'active', '2026-07-01');

  // Invoices & Payments
  const invData = [
    { id: uuid(), num: 'PRISM-2026-001', cid: clientData[0].id, pid: projData[0].id, rid: null, status: 'paid', issue: '2026-06-18', due: '2026-07-18', total: 2500 },
    { id: uuid(), num: 'PRISM-2026-002', cid: clientData[1].id, pid: projData[1].id, rid: null, status: 'sent', issue: '2026-06-15', due: '2026-07-15', total: 5000 },
    { id: uuid(), num: 'PRISM-2026-003', cid: clientData[2].id, pid: projData[2].id, rid: null, status: 'sent', issue: '2026-07-01', due: '2026-08-01', total: 8000 },
    { id: uuid(), num: 'PRISM-2026-004', cid: clientData[0].id, pid: null, rid: null, status: 'paid', issue: '2026-07-01', due: '2026-07-15', total: 2000 },
  ];
  const insInv = db.prepare('INSERT INTO invoices (id, invoice_number, client_id, project_id, retainer_id, status, issue_date, due_date, subtotal, total) VALUES (?,?,?,?,?,?,?,?,?,?)');
  invData.forEach(i => insInv.run(i.id, i.num, i.cid, i.pid, i.rid, i.status, i.issue, i.due, i.total, i.total));

  const insPay = db.prepare('INSERT INTO payments (id, invoice_id, amount, payment_date, payment_method) VALUES (?,?,?,?,?)');
  insPay.run(uuid(), invData[0].id, 2500, '2026-06-25', 'ach');
  insPay.run(uuid(), invData[1].id, 2500, '2026-06-18', 'ach');
  insPay.run(uuid(), invData[2].id, 2667, '2026-07-03', 'check');
  insPay.run(uuid(), invData[3].id, 2000, '2026-07-08', 'ach');

  // Expenses
  const expData = [
    ['software','Microsoft','Microsoft 365 Business Standard',12.50,'2026-03-01',1,'monthly'],
    ['software','Zoom','Zoom Pro subscription',13.33,'2026-03-01',1,'monthly'],
    ['software','Canva','Canva Pro subscription',12.99,'2026-03-01',1,'monthly'],
    ['software','QuickBooks','QuickBooks Online Simple Start',30.00,'2026-03-01',1,'monthly'],
    ['software','Squarespace','Website hosting',16.00,'2026-03-01',1,'monthly'],
    ['insurance','Hiscox','Professional liability (E&O)',50.00,'2026-04-01',1,'monthly'],
    ['insurance','Hiscox','General liability insurance',30.00,'2026-04-01',1,'monthly'],
    ['marketing','LinkedIn','LinkedIn Premium Business',59.99,'2026-03-01',1,'monthly'],
    ['professional_services','NC Secretary of State','LLC filing fee',125.00,'2026-02-15',0,null],
    ['professional_services','Bennett Business Law','Operating agreement review',500.00,'2026-03-01',0,null],
    ['equipment','Apple','External monitor',349.99,'2026-03-10',0,null],
    ['training','Coursera','Google AI Essentials course',49.00,'2026-03-15',0,null],
  ];
  const insExp = db.prepare('INSERT INTO expenses (id, category, vendor, description, amount, expense_date, is_recurring, recurrence_freq) VALUES (?,?,?,?,?,?,?,?)');
  expData.forEach(e => insExp.run(uuid(), ...e));

  // Time entries
  const timeData = [
    [mId, projData[0].id, clientData[0].id, '2026-06-02', 2.0, 'Intake form review and prep'],
    [mId, projData[0].id, clientData[0].id, '2026-06-04', 1.5, 'Discovery session'],
    [mId, projData[0].id, clientData[0].id, '2026-06-06', 3.0, 'Data landscape analysis'],
    [mId, projData[0].id, clientData[0].id, '2026-06-09', 3.5, 'Process documentation review'],
    [mId, projData[0].id, clientData[0].id, '2026-06-12', 4.0, 'Report drafting'],
    [mId, projData[0].id, clientData[0].id, '2026-06-14', 2.0, 'Report revision'],
    [mId, projData[0].id, clientData[0].id, '2026-06-18', 2.0, 'Debrief presentation'],
    [mId, projData[1].id, clientData[1].id, '2026-06-16', 3.0, 'Current systems audit'],
    [mId, projData[1].id, clientData[1].id, '2026-06-19', 2.5, 'Stakeholder interviews'],
    [mId, projData[1].id, clientData[1].id, '2026-06-25', 3.0, 'Dashboard requirements workshop'],
    [mId, projData[1].id, clientData[1].id, '2026-06-30', 2.5, 'Wireframe design'],
    [mId, projData[1].id, clientData[1].id, '2026-07-05', 3.0, 'Power BI dashboard development'],
    [mId, projData[2].id, clientData[2].id, '2026-07-02', 2.0, 'Kickoff meeting'],
    [mId, projData[2].id, clientData[2].id, '2026-07-05', 3.0, 'Workflow mapping'],
    [mId, projData[2].id, clientData[2].id, '2026-07-09', 3.0, 'Automation opportunity assessment'],
  ];
  const insTime = db.prepare('INSERT INTO time_entries (team_member_id, project_id, client_id, entry_date, hours, description, is_billable) VALUES (?,?,?,?,?,?,1)');
  timeData.forEach(t => insTime.run(...t));

  // Activity log
  const actData = [
    ['client', clientData[0].id, mId, 'meeting', 'Discovery call with James Harwell', '2026-05-15 10:00:00'],
    ['client', clientData[0].id, mId, 'email', 'Sent proposal for AI Readiness Assessment', '2026-05-20 14:00:00'],
    ['client', clientData[0].id, mId, 'note', 'James interested in ongoing advisory after assessment', '2026-06-18 16:00:00'],
    ['client', clientData[1].id, mId, 'meeting', 'Met Dr. Nair at Charlotte Chamber mixer', '2026-06-01 18:30:00'],
    ['client', clientData[2].id, mId, 'call', 'Intro call with Marcus — referred by Magnolia Financial', '2026-06-20 11:00:00'],
  ];
  const insAct = db.prepare('INSERT INTO activity_log (entity_type, entity_id, team_member_id, action, summary, logged_at) VALUES (?,?,?,?,?,?)');
  actData.forEach(a => insAct.run(...a));

  // AI Readiness Assessment
  db.prepare(`INSERT INTO ai_readiness_assessments (id, client_id, project_id, assessed_by, assessment_date,
    data_quality, data_accessibility, process_documentation, technology_stack, team_ai_readiness, leadership_commitment,
    summary, recommendations) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(uuid(), clientData[0].id, projData[0].id, mId, '2026-06-14',
      3, 2, 3, 4, 2, 4,
      'Solid leadership buy-in and modern tech, but data accessibility and team readiness are lagging.',
      'Centralize data from CRM and accounting. Recommend Power BI dashboards and phased AI adoption.');

  console.log('  Database seeded with sample data.');
}

initDB();

// --- CRM column migration (safe to run on existing DBs) ---
function migrateCRMColumns() {
  const cols = db.prepare("PRAGMA table_info(clients)").all().map(r => r.name);
  const crmCols = [
    { name: 'crm_status',             sql: "ALTER TABLE clients ADD COLUMN crm_status TEXT DEFAULT 'New Lead'" },
    { name: 'crm_budget',             sql: 'ALTER TABLE clients ADD COLUMN crm_budget REAL' },
    { name: 'crm_project_name',       sql: 'ALTER TABLE clients ADD COLUMN crm_project_name TEXT' },
    { name: 'crm_service',            sql: 'ALTER TABLE clients ADD COLUMN crm_service TEXT' },
    { name: 'crm_lead_source',        sql: 'ALTER TABLE clients ADD COLUMN crm_lead_source TEXT' },
    { name: 'crm_contact_name',       sql: 'ALTER TABLE clients ADD COLUMN crm_contact_name TEXT' },
    { name: 'crm_contact_email',      sql: 'ALTER TABLE clients ADD COLUMN crm_contact_email TEXT' },
    { name: 'crm_contact_phone',      sql: 'ALTER TABLE clients ADD COLUMN crm_contact_phone TEXT' },
    { name: 'crm_last_status_change', sql: "ALTER TABLE clients ADD COLUMN crm_last_status_change TEXT DEFAULT (datetime('now'))" },
  ];
  crmCols.forEach(c => { if (!cols.includes(c.name)) db.exec(c.sql); });
}
migrateCRMColumns();

// Link action_items ↔ tickets + Notion sync tracking
(function migrateActionTicketLink() {
  try { db.exec("ALTER TABLE action_items ADD COLUMN ticket_id TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE tickets ADD COLUMN action_item_id INTEGER"); } catch(e) {}
  try { db.exec("ALTER TABLE tickets ADD COLUMN notion_page_id TEXT"); } catch(e) {}
})();

// Add category column to services table
(function migrateServicesCategory() {
  const cols = db.prepare("PRAGMA table_info(services)").all().map(r => r.name);
  if (!cols.includes('category')) {
    db.exec("ALTER TABLE services ADD COLUMN category TEXT DEFAULT 'Data & Analytics'");
    db.exec("UPDATE services SET category = 'Compliance & Security' WHERE name IN ('CIS/STIG Coverage Gap Assessment','Drift Detection Blueprint','Remediation Automation Sprint','Compliance Data Hub','Managed Compliance Engineering','Audit Evidence Automation','AI Governance & Hardening Assessment')");
  }
})();

// Add benchmark_version + benchmark_status columns to benchmark_rules
(function migrateBenchmarkRulesColumns() {
  try {
    const cols = db.prepare("PRAGMA table_info(benchmark_rules)").all().map(r => r.name);
    if (!cols.includes('benchmark_version')) db.exec("ALTER TABLE benchmark_rules ADD COLUMN benchmark_version TEXT");
    if (!cols.includes('benchmark_status')) db.exec("ALTER TABLE benchmark_rules ADD COLUMN benchmark_status TEXT DEFAULT 'active'");
    if (!cols.includes('cis_uid')) db.exec("ALTER TABLE benchmark_rules ADD COLUMN cis_uid TEXT");
    if (!cols.includes('references')) db.exec('ALTER TABLE benchmark_rules ADD COLUMN "references" TEXT');
    if (!cols.includes('section_name')) db.exec("ALTER TABLE benchmark_rules ADD COLUMN section_name TEXT");
  } catch(e) { /* table may not exist yet on first run */ }
})();

// ─── Operational Inventory Seed ──────────────────────────────────────────────
function seedInventory() {
  const toolCount = db.prepare('SELECT COUNT(*) as n FROM tools').get().n;
  if (toolCount > 0) return;

  const insTool = db.prepare('INSERT INTO tools (name, category, suite, description, business_use, relevance, utilization, trigger_phrase) VALUES (?,?,?,?,?,?,?,?)');

  // 18 Custom Skills
  const customSkills = [
    ['prismai-company-profile','custom_skill',null,'Brand context, voice, colors, services, founder bio','Loaded automatically for all on-brand content creation','critical','high','Load company profile'],
    ['cis-compliance-assistant','custom_skill',null,'Full CIS Benchmark compliance — rules extraction, audits, checklists, gap analyses','Core revenue skill for compliance consulting service line','critical','high','Run a CIS compliance audit'],
    ['cis-benchmark-extractor','custom_skill',null,'Extract structured rules from CIS PDFs into Excel','Automates benchmark processing for client deliverables','critical','medium','Extract CIS benchmark rules'],
    ['discovery-call-prep','custom_skill',null,'Research prospects, identify pain points, format prep briefs','Pre-call intelligence for every new prospect meeting','critical','medium','Prep me for my call with [Company]'],
    ['doc-coauthoring','custom_skill',null,'Structured co-authoring workflow for docs/proposals/specs','Collaborative document creation with clients','important','medium','Co-author a document'],
    ['docx','custom_skill',null,'Create, edit, manipulate Word documents','Client proposals, reports, assessments','important','high','Create a Word document'],
    ['xlsx','custom_skill',null,'Excel spreadsheet creation, editing, analysis','CRM tracker, financial models, data deliverables','important','high','Create a spreadsheet'],
    ['pptx','custom_skill',null,'PowerPoint presentation creation/editing','Client presentations, pitch decks','important','medium','Create a presentation'],
    ['pdf','custom_skill',null,'PDF extraction, creation, merging, splitting, forms','CIS benchmark processing, client report delivery','important','high','Work with a PDF'],
    ['web-artifacts-builder','custom_skill',null,'Complex multi-component HTML/React artifacts','Interactive dashboards, web deliverables','important','medium','Build a web artifact'],
    ['canvas-design','custom_skill',null,'Visual art creation for posters/designs in PNG/PDF','Marketing materials, social graphics','growing','low','Design a visual'],
    ['algorithmic-art','custom_skill',null,'Generative art using p5.js','Unique branded visual content','future','low','Create algorithmic art'],
    ['theme-factory','custom_skill',null,'10 pre-set themes for styling artifacts','Consistent styling across deliverables','active','medium','Apply a theme'],
    ['brand-guidelines','custom_skill',null,'Anthropic brand colors/typography application','Reference for partner/vendor materials','active','low','Apply brand guidelines'],
    ['skill-creator','custom_skill',null,'Create, modify, evaluate, and optimize skills','Build new automation skills as services expand','important','medium','Create a new skill'],
    ['mcp-builder','custom_skill',null,'Guide for building MCP servers (Python/Node)','Create custom integrations for client projects','growing','low','Build an MCP server'],
    ['internal-comms','custom_skill',null,'Status reports, updates, newsletters, FAQs','Client communication templates','active','low','Draft an internal update'],
    ['schedule','custom_skill',null,'Create scheduled/recurring automated tasks','Automated reporting, monitoring, recurring workflows','important','medium','Schedule a recurring task'],
  ];
  customSkills.forEach(s => insTool.run(...s));

  // Plugin Suites — Sales (9)
  const salesSkills = [
    ['account-research','plugin','sales','Research a company/person for actionable sales intel','Web + enrichment intelligence','critical','low','Research [Company]'],
    ['call-prep','plugin','sales','Prepare for sales calls with account context and agenda','Pre-call preparation','critical','low','Prep for my call'],
    ['call-summary','plugin','sales','Process call notes/transcripts into action items','Post-call processing','critical','low','Summarize my call'],
    ['competitive-intelligence','plugin','sales','Research competitors, build interactive battlecards','Competitive analysis','important','low','Research competitors'],
    ['create-an-asset','plugin','sales','Generate tailored sales assets (decks, one-pagers)','Sales collateral creation','important','low','Create a sales asset'],
    ['daily-briefing','plugin','sales','Morning briefing with prioritized tasks','Daily sales overview','critical','low','Give me my daily briefing'],
    ['draft-outreach','plugin','sales','Research prospect + draft personalized outreach','Cold outreach drafting','critical','low','Draft outreach to [ICP]'],
    ['forecast','plugin','sales','Weighted sales forecast with scenarios','Revenue forecasting','important','low','Create a sales forecast'],
    ['pipeline-review','plugin','sales','Analyze pipeline health, prioritize deals','Pipeline management','critical','low','Review my pipeline'],
  ];
  salesSkills.forEach(s => insTool.run(...s));

  // Marketing (8)
  const mktSkills = [
    ['campaign-plan','plugin','marketing','Full campaign brief with objectives and channel strategy','Campaign planning','critical','low','Plan a marketing campaign'],
    ['brand-review','plugin','marketing','Review content against brand voice/style guide','Brand consistency','active','low','Review this against our brand'],
    ['seo-audit','plugin','marketing','Keyword research, on-page analysis, content gaps','SEO optimization','important','low','Run an SEO audit'],
    ['performance-report','plugin','marketing','Marketing performance report with metrics and trends','Performance tracking','important','low','Create a marketing report'],
    ['email-sequence','plugin','marketing','Multi-email sequences with copy and timing','Email automation','critical','low','Create an email sequence'],
    ['draft-content','plugin','marketing','Blog posts, social, email, landing pages','Content creation','critical','low','Draft a blog post'],
    ['content-creation','plugin','marketing','Marketing content drafting across all channels','Multi-channel content','critical','low','Create marketing content'],
    ['competitive-brief','plugin','marketing','Positioning and messaging comparison','Competitive positioning','important','low','Create a competitive brief'],
  ];
  mktSkills.forEach(s => insTool.run(...s));

  // Data & Analytics (10)
  const dataSkills = [
    ['analyze','plugin','data','Answer data questions from quick lookups to full analyses','Data analysis','critical','medium','Analyze this data'],
    ['build-dashboard','plugin','data','Interactive HTML dashboards with charts and filters','Dashboard creation','critical','medium','Build a dashboard'],
    ['create-viz','plugin','data','Publication-quality Python visualizations','Data visualization','important','medium','Create a visualization'],
    ['data-context-extractor','plugin','data','Generate company-specific data analysis skills','Custom analytics','growing','low','Extract data context'],
    ['data-visualization','plugin','data','Matplotlib, seaborn, plotly charts','Chart creation','important','medium','Visualize this data'],
    ['explore-data','plugin','data','Profile datasets — shape, quality, distributions','Data profiling','critical','medium','Explore this dataset'],
    ['sql-queries','plugin','data','Correct, performant SQL across all dialects','SQL writing','important','medium','Write a SQL query'],
    ['statistical-analysis','plugin','data','Descriptive stats, trend analysis, outlier detection','Statistical analysis','important','low','Run statistical analysis'],
    ['validate-data','plugin','data','QA an analysis — methodology, accuracy, bias checks','Data quality','important','low','Validate this analysis'],
    ['write-query','plugin','data','Optimized SQL writing with best practices','SQL optimization','important','medium','Write an optimized query'],
  ];
  dataSkills.forEach(s => insTool.run(...s));

  // Finance (8)
  const finSkills = [
    ['financial-statements','plugin','finance','Income statement, balance sheet, cash flow','Financial reporting','critical','none','Generate financial statements'],
    ['journal-entry','plugin','finance','Journal entries with debits, credits, documentation','Bookkeeping','critical','none','Create a journal entry'],
    ['journal-entry-prep','plugin','finance','Journal entry preparation with supporting docs','Entry preparation','critical','none','Prepare journal entries'],
    ['reconciliation','plugin','finance','GL-to-subledger, bank, intercompany reconciliations','Account reconciliation','critical','none','Reconcile accounts'],
    ['variance-analysis','plugin','finance','Decompose variances into drivers with narratives','Variance reporting','important','none','Analyze variances'],
    ['close-management','plugin','finance','Month-end close task sequencing and tracking','Close management','important','none','Manage month-end close'],
    ['audit-support','plugin','finance','SOX 404 compliance with control testing','Audit support','important','none','Support audit prep'],
    ['sox-testing','plugin','finance','SOX sample selections, testing workpapers','SOX compliance','important','none','Run SOX testing'],
  ];
  finSkills.forEach(s => insTool.run(...s));

  // Legal (9)
  const legalSkills = [
    ['review-contract','plugin','legal','Clause-by-clause contract review against playbook','Contract review','important','none','Review this contract'],
    ['triage-nda','plugin','legal','Rapid NDA classification (GREEN/YELLOW/RED)','NDA processing','important','none','Triage this NDA'],
    ['compliance-check','plugin','legal','Compliance check on proposed actions or initiatives','Compliance verification','important','none','Run a compliance check'],
    ['legal-risk-assessment','plugin','legal','Classify legal risks by severity and likelihood','Risk assessment','important','none','Assess legal risks'],
    ['legal-response','plugin','legal','Template responses for DSARs, litigation holds','Legal templates','active','none','Draft a legal response'],
    ['meeting-briefing','plugin','legal','Legal briefing prep for negotiations and reviews','Meeting preparation','active','none','Prep legal briefing'],
    ['signature-request','plugin','legal','E-signature preparation, routing, checklist','Signature workflow','active','none','Prepare for signature'],
    ['vendor-check','plugin','legal','Consolidated vendor agreement status','Vendor review','active','none','Check vendor agreements'],
    ['brief','plugin','legal','Contextual legal briefings — daily, topic, incident','Legal research','active','none','Create a legal brief'],
  ];
  legalSkills.forEach(s => insTool.run(...s));

  // Engineering (10)
  const engSkills = [
    ['architecture','plugin','engineering','Architecture decision records with trade-off analysis','System design','important','medium','Create an ADR'],
    ['code-review','plugin','engineering','Security, performance, correctness review','Code quality','important','medium','Review this code'],
    ['debug','plugin','engineering','Structured debugging — reproduce, isolate, diagnose, fix','Bug resolution','important','medium','Debug this issue'],
    ['deploy-checklist','plugin','engineering','Pre-deployment verification with rollback triggers','Deploy safety','important','low','Run deploy checklist'],
    ['documentation','plugin','engineering','Technical docs, READMEs, runbooks, API docs','Technical writing','important','medium','Write documentation'],
    ['incident-response','plugin','engineering','Triage, communicate, write blameless postmortems','Incident handling','active','low','Handle an incident'],
    ['standup','plugin','engineering','Generate standup updates from recent activity','Team updates','active','low','Generate my standup'],
    ['system-design','plugin','engineering','Service design, API design, data modeling','Architecture','important','low','Design a system'],
    ['tech-debt','plugin','engineering','Identify, categorize, prioritize technical debt','Debt management','active','low','Review tech debt'],
    ['testing-strategy','plugin','engineering','Test strategies, test plans, coverage analysis','Test planning','important','low','Plan testing strategy'],
  ];
  engSkills.forEach(s => insTool.run(...s));

  // Product Management (9)
  const pmSkills = [
    ['write-spec','plugin','product','Feature specs / PRDs from problem statements','Product specs','growing','low','Write a feature spec'],
    ['sprint-planning','plugin','product','Sprint scoping, capacity estimation, goal setting','Sprint management','growing','low','Plan the sprint'],
    ['roadmap-update','plugin','product','Roadmap creation, reprioritization','Roadmap management','growing','low','Update the roadmap'],
    ['product-brainstorming','plugin','product','Idea generation, assumption challenging','Ideation','growing','low','Brainstorm product ideas'],
    ['pm-competitive-brief','plugin','product','Competitive analysis for features or competitors','Competitive analysis','growing','low','Create competitive brief'],
    ['metrics-review','plugin','product','Product metrics analysis with trends','Metrics tracking','growing','low','Review product metrics'],
    ['stakeholder-update','plugin','product','Status updates tailored to audience','Communication','growing','low','Create stakeholder update'],
    ['synthesize-research','plugin','product','Turn feedback into structured insights','Research synthesis','growing','low','Synthesize user research'],
    ['brainstorm','plugin','product','Interactive brainstorming as a thinking partner','Creative ideation','growing','low','Brainstorm with me'],
  ];
  pmSkills.forEach(s => insTool.run(...s));

  // Operations (9)
  const opsSkills = [
    ['capacity-plan','plugin','operations','Resource capacity planning with forecasting','Resource planning','important','low','Plan capacity'],
    ['change-request','plugin','operations','Change management with impact analysis','Change management','important','low','Create a change request'],
    ['compliance-tracking','plugin','operations','SOC 2, ISO 27001, GDPR compliance tracking','Compliance tracking','important','low','Track compliance'],
    ['process-doc','plugin','operations','Process documentation — flowcharts, RACI, SOPs','Process documentation','important','low','Document this process'],
    ['process-optimization','plugin','operations','Analyze and improve business processes','Process improvement','important','low','Optimize this process'],
    ['risk-assessment','plugin','operations','Identify, assess, mitigate operational risks','Risk management','important','low','Assess operational risks'],
    ['runbook','plugin','operations','Operational runbooks for recurring procedures','Runbook creation','important','low','Create a runbook'],
    ['status-report','plugin','operations','KPI-driven status reports with action items','Status reporting','important','low','Generate status report'],
    ['vendor-review','plugin','operations','Vendor evaluation — cost, risk, recommendation','Vendor management','active','low','Review a vendor'],
  ];
  opsSkills.forEach(s => insTool.run(...s));

  // Design (7)
  const designSkills = [
    ['accessibility-review','plugin','design','WCAG 2.1 AA accessibility audit','Accessibility compliance','growing','low','Run accessibility audit'],
    ['design-critique','plugin','design','Structured feedback on usability and hierarchy','Design review','growing','low','Critique this design'],
    ['design-handoff','plugin','design','Developer handoff specs — layout, tokens, breakpoints','Dev handoff','growing','low','Create design handoff'],
    ['design-system','plugin','design','Audit, document, extend design systems','Design systems','growing','low','Review design system'],
    ['research-synthesis','plugin','design','Synthesize user research into themes','Research synthesis','growing','low','Synthesize research'],
    ['user-research','plugin','design','Plan, conduct, synthesize user research','User research','growing','low','Plan user research'],
    ['ux-copy','plugin','design','Microcopy, error messages, CTAs, empty states','UX writing','growing','low','Write UX copy'],
  ];
  designSkills.forEach(s => insTool.run(...s));

  // Brand Voice (5)
  const brandSkills = [
    ['brand-voice-enforcement','plugin','brand_voice','Apply brand guidelines to any content task','Brand consistency','active','high','Enforce brand voice'],
    ['discover-brand','plugin','brand_voice','Autonomously discover brand materials','Brand discovery','active','medium','Discover brand materials'],
    ['guideline-generation','plugin','brand_voice','Generate brand voice guidelines from sources','Guideline creation','active','medium','Generate brand guidelines'],
    ['enforce-voice','plugin','brand_voice','Quick command to apply brand guidelines','Brand enforcement','active','high','Apply brand voice'],
    ['generate-guidelines','plugin','brand_voice','Quick command to generate guidelines','Guideline generation','active','medium','Generate guidelines'],
  ];
  brandSkills.forEach(s => insTool.run(...s));

  // Enterprise Search (5)
  const searchSkills = [
    ['search','plugin','enterprise_search','Search across all connected sources','Cross-platform search','active','medium','Search for [topic]'],
    ['digest','plugin','enterprise_search','Daily/weekly digest of activity','Activity digest','active','low','Create a digest'],
    ['knowledge-synthesis','plugin','enterprise_search','Combine multi-source results into answers','Knowledge synthesis','active','medium','Synthesize knowledge on [topic]'],
    ['search-strategy','plugin','enterprise_search','Query decomposition and orchestration','Search optimization','active','low','Optimize search strategy'],
    ['source-management','plugin','enterprise_search','Manage connected sources and priorities','Source management','active','low','Manage search sources'],
  ];
  searchSkills.forEach(s => insTool.run(...s));

  // Customer Support (5)
  const supportSkills = [
    ['ticket-triage','plugin','customer_support','Categorize, prioritize, route support tickets','Ticket management','future','none','Triage this ticket'],
    ['draft-response','plugin','customer_support','Professional customer responses','Customer communication','future','none','Draft a customer response'],
    ['customer-research','plugin','customer_support','Multi-source research on customer questions','Customer intel','future','none','Research this customer question'],
    ['customer-escalation','plugin','customer_support','Package escalations with full context','Escalation handling','future','none','Escalate this issue'],
    ['kb-article','plugin','customer_support','Draft knowledge base articles from resolved issues','KB creation','future','none','Write a KB article'],
  ];
  supportSkills.forEach(s => insTool.run(...s));

  // Apollo (3)
  const apolloSkills = [
    ['enrich-lead','plugin','apollo','Instant lead enrichment — full contact card','Lead enrichment','critical','low','Enrich this lead'],
    ['prospect','plugin','apollo','ICP-to-leads pipeline with ranked results','Lead generation','critical','low','Find leads matching [ICP]'],
    ['sequence-load','plugin','apollo','Find leads + bulk-add to outreach sequences','Sequence enrollment','critical','low','Load leads into sequence'],
  ];
  apolloSkills.forEach(s => insTool.run(...s));

  // Productivity (4)
  const prodSkills = [
    ['memory-management','plugin','productivity','Two-tier memory system for knowledge continuity','Memory management','active','medium','Manage memory'],
    ['task-management','plugin','productivity','Task tracking using shared TASKS.md','Task tracking','active','medium','Manage tasks'],
    ['start','plugin','productivity','Initialize productivity system and dashboard','System init','active','low','Start productivity system'],
    ['update','plugin','productivity','Sync tasks and refresh memory','System sync','active','low','Update productivity'],
  ];
  prodSkills.forEach(s => insTool.run(...s));

  // Plugin Management (2)
  const pluginMgmt = [
    ['create-cowork-plugin','plugin','plugin_management','Guide users through creating a new plugin','Plugin creation','growing','low','Create a plugin'],
    ['cowork-plugin-customizer','plugin','plugin_management','Customize existing plugins for workflows','Plugin customization','growing','low','Customize a plugin'],
  ];
  pluginMgmt.forEach(s => insTool.run(...s));

  // 12 MCP Connectors
  const connectors = [
    ['Notion','connector',null,'Search, fetch, create/update pages & databases, views, comments, users, teams, meeting notes','Central knowledge base, ticket system, content calendar, task management','critical','high',null],
    ['Google Calendar','connector',null,'List/create/update/delete events, find meeting times, find free time, respond to events','Discovery call scheduling, client meeting management, sprint cadence','critical','high',null],
    ['Gmail','connector',null,'Search messages, read messages/threads, create drafts, list labels/drafts','Client communication tracking, outreach drafting, follow-up management','critical','medium',null],
    ['Google Drive','connector',null,'Search files, fetch document content','Document repository sync, client file access, shared deliverables','important','medium',null],
    ['Claude in Chrome','connector',null,'Browser automation — navigate, read pages, fill forms, execute JS, screenshots, GIF creation','Web research, competitor analysis, form testing, website QA, demo recording','important','medium',null],
    ['Netlify','connector',null,'Deploy services, project management, extension management','Website deployment, client demo hosting','important','medium',null],
    ['Apollo','connector',null,'Lead enrichment, prospecting, sequence enrollment','Prospect identification, lead enrichment, outreach automation','critical','low',null],
    ['CIS Dashboard','connector',null,'Extract PDFs, search rules, push rules, sync pipeline, product mapping','Core compliance service delivery infrastructure','critical','high',null],
    ['MCP Registry','connector',null,'Search for new MCP connectors, suggest installations','Discover and add new integrations as needed','active','low',null],
    ['Plugin Registry','connector',null,'Search plugins, suggest plugin installs','Expand capabilities with new plugin suites','active','low',null],
    ['Scheduled Tasks','connector',null,'Create, list, update scheduled/recurring tasks','Automated reporting, monitoring, recurring workflows','important','medium',null],
    ['Session Info','connector',null,'List sessions, read transcripts','Session history, knowledge continuity across conversations','active','low',null],
  ];
  connectors.forEach(c => insTool.run(...c));

  // Business Assets
  const insAsset = db.prepare('INSERT INTO business_assets (name, folder, format, status, purpose) VALUES (?,?,?,?,?)');
  const assets = [
    ['Business Plan 2026','Admin','docx','complete','Company business plan'],
    ['Business Plan Summary','Admin','docx','complete','Condensed business plan'],
    ['Sprint Plan (30/60/90)','Admin','docx','active','Strategic sprint planning'],
    ['CRM Tracker','Admin','xlsx','active','Client pipeline tracking'],
    ['Documentation Index','Admin','xlsx','complete','Master document index'],
    ['Knowledge Base','Admin','docx','complete','Institutional knowledge base'],
    ['Knowledge Base Index','Admin','docx','complete','KB navigation guide'],
    ['Letterhead / Banner','Admin','docx','complete','Brand collateral'],
    ['Amber Grant Application','Admin','docx','complete','Grant application'],
    ['LLC Articles of Organization','Admin','pdf','complete','Legal filing'],
    ['IRS EIN Application','Admin','pdf','complete','Tax filing'],
    ['Discovery Call Intake Form','Services','html','complete','Capture prospect info during first call'],
    ['AI Readiness Assessment Form','Services','html','complete','Structured client assessment tool'],
    ['Invoice/Proposal Requirements Form','Services','html','complete','Scope and pricing input form'],
    ['Compliance Discovery Intake Form','Services','html','complete','CIS compliance-specific intake'],
    ['Prompt Library','Services','docx','complete','Reusable AI prompts for service delivery'],
    ['Client Folder Template','Services','md','complete','Standardized client folder structure'],
    ['Brand Guidelines','Marketing','docx','complete','Brand voice, colors, typography'],
    ['AI Bridge Agentic Strategy','Marketing','docx','complete','AI consulting strategy document'],
    ['Faceless Content Channel Strategy','Marketing','docx','complete','Content channel playbook'],
    ['Compliance Services Positioning','Marketing','md','complete','Compliance service positioning'],
    ['Retainer Pricing Sheet','Marketing','pdf','complete','Service pricing reference'],
    ['AI Analytics Pipeline','Development','py','complete','Data pipeline connecting 7 APIs'],
    ['Prism Data Pipeline','Development','py','complete','Separate data pipeline project'],
    ['CRM Buildout Strategy','Development','docx','in_progress','Express.js API strategy doc'],
    ['Admin Dashboard','Development','html','in_progress','8-page admin dashboard UI'],
    ['Database Diagram','Development','html','complete','Interactive DB schema visualization'],
    ['Prism Website','Development','html','complete','Full website codebase on Netlify'],
    ['Stock Trading Agent','Development','py','complete','AI-powered trading education agent'],
    ['AI Analytics Industry Report','Research','docx','complete','Comprehensive industry landscape'],
    ['AI Industry Dashboard Data','Research','xlsx','complete','Market intelligence dataset'],
    ['AI Industry Dashboard','Research','html','complete','Interactive market intelligence dashboard'],
    ['AI Analytics Dashboard Report','Research','docx','complete','Analysis companion to dashboard'],
    ['Data Sources Reference Guide','Research','docx','complete','Guide to data sources'],
    ['Trend Data Analysis','Research','xlsx','complete','AI/data analytics market trends'],
  ];
  assets.forEach(a => insAsset.run(...a));

  // Daily logs (14 files)
  for (let i = 1; i <= 14; i++) {
    insAsset.run(`Daily Activity Log ${i}`, 'Admin', 'docx', 'complete', 'Daily operations log');
  }

  // Revenue workstream docs (5)
  ['Freelancing','Digital Products','Content Channel','Agency Services','High-Value Specializations'].forEach(ws => {
    insAsset.run(`Revenue Workstream: ${ws}`, 'Revenue', 'docx', 'complete', `${ws} revenue strategy`);
  });

  // Maturity Scores
  const insMaturity = db.prepare('INSERT INTO maturity_scores (area, score, rating, analysis) VALUES (?,?,?,?)');
  const maturityData = [
    ['Brand & Identity', 90, 'strong', 'Most mature area. Brand guidelines are complete and codified in both a DOCX and a custom skill that auto-loads for every task. Color palette, typography, voice guidelines, tone-by-channel rules, document standards, and file naming conventions are all documented.'],
    ['Service Design & Pricing', 85, 'strong', 'Four distinct service lines with clear pricing are defined and documented. Three retainer tiers ($2K-$8.5K/month) are proposal-ready. Phase 2 productized offerings are planned. The only gap is no templated proposal document.'],
    ['Knowledge Management', 80, 'strong', 'Notion workspace is well-architected with 6 databases and 20+ knowledge pages. Knowledge Library provides searchable institutional knowledge. Main gap: knowledge split across Notion, local files, and Google Drive without single source of truth.'],
    ['Technical Infrastructure', 75, 'good', 'Impressive for a 2-month-old company. AI analytics pipeline connecting 7 APIs, CRM buildout with 20+ endpoints, CIS Dashboard MCP connector, sandbox datasets ready for demos. Gap: CRM still in development while tracking clients in Excel.'],
    ['Sales & Pipeline', 50, 'developing', 'Tools ready but execution early. Apollo connector enables prospecting, discovery-call-prep skill and 4 intake forms create complete workflow. Gap: no visible prospecting sequence running, no outreach templates deployed, no pipeline review cadence.'],
    ['Marketing & Content', 45, 'developing', 'Strategy is thorough but execution has not started. Complete playbook exists. Social media launch planned for June 2026. No blog posts, LinkedIn posts, or email sequences published yet. Content creation skills ready to activate immediately.'],
    ['Client Delivery Ops', 40, 'developing', 'Framework exists but not stress-tested at scale. Client folder template, service forms, and prompt library are ready. Gap: no completed case studies, no post-engagement feedback forms, no SOW templates, no QA checklist.'],
    ['Financial Operations', 30, 'early', 'Most significant gap. Despite having 8 finance plugin skills, no accounting system connected, no invoicing workflow, no financial reporting cadence. Revenue tracking spreadsheet is the only financial artifact.'],
  ];
  maturityData.forEach(m => insMaturity.run(...m));

  // Action Items
  const insAction = db.prepare('INSERT INTO action_items (priority, urgency, title, description, tools_to_use, status) VALUES (?,?,?,?,?,?)');
  const actions = [
    [1, 'immediate', 'Set up invoicing & payment tracking', 'Connect Stripe or QuickBooks. Use finance:journal-entry skill to establish chart of accounts. Create basic P&L. ~$24K in active projects with no visible invoicing system.', 'finance:journal-entry,finance:financial-statements', 'pending'],
    [2, 'immediate', 'Create a client contract template', 'Use legal:review-contract skill to draft standard MSA and SOW template. Legal folder has LLC docs but no client-facing agreements.', 'legal:review-contract,docx', 'pending'],
    [3, 'immediate', 'Run an Apollo prospecting sequence', 'Define ICP (Charlotte-area SMBs in finance, healthcare, retail, hospitality, real estate). Generate personalized emails. Enroll leads in outreach sequence.', 'apollo:prospect,sales:draft-outreach,apollo:sequence-load', 'pending'],
    [4, 'next_2_weeks', 'Build a client proposal template', 'Use docx skill + prismai-company-profile to create branded fill-in-the-blank proposal template. Combine with Notion proposal guide.', 'docx,prismai-company-profile', 'pending'],
    [5, 'next_2_weeks', 'Pre-build June content library', 'Create social launch campaign. Draft 12-16 LinkedIn posts. Schedule in Notion Content Calendar.', 'marketing:campaign-plan,marketing:content-creation', 'pending'],
    [6, 'next_2_weeks', 'Create a demo dashboard from sandbox data', 'Use 13 sandbox CSVs to create interactive analytics dashboard as a sales tool.', 'data:build-dashboard,data:explore-data', 'pending'],
    [7, 'next_2_weeks', 'Set up weekly status report cadence', 'Create recurring weekly business review tracking pipeline value, active projects, revenue, tasks, content.', 'operations:status-report,schedule', 'pending'],
    [8, 'next_30_days', 'Build your first case study', 'Use Cafe Uvee engagement to create templated case study (Challenge, Approach, Results).', 'docx,prismai-company-profile', 'pending'],
    [9, 'next_30_days', 'Consolidate duplicate files', 'Designate single sources of truth for brand guidelines, business plan, knowledge base, and prompt library. Archive duplicates.', null, 'pending'],
    [10, 'next_30_days', 'Create client onboarding runbook', 'Document end-to-end onboarding: signed contract to folder creation to kickoff call to first deliverable.', 'operations:runbook', 'pending'],
  ];
  actions.forEach(a => insAction.run(...a));

  console.log('  Operational inventory seeded (tools, assets, maturity, actions).');
}

// Auth helpers
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)').run(token, userId, expires);
  return { token, expires_at: expires };
}
function seedUsersIfEmpty() {
  try { db.prepare('SELECT 1 FROM users LIMIT 1').get(); } catch(e) { return; }
  const count = db.prepare('SELECT COUNT(*) as n FROM users').get().n;
  if (count > 0) return;
  const michele = db.prepare("SELECT id FROM team_members WHERE email = 'michele@prismaianalytics.com'").get();
  const izayah = db.prepare("SELECT id FROM team_members WHERE email = 'izayah@prismaianalytics.com'").get();
  if (michele) {
    const sl = crypto.randomBytes(16).toString('hex');
    db.prepare('INSERT INTO users (id, username, password_hash, salt, team_member_id, role) VALUES (?,?,?,?,?,?)')
      .run(uuid(), 'michele', hashPassword('Prism2026!', sl), sl, michele.id, 'admin');
  }
  if (izayah) {
    const sl = crypto.randomBytes(16).toString('hex');
    db.prepare('INSERT INTO users (id, username, password_hash, salt, team_member_id, role) VALUES (?,?,?,?,?,?)')
      .run(uuid(), 'izayah', hashPassword('PrismJr2026!', sl), sl, izayah.id, 'member');
  }
  console.log('User accounts seeded');
}

function seedTickets() {
  const count = db.prepare('SELECT COUNT(*) as n FROM tickets').get().n;
  if (count > 0) return;

  // Get team member IDs
  const michele = db.prepare("SELECT id FROM team_members WHERE first_name = 'Michele'").get();
  const izayah = db.prepare("SELECT id FROM team_members WHERE first_name = 'Izayah'").get();
  const mId = michele ? michele.id : null;
  const iId = izayah ? izayah.id : null;

  const ins = db.prepare(`INSERT INTO tickets (id, title, description, ticket_type, category, status, priority, assigned_to, due_date, tags, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);

  const batch = db.transaction(() => {
    // ─── Action Item tickets (from inventory analysis) ───
    ins.run(uuid(), 'Set up invoicing & payment tracking', 'Connect Stripe or QuickBooks. Use finance:journal-entry skill to establish chart of accounts. Create basic P&L.', 'internal', 'action', 'todo', 'urgent', mId, '2026-04-15', 'finance,action-item', 'system');
    ins.run(uuid(), 'Create client contract template', 'Use legal:review-contract skill to draft standard MSA and SOW template.', 'internal', 'action', 'todo', 'urgent', mId, '2026-04-18', 'legal,action-item', 'system');
    ins.run(uuid(), 'Run Apollo prospecting sequence', 'Define ICP (Charlotte-area SMBs). Generate personalized outreach emails. Enroll leads.', 'internal', 'action', 'todo', 'urgent', mId, '2026-04-20', 'sales,action-item', 'system');
    ins.run(uuid(), 'Build client proposal template', 'Use docx skill + prismai-company-profile to create branded fill-in-the-blank proposal.', 'internal', 'action', 'backlog', 'high', mId, '2026-04-30', 'sales,action-item', 'system');
    ins.run(uuid(), 'Pre-build June content library', 'Create social launch campaign. Draft 12-16 LinkedIn posts. Schedule in Notion Content Calendar.', 'internal', 'action', 'backlog', 'high', mId, '2026-05-15', 'marketing,action-item', 'system');
    ins.run(uuid(), 'Create demo dashboard from sandbox data', 'Use 13 sandbox CSVs to create interactive analytics dashboard as a sales tool.', 'internal', 'action', 'backlog', 'high', mId, '2026-05-20', 'data,action-item', 'system');
    ins.run(uuid(), 'Set up weekly status report cadence', 'Create recurring weekly business review tracking pipeline value, active projects, revenue.', 'internal', 'action', 'backlog', 'medium', mId, '2026-05-01', 'operations,action-item', 'system');
    ins.run(uuid(), 'Build first case study', 'Use Cafe Uvee engagement to create templated case study (Challenge, Approach, Results).', 'internal', 'action', 'backlog', 'medium', mId, '2026-05-30', 'marketing,action-item', 'system');
    ins.run(uuid(), 'Consolidate duplicate files', 'Designate single sources of truth for brand guidelines, business plan, knowledge base, and prompt library.', 'internal', 'action', 'backlog', 'medium', mId, '2026-06-15', 'operations,action-item', 'system');
    ins.run(uuid(), 'Create client onboarding runbook', 'Document end-to-end onboarding: signed contract to folder creation to kickoff call to first deliverable.', 'internal', 'action', 'backlog', 'medium', mId, '2026-06-30', 'operations,action-item', 'system');

    // ─── Training tickets (Michele) ───
    ins.run(uuid(), 'Complete Google AI Essentials certification', 'Continue Coursera modules. Target completion for client credibility.', 'internal', 'training', 'in_progress', 'high', mId, '2026-04-15', 'certification,training', 'system');
    ins.run(uuid(), 'Complete AI for Everyone course (Andrew Ng)', 'Enroll on Coursera. 4-week course covers AI strategy concepts useful for client conversations.', 'internal', 'training', 'backlog', 'medium', mId, '2026-05-01', 'certification,training', 'system');
    ins.run(uuid(), 'Pass PL-300: Power BI Data Analyst certification', 'Begin Microsoft Learn path. Schedule exam after 6-8 weeks of study.', 'internal', 'training', 'backlog', 'high', mId, '2026-06-15', 'certification,training', 'system');
    ins.run(uuid(), 'Complete AI for Business Strategy (Wharton)', 'Enroll on Coursera. Wharton credential strengthens enterprise client positioning.', 'internal', 'training', 'backlog', 'medium', mId, '2026-07-15', 'certification,training', 'system');
    ins.run(uuid(), 'Pass AWS Certified AI Practitioner exam', 'Begin AWS training materials. Cloud AI cert opens enterprise doors.', 'internal', 'training', 'backlog', 'medium', mId, '2026-09-01', 'certification,training', 'system');

    // ─── Training tickets (Izayah — onboarding) ───
    ins.run(uuid(), 'Complete CCA Agentic Architecture domain', 'Work through all 7 items in the Agentic Architecture & Orchestration domain.', 'internal', 'training', 'in_progress', 'high', iId, '2026-04-30', 'cca,training,onboarding', 'system');
    ins.run(uuid(), 'Complete CCA Claude Code Config domain', 'Work through all 7 items in the Claude Code Config & Workflows domain.', 'internal', 'training', 'todo', 'high', iId, '2026-05-15', 'cca,training,onboarding', 'system');
    ins.run(uuid(), 'Complete CCA Prompt Engineering domain', 'Work through all 7 items in the Prompt Engineering & Design domain.', 'internal', 'training', 'backlog', 'medium', iId, '2026-05-30', 'cca,training,onboarding', 'system');
    ins.run(uuid(), 'Complete CCA Tool Design/MCP domain', 'Work through all 7 items in the Tool Design & MCP Integration domain.', 'internal', 'training', 'backlog', 'medium', iId, '2026-06-15', 'cca,training,onboarding', 'system');
    ins.run(uuid(), 'Complete CCA Context Management domain', 'Work through all 7 items in the Context Management & Optimization domain.', 'internal', 'training', 'backlog', 'medium', iId, '2026-06-30', 'cca,training,onboarding', 'system');
    ins.run(uuid(), 'Complete AI Fluency course (Anthropic)', 'AI Fluency: Framework & Foundations — 4 hours, 15 lessons.', 'internal', 'training', 'todo', 'high', iId, '2026-04-30', 'course,training,onboarding', 'system');
    ins.run(uuid(), 'Complete Building with Claude API course', 'Building with Claude API — 6 hours, 20 lessons.', 'internal', 'training', 'backlog', 'medium', iId, '2026-05-15', 'course,training,onboarding', 'system');

    // ─── Client-facing tickets (seed examples) ───
    ins.run(uuid(), 'Prepare AI Readiness Assessment framework', 'Expand Form2 (5-dimension assessment) into full 20-30 question framework for client engagements.', 'client', 'delivery', 'in_progress', 'high', mId, '2026-04-20', 'ai-bridge,assessment', 'system');
    ins.run(uuid(), 'Build automated scoring rubric', 'Create weighted scoring model in Python or spreadsheet. Leverage existing 1-5 scale from Form2.', 'client', 'delivery', 'backlog', 'high', mId, '2026-04-30', 'ai-bridge,assessment', 'system');
    ins.run(uuid(), 'Design branded PDF report template', 'Use Prism Brand Guidelines to design assessment output report with visuals.', 'client', 'delivery', 'backlog', 'medium', mId, '2026-05-15', 'ai-bridge,branding', 'system');
  });

  batch();
  console.log('Tickets seeded: action items, training, and delivery tasks');
}

seedIfEmpty();
seedUsersIfEmpty();
seedInventory();
seedTickets();

// ─── External Service Initialization ───────────────────────────────────────
stripeService.init();
qboService.init(db);

// ─── Benchmark Products Seed ────────────────────────────────────────────────
function seedBenchmarkProducts() {
  const count = db.prepare('SELECT COUNT(*) as n FROM benchmark_products').get().n;
  if (count > 0) return;

  const ins = db.prepare(`INSERT INTO benchmark_products
    (product_name, vendor, version, category, subcategory,
     cis_benchmark, cis_benchmark_version, disa_stig, disa_stig_id,
     discovery_method, drift_detection_capability, drift_detection_details,
     external_tools_needed, architecture_type, automation_ceiling,
     service_approach, applicable_frameworks, notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  const products = [
    // ── Cloud Providers ──────────────────────────────────────────────────────
    ['Amazon Web Services (AWS)','Amazon','Foundations 3.0','Cloud','Public Cloud',
     'yes','v3.0.0','yes','AWS STIG',
     'AWS Organizations, AWS Config, AWS CLI (aws ec2 describe-instances), CSPM tools',
     'built_in','AWS Config Rules + Security Hub continuously evaluate resource configs against baselines. AWS Config records config changes with timeline.',
     'Native tools sufficient; CSPM (Wiz, Prisma Cloud) for cross-cloud correlation','managed','full',
     'Configure and tune AWS Config Rules, Security Hub standards, and GuardDuty. Build cross-account compliance dashboards.',
     'CIS,DISA STIG,FedRAMP,HIPAA,PCI-DSS,SOC 2,NIST 800-53,CMMC','Market leader in cloud compliance tooling'],

    ['Microsoft Azure','Microsoft','Foundations 3.0','Cloud','Public Cloud',
     'yes','v3.0.0','yes','Azure STIG',
     'Azure Resource Graph, Azure CLI (az resource list), Microsoft Defender for Cloud, CSPM tools',
     'built_in','Microsoft Defender for Cloud continuously assesses against CIS benchmarks and regulatory standards. Azure Policy enforces desired state with auto-remediation.',
     'Native tools sufficient; CSPM for multi-cloud','managed','full',
     'Configure Defender for Cloud regulatory compliance, Azure Policy initiatives, and Sentinel alerting.',
     'CIS,DISA STIG,FedRAMP,HIPAA,PCI-DSS,SOC 2,NIST 800-53,CMMC','Strong native compliance suite'],

    ['Google Cloud Platform (GCP)','Google','Foundations 3.0','Cloud','Public Cloud',
     'yes','v3.0.0','yes','GCP STIG',
     'GCP Asset Inventory, gcloud CLI, Security Command Center, CSPM tools',
     'built_in','Security Command Center (SCC) Premium provides continuous compliance monitoring against CIS benchmarks. Organization Policy Service enforces constraints.',
     'Native SCC sufficient; CSPM for multi-cloud','managed','full',
     'Configure SCC Premium compliance module, Organization Policies, and BigQuery audit log exports.',
     'CIS,DISA STIG,FedRAMP,HIPAA,PCI-DSS,SOC 2,NIST 800-53','SCC Premium required for full CIS coverage'],

    ['DigitalOcean','DigitalOcean','Foundations 1.0','Cloud','Public Cloud',
     'yes','v1.0.0 (2025)','no',null,
     'DigitalOcean API (doctl compute droplet list), Cloud Console inventory',
     'limited','Basic monitoring and alerting. No native CIS benchmark scanning or configuration baseline comparison.',
     'Third-party CSPM, OpenSCAP on droplets, custom API scripting','managed','partial',
     'Deploy scanning agents on droplets, build custom compliance checks via API, implement FIM.',
     'CIS,SOC 2','New benchmark released 2025; limited native compliance tooling'],

    ['Tencent Cloud','Tencent','Foundations 1.0','Cloud','Public Cloud',
     'yes','v1.0.0','no',null,
     'Tencent Cloud API (DescribeInstances), Cloud Console, Cloud Workload Protection (CWP)',
     'limited','Cloud Workload Protection has basic baseline checks. Less mature than AWS Config/Azure Policy.',
     'Third-party CSPM with Tencent connector, custom API scripting','managed','partial',
     'Deploy CWP agents, build custom compliance validation via Tencent API, integrate with CSPM platform.',
     'CIS','Immature compliance ecosystem compared to AWS/Azure/GCP'],

    // ── Operating Systems — Server ───────────────────────────────────────────
    ['Windows Server 2025','Microsoft','2025','OS','Server',
     'yes','v1.0.0 (2025)','yes','Windows Server 2025 STIG',
     'Active Directory, SCCM/Intune, PowerShell (Get-ComputerInfo), network scanning',
     'limited','Group Policy with RSOP reporting. Windows Security Compliance Toolkit provides baselines. No continuous drift detection natively.',
     'CIS-CAT Pro, PowerSTIG, SCCM compliance, third-party FIM','traditional','full',
     'Apply CIS/STIG GPOs, deploy PowerSTIG for validation, configure FIM for continuous monitoring.',
     'CIS,DISA STIG,CMMC,FedRAMP,HIPAA,PCI-DSS,NIST 800-53','New benchmark 2025; PowerSTIG support expected'],

    ['Windows Server 2022','Microsoft','2022','OS','Server',
     'yes','v2.0.0','yes','Windows Server 2022 STIG',
     'Active Directory, SCCM/Intune, PowerShell, network scanning',
     'limited','Group Policy with RSOP. Security Compliance Toolkit baselines available.',
     'CIS-CAT Pro, PowerSTIG, SCCM compliance, FIM tools','traditional','full',
     'Apply CIS/STIG GPOs, deploy PowerSTIG, configure continuous monitoring with FIM.',
     'CIS,DISA STIG,CMMC,FedRAMP,HIPAA,PCI-DSS,NIST 800-53','Mature benchmark and STIG coverage'],

    ['Windows Server 2019','Microsoft','2019','OS','Server',
     'yes','v2.0.0','yes','Windows Server 2019 STIG',
     'Active Directory, SCCM/Intune, PowerShell, network scanning',
     'limited','Group Policy with RSOP. Security Compliance Toolkit baselines available.',
     'CIS-CAT Pro, PowerSTIG, SCCM compliance, FIM tools','traditional','full',
     'Apply CIS/STIG GPOs, deploy PowerSTIG, configure continuous monitoring with FIM.',
     'CIS,DISA STIG,CMMC,FedRAMP,HIPAA,PCI-DSS,NIST 800-53','Still widely deployed; approaching end-of-mainstream support'],

    ['Red Hat Enterprise Linux 10','Red Hat','10','OS','Server',
     'yes','v1.0.0 (2025)','yes','RHEL 10 STIG',
     'Red Hat Satellite/Insights, SSH banner, subscription-manager, network scanning',
     'limited','Red Hat Insights compliance service checks against OpenSCAP profiles. RHEL has built-in OpenSCAP scanner (oscap).',
     'OpenSCAP, Red Hat Satellite, Ansible playbooks, CIS-CAT Pro','traditional','full',
     'Deploy OpenSCAP profiles, configure Satellite compliance policies, build Ansible remediation playbooks.',
     'CIS,DISA STIG,CMMC,FedRAMP,HIPAA,PCI-DSS,NIST 800-53','New benchmark 2025; strong OpenSCAP integration'],

    ['Red Hat Enterprise Linux 9','Red Hat','9','OS','Server',
     'yes','v2.0.0','yes','RHEL 9 STIG',
     'Red Hat Satellite/Insights, SSH banner, subscription-manager, network scanning',
     'limited','Red Hat Insights compliance + OpenSCAP (oscap) built-in.',
     'OpenSCAP, Red Hat Satellite, Ansible playbooks, CIS-CAT Pro','traditional','full',
     'Deploy OpenSCAP profiles, configure Satellite compliance, Ansible remediation.',
     'CIS,DISA STIG,CMMC,FedRAMP,HIPAA,PCI-DSS,NIST 800-53','Mature CIS + STIG coverage'],

    ['Red Hat Enterprise Linux 8','Red Hat','8','OS','Server',
     'yes','v3.0.0','yes','RHEL 8 STIG',
     'Red Hat Satellite/Insights, SSH banner, subscription-manager, network scanning',
     'limited','Red Hat Insights compliance + OpenSCAP built-in.',
     'OpenSCAP, Red Hat Satellite, Ansible playbooks, CIS-CAT Pro','traditional','full',
     'Deploy OpenSCAP profiles, Ansible remediation playbooks, FIM for drift.',
     'CIS,DISA STIG,CMMC,FedRAMP,HIPAA,PCI-DSS,NIST 800-53','Widely deployed; approaching maintenance phase'],

    ['Ubuntu Linux','Canonical','24.04 LTS','OS','Server',
     'yes','v1.0.0','yes','Ubuntu STIG',
     'Landscape, SSH banner, apt package queries, network scanning',
     'limited','Ubuntu Pro includes USG (Ubuntu Security Guide) with CIS/DISA profile auto-apply and check.',
     'OpenSCAP, CIS-CAT Pro, Ansible, Ubuntu Pro USG','traditional','full',
     'Deploy USG profiles (Ubuntu Pro), OpenSCAP scanning, Ansible remediation.',
     'CIS,DISA STIG,FedRAMP,HIPAA,SOC 2,NIST 800-53','Ubuntu Pro USG provides strong native CIS/STIG tooling'],

    ['Debian Linux','Debian Project','12','OS','Server',
     'yes','v1.0.0','yes','Debian STIG',
     'SSH banner, dpkg/apt queries, network scanning',
     'none','No built-in compliance or drift detection features.',
     'OpenSCAP, CIS-CAT Pro, Ansible, FIM tools','traditional','full',
     'Build OpenSCAP profiles, Ansible hardening playbooks, deploy FIM agents.',
     'CIS,DISA STIG,HIPAA,SOC 2,NIST 800-53','Community-maintained; less enterprise tooling than RHEL/Ubuntu'],

    ['SUSE Linux Enterprise','SUSE','15','OS','Server',
     'yes','v1.0.0','yes','SLES STIG',
     'SUSE Manager, SSH banner, zypper queries, network scanning',
     'limited','SUSE Manager provides compliance checking with OpenSCAP integration.',
     'OpenSCAP, SUSE Manager, CIS-CAT Pro, Ansible','traditional','full',
     'Configure SUSE Manager compliance policies, OpenSCAP profiles, Ansible playbooks.',
     'CIS,DISA STIG,HIPAA,PCI-DSS,NIST 800-53','Strong in SAP and enterprise Linux environments'],

    ['Rocky Linux 10','Rocky Enterprise Software Foundation','10','OS','Server',
     'yes','v1.0.0 (2025)','no',null,
     'SSH banner, dnf/rpm queries, network scanning',
     'none','No built-in compliance tools. Compatible with RHEL OpenSCAP profiles.',
     'OpenSCAP (RHEL profiles compatible), CIS-CAT Pro, Ansible','traditional','full',
     'Apply RHEL-compatible OpenSCAP profiles, Ansible hardening, FIM.',
     'CIS,HIPAA,SOC 2,NIST 800-53','New benchmark 2025; RHEL binary-compatible'],

    ['AlmaLinux OS 10','AlmaLinux OS Foundation','10','OS','Server',
     'yes','v1.0.0 (2025)','no',null,
     'SSH banner, dnf/rpm queries, network scanning',
     'none','No built-in compliance tools. Compatible with RHEL OpenSCAP profiles.',
     'OpenSCAP (RHEL profiles compatible), CIS-CAT Pro, Ansible','traditional','full',
     'Apply RHEL-compatible OpenSCAP profiles, Ansible hardening, FIM.',
     'CIS,HIPAA,SOC 2,NIST 800-53','New benchmark 2025; RHEL binary-compatible'],

    ['Oracle Linux','Oracle','9','OS','Server',
     'yes','v1.0.0','yes','Oracle Linux STIG',
     'SSH banner, dnf/rpm queries, Oracle Enterprise Manager, network scanning',
     'limited','Ksplice for live patching. OpenSCAP compatible.',
     'OpenSCAP, CIS-CAT Pro, Ansible, Oracle Enterprise Manager','traditional','full',
     'Deploy OpenSCAP profiles, Ansible remediation, integrate with Oracle EM for monitoring.',
     'CIS,DISA STIG,HIPAA,PCI-DSS,NIST 800-53','Strong in Oracle DB environments'],

    ['Amazon Linux 2023','Amazon','2023','OS','Server',
     'yes','v1.0.0','yes','Amazon Linux 2 STIG',
     'AWS SSM inventory, SSH banner, EC2 instance metadata, AWS Config',
     'limited','AWS SSM Patch Manager and State Manager can enforce configurations. AWS Inspector scans.',
     'AWS SSM, Inspector, CIS-CAT Pro, Ansible','traditional','full',
     'Configure SSM State Manager documents, Inspector scans, Ansible hardening.',
     'CIS,DISA STIG,FedRAMP,HIPAA,NIST 800-53','Tightly integrated with AWS ecosystem'],

    // ── Operating Systems — Desktop ──────────────────────────────────────────
    ['Windows 11 Enterprise','Microsoft','24H2','OS','Desktop',
     'yes','v3.0.0','yes','Windows 11 STIG',
     'Active Directory, Intune/SCCM, PowerShell, endpoint agents',
     'limited','Intune compliance policies + Group Policy RSOP. Windows Security Compliance Toolkit.',
     'CIS-CAT Pro, Intune compliance, PowerSTIG, endpoint agents','traditional','full',
     'Intune compliance policies for cloud-managed, GPO for domain-joined, PowerSTIG validation.',
     'CIS,DISA STIG,CMMC,HIPAA,PCI-DSS,NIST 800-53','High volume; Intune + GPO hybrid common'],

    ['Windows 10 Enterprise','Microsoft','22H2','OS','Desktop',
     'yes','v3.0.0','yes','Windows 10 STIG',
     'Active Directory, Intune/SCCM, PowerShell, endpoint agents',
     'limited','Intune compliance policies + GPO RSOP.',
     'CIS-CAT Pro, Intune, PowerSTIG, endpoint agents','traditional','full',
     'Intune compliance policies, GPO hardening, PowerSTIG validation.',
     'CIS,DISA STIG,CMMC,HIPAA,PCI-DSS,NIST 800-53','Still widely deployed; approaching end-of-support Oct 2025'],

    ['macOS (Sequoia)','Apple','15','OS','Desktop',
     'yes','v1.0.0','yes','macOS STIG',
     'Jamf Pro, Mosyle, Kandji, Apple Business Manager, MDM enrollment',
     'limited','MDM profiles enforce settings. Jamf Compliance Editor maps CIS/STIG rules to configuration profiles. mSCP project provides baseline scripts.',
     'Jamf Pro + Compliance Editor, mSCP scripts, CIS-CAT Pro, Mosyle','traditional','partial',
     'Deploy mSCP baseline scripts via MDM, Jamf Compliance Editor for CIS/STIG profiles, custom compliance checks.',
     'CIS,DISA STIG,HIPAA,SOC 2,NIST 800-53','mSCP (macOS Security Compliance Project) is key open-source tool'],

    // ── Operating Systems — Specialized ──────────────────────────────────────
    ['Bottlerocket','Amazon','1.x','OS','Specialized',
     'yes','v1.0.0','no',null,
     'AWS SSM inventory, ECS/EKS node AMI metadata, apiclient on host',
     'immutable','Read-only root filesystem. Atomic image updates. Drift is architecturally prevented — OS cannot be modified at runtime.',
     'Validate AMI/image hardening before deployment; no runtime drift monitoring needed','immutable','full',
     'Harden the image/config before deployment. Validate with CIS-CAT, not monitor at runtime.',
     'CIS,FedRAMP,HIPAA,SOC 2','Immutable OS; drift prevention by design'],

    ['Talos Linux','Sidero Labs','1.x','OS','Specialized',
     'yes','v1.0.0','no',null,
     'talosctl get members, Kubernetes node labels, API-only discovery (no SSH)',
     'immutable','No SSH, no shell. Entire config is declarative via machine configs. talosctl compares current state to declared desired state.',
     'Validate machine config before deployment; talosctl for state comparison','immutable','full',
     'Harden machine config definitions. Validate with talosctl, not runtime agents.',
     'CIS,SOC 2','Immutable API-only OS; no shell access'],

    ['Wind River eLxr 12','Wind River','12','OS','Specialized',
     'no',null,'no',null,
     'Asset management/CMDB, SNMP, network scanning (Nmap OS fingerprint), Wind River Studio',
     'none','No native compliance or drift features. Embedded/real-time Linux.',
     'OpenSCAP, custom scripts, vendor-specific hardening validation, FIM','traditional','manual_heavy',
     'Custom hardening scripts, manual validation against vendor guidelines, FIM deployment.',
     'NIST 800-53','No CIS/STIG coverage; embedded/real-time use case'],

    ['Anduril NixOS','Anduril/NixOS','23.11+','OS','Specialized',
     'no',null,'no',null,
     'NixOps fleet inventory, nixos-version, Anduril Lattice platform API',
     'immutable','System state defined in .nix files. nixos-rebuild detects divergence from declared config. Not security-baseline-aware but config drift is inherently visible.',
     'Custom Nix-based compliance modules, security scanning of Nix configs','declarative','partial',
     'Validate Nix configurations against security baselines. Build custom compliance checks for declared state.',
     'NIST 800-53','Declarative/immutable; no CIS/STIG yet; defense sector use'],

    // ── Operating Systems — Legacy/Enterprise ────────────────────────────────
    ['IBM AIX 7','IBM','7.3','OS','Legacy',
     'yes','v1.0.0','yes','AIX STIG',
     'HMC (Hardware Management Console) inventory, oslevel via SSH, CMDB, PowerVC',
     'audit_log_only','Security Expert tool sets hardening levels (Low/Medium/High). trustchk validates trusted computing base. Audit subsystem tracks changes.',
     'OpenSCAP (limited), custom scripts, Ansible for AIX, FIM','traditional','partial',
     'Security Expert initial hardening, custom audit scripts, Ansible playbooks for ongoing validation.',
     'CIS,DISA STIG,CMMC,HIPAA,PCI-DSS,NIST 800-53','Legacy platform; requires specialized AIX expertise'],

    ['IBM i (V7R4/V7R5)','IBM','V7R5','OS','Legacy',
     'yes','v1.0.0','yes','IBM i STIG',
     'IBM Navigator for i, DSPSFWRSC command, HMC, IBM i Access Client',
     'audit_log_only','SECCHK command audits security settings. System values compared to standards. Audit journal (QAUDJRN) tracks changes.',
     'Custom CL/RPG programs, IBM i security tools (Powertech, Assure), manual review','traditional','manual_heavy',
     'SECCHK baseline validation, custom audit programs, third-party IBM i security tools.',
     'CIS,DISA STIG,HIPAA,PCI-DSS,NIST 800-53','Niche platform; very few practitioners available'],

    // ── Mobile ───────────────────────────────────────────────────────────────
    ['Apple iOS/iPadOS 18','Apple','18','Mobile','Smartphone/Tablet',
     'yes','v1.0.0 (2025, Intune)','yes','Apple iOS STIG',
     'MDM enrollment (Jamf, Mosyle, Intune), Apple Business Manager, Apple Configurator',
     'limited','MDM platforms enforce and monitor configuration profiles continuously. Intune compliance policies flag non-compliant devices.',
     'Jamf Pro, Intune, Mosyle, Apple Configurator, CIS-CAT Pro','managed','partial',
     'Deploy CIS-aligned MDM profiles, Intune/Jamf compliance policies, automated remediation via MDM.',
     'CIS,DISA STIG,HIPAA,NIST 800-53','New CIS benchmark for Intune released 2025'],

    ['Motorola/Honeywell Android 13','Motorola/Honeywell','13','Mobile','Ruggedized',
     'yes','v1.0.0','yes','Android STIG',
     'MDM platform (SOTI, Ivanti, VMware WS1), Google Endpoint Management, Honeywell Operational Intelligence',
     'none','Device has no self-drift detection. MDM platform handles policy enforcement.',
     'MDM platform (SOTI, WS1, Intune) enforces and monitors policy compliance','managed','partial',
     'Deploy MDM profiles aligned to CIS/STIG, configure compliance policies, automated wipe/lock on violation.',
     'CIS,DISA STIG,HIPAA,NIST 800-53','Ruggedized devices; SOTI or Honeywell OI for fleet management'],

    // ── Containers / Orchestration ───────────────────────────────────────────
    ['Docker','Docker Inc.','27.x','Container','Runtime',
     'yes','v1.7.0','yes','Docker STIG',
     'docker info, docker ps, container runtime inspection, Kubernetes node inventory',
     'none','No built-in compliance scanning. Docker Scout provides vulnerability scanning but not CIS compliance.',
     'Docker Bench for Security (CIS script), Aqua, Prisma Cloud, Sysdig, OpenSCAP','traditional','full',
     'Run Docker Bench for Security, deploy Aqua/Prisma runtime agents, Ansible hardening for daemon config.',
     'CIS,DISA STIG,SOC 2,PCI-DSS,NIST 800-53','Docker Bench for Security is the standard CIS validation tool'],

    ['Kubernetes','CNCF','1.31','Container','Orchestration',
     'yes','v1.9.0','yes','Kubernetes STIG',
     'kubectl get nodes, Kubernetes API, cloud provider console (EKS/AKS/GKE)',
     'limited','OPA/Gatekeeper enforces admission policies. Kube-bench (Aqua) scans against CIS. No native benchmark scanner.',
     'kube-bench, OPA Gatekeeper, Falco, Aqua, Prisma Cloud, Sysdig','declarative','full',
     'Deploy kube-bench scans, OPA Gatekeeper policies, Falco runtime monitoring, CIS-aligned admission controllers.',
     'CIS,DISA STIG,SOC 2,PCI-DSS,NIST 800-53','kube-bench is de facto CIS scanner; managed K8s (EKS/AKS/GKE) may limit control-plane checks'],

    // ── Databases ────────────────────────────────────────────────────────────
    ['Oracle Database 23ai','Oracle','23ai','Database','Relational',
     'yes','v1.0.0 (2025)','yes','Oracle DB STIG',
     'Oracle Enterprise Manager, tnsnames.ora scan, port scan (1521), CMDB',
     'limited','Oracle Audit Vault and Database Firewall tracks changes. Enterprise Manager provides some compliance checking.',
     'CIS-CAT Pro, Oracle Audit Vault, DBSAT (Database Security Assessment Tool), custom SQL scripts','traditional','partial',
     'Deploy DBSAT for assessment, configure Audit Vault, custom SQL compliance scripts, Oracle EM monitoring.',
     'CIS,DISA STIG,HIPAA,PCI-DSS,SOC 2,NIST 800-53','New benchmark 2025; Oracle DBSAT is free assessment tool'],

    ['Microsoft SQL Server','Microsoft','2022','Database','Relational',
     'yes','v1.0.0','yes','SQL Server STIG',
     'SQL Server Management Studio, port scan (1433), Active Directory, SCCM',
     'limited','SQL Server Audit feature tracks changes. Vulnerability Assessment in SSMS scans against baselines.',
     'CIS-CAT Pro, PowerSTIG, SQL Vulnerability Assessment, custom T-SQL scripts','traditional','full',
     'SSMS Vulnerability Assessment, PowerSTIG SQL modules, custom T-SQL compliance checks, audit configuration.',
     'CIS,DISA STIG,HIPAA,PCI-DSS,SOC 2,NIST 800-53','Good native assessment tooling via SSMS'],

    ['PostgreSQL','PostgreSQL Global Development Group','16','Database','Relational',
     'yes','v1.0.0','yes','PostgreSQL STIG',
     'Port scan (5432), pg_isready, service discovery, CMDB',
     'none','No built-in compliance scanning. PostgreSQL has audit logging extensions (pgAudit) but no baseline comparison.',
     'CIS-CAT Pro, OpenSCAP, pgAudit extension, custom SQL scripts, Ansible','traditional','full',
     'Deploy pgAudit, CIS-CAT scanning, custom SQL compliance checks, Ansible hardening playbooks.',
     'CIS,DISA STIG,HIPAA,PCI-DSS,SOC 2,NIST 800-53','pgAudit extension essential for compliance logging'],

    ['MySQL','Oracle','8.4','Database','Relational',
     'yes','v1.0.0','yes','MySQL STIG',
     'Port scan (3306), mysql --version, service discovery, CMDB',
     'none','No built-in compliance features. Enterprise Edition has audit plugin.',
     'CIS-CAT Pro, MySQL Enterprise Audit, custom SQL scripts, Ansible','traditional','full',
     'Deploy audit plugin (Enterprise) or MariaDB Audit Plugin, CIS-CAT scanning, Ansible hardening.',
     'CIS,DISA STIG,HIPAA,PCI-DSS,SOC 2,NIST 800-53','Enterprise vs Community licensing affects audit capabilities'],

    ['MongoDB','MongoDB Inc.','7.x','Database','NoSQL',
     'yes','v1.0.0','yes','MongoDB STIG',
     'Port scan (27017), mongosh, service discovery, CMDB, MongoDB Atlas console',
     'none','No built-in CIS compliance. MongoDB Atlas has some security configuration recommendations.',
     'CIS-CAT Pro, custom mongosh scripts, Ansible, MongoDB Atlas security features','traditional','partial',
     'Custom mongosh compliance scripts, CIS-CAT scanning, Ansible hardening, Atlas security configuration.',
     'CIS,DISA STIG,HIPAA,PCI-DSS,SOC 2,NIST 800-53','Atlas vs self-hosted changes the scope significantly'],

    ['IBM Db2 12.1','IBM','12.1','Database','Relational',
     'yes','v1.0.0','yes','Db2 STIG',
     'db2ls on host, port scan (50000), CMDB, db2licm -l',
     'audit_log_only','db2audit tracks security events. Security plugins enforce policies. Data governance tools available.',
     'CIS-CAT Pro, custom SQL scripts, db2audit configuration, Ansible','traditional','partial',
     'Configure db2audit, custom SQL compliance scripts, Ansible hardening, manual review of authorization settings.',
     'CIS,DISA STIG,HIPAA,PCI-DSS,NIST 800-53','Niche expertise required; fewer practitioners available'],

    ['Apache Cassandra 5.0','Apache Software Foundation','5.0','Database','NoSQL',
     'yes','v1.0.0','no',null,
     'Port scan (9042 CQL, 7199 JMX), nodetool status, service discovery (Consul/K8s)',
     'none','File-based config (cassandra.yaml). No compliance features.',
     'FIM on config files, Ansible/Chef desired-state enforcement, custom validation scripts','traditional','manual_heavy',
     'FIM on cassandra.yaml, Ansible desired-state playbooks, custom cqlsh compliance scripts.',
     'CIS,HIPAA,SOC 2','No DISA STIG; limited tooling ecosystem'],

    ['SingleStore','SingleStore Inc.','8.x','Database','NewSQL',
     'no',null,'no',null,
     'Port scan (3306), SingleStore Studio, Kubernetes service labels, cloud marketplace logs',
     'none','No compliance or drift features.',
     'Custom SQL scripts, FIM, Ansible desired-state enforcement','traditional','manual_heavy',
     'Custom security validation scripts, FIM on config, Ansible hardening, manual baseline documentation.',
     'HIPAA,SOC 2','No CIS/STIG coverage; apply general database hardening principles'],

    ['YugabyteDB','Yugabyte Inc.','2.x','Database','NewSQL',
     'no',null,'no',null,
     'Port scan (5433/9042), yb-admin, Kubernetes service labels, cloud marketplace logs',
     'none','No compliance or drift features.',
     'Custom SQL scripts, FIM, Ansible desired-state enforcement','traditional','manual_heavy',
     'Custom security validation scripts, FIM on config, Ansible hardening, manual baseline documentation.',
     'HIPAA,SOC 2','No CIS/STIG coverage; PostgreSQL-compatible so some PG controls may apply'],

    // ── Network Devices ──────────────────────────────────────────────────────
    ['Cisco IOS XE','Cisco','17.x','Network','Router/Switch',
     'yes','v2.0.0','yes','Cisco IOS XE STIG',
     'SNMP, CDP/LLDP neighbor tables, Cisco DNA Center, Cisco Prime, network scanning',
     'limited','Cisco DNA Center provides compliance checking against golden configs. Smart Licensing tracks deployments.',
     'CIS-CAT Pro, Cisco DNA Center, Ansible (cisco.ios collection), OpenSCAP, custom scripts','appliance','full',
     'Configure DNA Center compliance policies, Ansible network automation playbooks, CIS-CAT scanning.',
     'CIS,DISA STIG,CMMC,HIPAA,PCI-DSS,NIST 800-53','Dominant network platform; strong Ansible automation support'],

    ['FortiGate 7.4.x','Fortinet','7.4','Network','Firewall',
     'yes','v1.0.0 (2025)','yes','FortiGate STIG',
     'FortiManager, FortiAnalyzer, SNMP, Nmap service detection, FortiCloud',
     'limited','FortiManager provides config revision history and compliance checking. FortiAnalyzer tracks changes.',
     'CIS-CAT Pro, FortiManager, Ansible (fortinet.fortios collection), custom API scripts','appliance','partial',
     'FortiManager compliance baselines, Ansible hardening playbooks, CIS-CAT scanning.',
     'CIS,DISA STIG,HIPAA,PCI-DSS,NIST 800-53','New CIS benchmark 2025'],

    ['Check Point Firewall','Check Point','R81.x','Network','Firewall',
     'archived',null,'yes','Check Point STIG',
     'SmartConsole/Management Server API, SNMP, Nmap service detection',
     'built_in','Compliance Blade checks running config against CIS best practices and regulatory templates (PCI, HIPAA, NIST). Continuous monitoring with alerts.',
     'SmartConsole Compliance Blade (built-in), custom API scripts','appliance','partial',
     'Configure Compliance Blade policies, custom SmartConsole API monitoring, STIG validation scripts.',
     'DISA STIG,HIPAA,PCI-DSS,NIST 800-53','CIS benchmark archived mid-2025 due to lack of SME support'],

    ['F5 Networks (BIG-IP)','F5 Networks','17.x','Network','ADC/Load Balancer',
     'yes','v1.0.0','yes','F5 BIG-IP STIG',
     'BIG-IP iControl REST API, SNMP, F5 BIG-IQ centralized management',
     'built_in','BIG-IQ provides config diff against stored baselines, change tracking, and audit comparison across device fleet.',
     'BIG-IQ (requires separate license), Ansible (f5networks.f5_modules), custom iControl scripts','appliance','partial',
     'Configure BIG-IQ baseline monitoring, Ansible automation, iControl REST compliance scripts.',
     'CIS,DISA STIG,HIPAA,PCI-DSS,NIST 800-53','BIG-IQ required for drift detection; standalone BIG-IP only has audit logs'],

    ['Arista MLS EOS 4.X','Arista Networks','4.x','Network','Switch',
     'yes','v1.0.0','yes','Arista STIG',
     'Arista CloudVision (CVP), eAPI, SNMP, LLDP/CDP neighbor tables',
     'built_in','CloudVision (CVP) compares running configs against configlet-defined baselines. Flags deviations, supports rollback.',
     'CloudVision (CVP, separate license), Ansible (arista.eos collection), custom eAPI scripts','appliance','full',
     'Configure CVP configlets as compliance baselines, Ansible playbooks, eAPI compliance scripts.',
     'CIS,DISA STIG,HIPAA,PCI-DSS,NIST 800-53','CVP required for drift detection; without it no native baseline comparison'],

    ['Juniper JunOS','Juniper Networks','23.x','Network','Router/Switch',
     'archived',null,'yes','Juniper STIG',
     'Junos Space, SNMP, NETCONF/YANG, network scanning',
     'limited','Junos Space provides config comparison. Commit confirmed model allows rollback.',
     'Junos Space, Ansible (junipernetworks.junos collection), OpenConfig/NETCONF scripts','appliance','partial',
     'Ansible network automation, Junos Space compliance, NETCONF-based config validation.',
     'DISA STIG,HIPAA,PCI-DSS,NIST 800-53','CIS benchmark archived mid-2025; STIG still maintained'],

    ['Sophos Firewall v21/v22','Sophos','21/22','Network','Firewall',
     'no',null,'no',null,
     'Sophos Central cloud console, SNMP, Sophos Firewall API',
     'audit_log_only','Sophos Central shows config changes and security status. Audit logs available.',
     'Custom API scripts, FIM, Ansible automation, manual baseline comparison','appliance','manual_heavy',
     'Custom Sophos API compliance scripts, manual baseline documentation, FIM on config backups.',
     'HIPAA,PCI-DSS','No CIS/STIG coverage; apply general firewall hardening principles'],

    ['pfSense','Netgate','2.7.x','Network','Firewall',
     'no',null,'no',null,
     'Network scan + web UI fingerprint, SNMP, FauxAPI',
     'none','No baseline feature. Config backup/restore only.',
     'External FIM, git-tracked config exports (XML), custom scripts, FauxAPI monitoring','appliance','manual_heavy',
     'Git-track XML config exports, FIM on config files, custom FauxAPI compliance scripts.',
     'PCI-DSS','No CIS/STIG; open-source firewall; community hardening guides only'],

    ['OPNsense','Deciso','24.x','Network','Firewall',
     'no',null,'no',null,
     'Network scan + web UI fingerprint, SNMP, OPNsense API',
     'none','No baseline feature. Config backup/restore only.',
     'External FIM, git-tracked config exports (XML), custom scripts, OPNsense API','appliance','manual_heavy',
     'Git-track XML config exports, FIM on config files, custom API compliance scripts.',
     'PCI-DSS','No CIS/STIG; open-source firewall; community hardening guides only'],

    ['Infoblox 8.x DNS','Infoblox','8.x','Network','DNS/DHCP/IPAM',
     'no',null,'no',null,
     'Infoblox Grid Manager, WAPI (REST), SNMP',
     'audit_log_only','Grid Manager tracks config changes with audit trail. Can compare member configs.',
     'Custom WAPI scripts, FIM, manual baseline comparison','appliance','manual_heavy',
     'Custom WAPI compliance scripts, Grid Manager audit review, manual baseline documentation.',
     'HIPAA,PCI-DSS,NIST 800-53','No CIS/STIG; critical infrastructure component often overlooked'],

    ['Forescout','Forescout Technologies','8.x','Network','NAC/Visibility',
     'no',null,'no',null,
     'Forescout Enterprise Manager console, eyeSight API',
     'built_in','eyeInspect assesses device compliance against defined policies. Detects config changes, flags non-compliant devices, blocks network access on violation.',
     'Forescout is itself a discovery/compliance tool; integrate findings into SIEM/GRC','appliance','partial',
     'Configure Forescout policies aligned to security baselines, integrate with GRC for evidence, custom eyeSight API reporting.',
     'HIPAA,PCI-DSS,NIST 800-53','Forescout is a NAC/visibility tool, not benchmark-aware; policies are custom'],

    // ── Browsers ─────────────────────────────────────────────────────────────
    ['Google Chrome','Google','Enterprise','Browser','Desktop',
     'yes','v2.0.0','yes','Google Chrome STIG',
     'Endpoint agents, SCCM/Intune software inventory, Group Policy, Chrome Browser Cloud Management',
     'limited','Chrome Browser Cloud Management provides policy enforcement and reporting. Group Policy enforces settings.',
     'CIS-CAT Pro, Chrome Browser Cloud Management, Intune/GPO, endpoint agents','managed','full',
     'Deploy Chrome ADMX policies via GPO/Intune, Chrome Browser Cloud Management for reporting.',
     'CIS,DISA STIG,HIPAA,PCI-DSS,NIST 800-53','Managed via GPO/Intune; Cloud Management for unmanaged'],

    ['Mozilla Firefox','Mozilla','ESR','Browser','Desktop',
     'yes','v1.0.0','yes','Firefox STIG',
     'Endpoint agents, SCCM/Intune software inventory, Group Policy, policies.json',
     'none','No built-in compliance monitoring. Managed via Group Policy or policies.json.',
     'CIS-CAT Pro, GPO/Intune, custom scripts checking policies.json, endpoint agents','managed','full',
     'Deploy Firefox GPO templates or policies.json, CIS-CAT validation.',
     'CIS,DISA STIG,HIPAA,NIST 800-53','ESR recommended for enterprise; managed via policies.json or GPO'],

    ['Apple Safari','Apple','18','Browser','Desktop/Mobile',
     'yes','v1.0.0','yes','Safari STIG',
     'MDM software inventory (Jamf, Mosyle), macOS/iOS device management, endpoint agents',
     'none','Browser has no self-monitoring. Configuration managed entirely via MDM profiles.',
     'Jamf Pro, Mosyle, MDM configuration profiles, mSCP scripts','managed','partial',
     'Deploy MDM configuration profiles aligned to CIS/STIG, Jamf compliance reporting.',
     'CIS,DISA STIG,HIPAA,NIST 800-53','Managed exclusively via MDM; no standalone enterprise management'],

    ['Microsoft Edge','Microsoft','Enterprise','Browser','Desktop',
     'yes','v2.0.0','yes','Edge STIG',
     'Endpoint agents, SCCM/Intune software inventory, Group Policy, Edge management service',
     'limited','Intune/GPO enforce and report on policy compliance. Microsoft Edge management service provides cloud-based policy.',
     'CIS-CAT Pro, Intune/GPO, Edge management service, endpoint agents','managed','full',
     'Deploy Edge ADMX policies via GPO/Intune, Edge management service for cloud-managed devices.',
     'CIS,DISA STIG,HIPAA,PCI-DSS,NIST 800-53','Strong Intune integration; mirrors Chrome management model'],

    // ── SaaS / Identity ──────────────────────────────────────────────────────
    ['Microsoft 365','Microsoft','E3/E5','SaaS','Productivity',
     'yes','v3.1.0','yes','Microsoft 365 STIG',
     'Microsoft 365 Admin Center, Microsoft Graph API, Defender for Cloud Apps',
     'built_in','Microsoft Secure Score continuously evaluates tenant config against best practices. Defender for Cloud Apps monitors SaaS security posture.',
     'CIS-CAT Pro, Microsoft Secure Score, Defender for Cloud Apps, custom Graph API scripts','saas','full',
     'Configure Secure Score recommendations, Defender for Cloud Apps policies, CIS-CAT tenant scanning.',
     'CIS,DISA STIG,FedRAMP,HIPAA,PCI-DSS,SOC 2,NIST 800-53','Secure Score provides strong native compliance scoring'],

    ['Google Workspace','Google','Enterprise','SaaS','Productivity',
     'yes','v1.0.0','no',null,
     'Google Admin Console, Google Workspace Admin SDK, Alert Center',
     'limited','Admin Console security dashboard shows posture. Alert Center flags security events. No CIS-aligned baseline scanning.',
     'CIS-CAT Pro, custom Admin SDK scripts, third-party SaaS security (Spin.ai, Adaptive Shield)','saas','partial',
     'Custom Admin SDK compliance scripts, CIS-CAT scanning, third-party SSPM integration.',
     'CIS,HIPAA,SOC 2,NIST 800-53','Weaker native compliance tooling than M365'],

    ['Okta IDaaS','Okta','OIE','SaaS','Identity',
     'no',null,'no',null,
     'Okta Admin API (/api/v1/apps), SSO login page fingerprint, DNS (check for *.okta.com CNAME)',
     'limited','HealthInsight dashboard flags security config issues (weak MFA policies, inactive admins, missing session controls). Scores tenant posture.',
     'Custom Okta API compliance scripts, third-party SSPM (Adaptive Shield, AppOmni)','saas','partial',
     'Configure HealthInsight recommendations, custom API compliance checks, SSPM integration.',
     'HIPAA,SOC 2,NIST 800-53','No CIS/STIG; HealthInsight is periodic posture score, not continuous drift'],

    ['Zoom','Zoom Video Communications','6.x','SaaS','Communications',
     'archived',null,'no',null,
     'Zoom Admin Portal, Zoom API, SSO federation logs',
     'none','No built-in compliance scanning or drift detection.',
     'Custom Zoom API scripts, third-party SaaS security tools','saas','manual_heavy',
     'Custom API compliance scripts, manual configuration review against archived CIS benchmark.',
     'HIPAA,SOC 2','CIS benchmark archived mid-2025 due to lack of SME support'],

    // ── Security / Endpoint Platforms ────────────────────────────────────────
    ['Tanium 7.x','Tanium','7.x','Security Platform','Endpoint',
     'no',null,'yes','Tanium STIG',
     'Tanium Console API; Tanium itself discovers endpoints — query its own inventory',
     'built_in','Tanium Comply module runs CIS and STIG scans on endpoints continuously. Detects drift against benchmark baselines with remediation workflows.',
     'Tanium Comply (separately licensed module); base Tanium does not include compliance scanning','traditional','full',
     'Configure Tanium Comply scan profiles, map to CIS/STIG baselines, build remediation workflows.',
     'DISA STIG,CMMC,HIPAA,PCI-DSS,NIST 800-53','Comply is separately licensed; base platform lacks compliance scanning'],

    ['Dragos Platform 2.x','Dragos Inc.','2.x','Security Platform','OT/ICS',
     'no',null,'no',null,
     'Dragos console, OT network isolation means manual inventory or ICS asset management',
     'audit_log_only','Asset characterization tracks OT device state. Detects anomalous behavior in ICS networks. Baselines are behavioral (traffic patterns), not configuration-level.',
     'Dragos for OT visibility; complement with ICS-specific hardening tools, manual config review','appliance','manual_heavy',
     'Dragos for threat detection, manual OT device hardening, ICS-specific baseline documentation.',
     'NIST 800-82,NIST 800-53','OT/ICS focused; no traditional CIS/STIG; NIST 800-82 for ICS security'],

    ['Xylok Security Suite 20.x','Xylok','20.x','Security Platform','STIG Automation',
     'no',null,'yes','Multiple STIGs',
     'Xylok management console, DISA STIG Viewer integration',
     'built_in','Purpose-built for STIG compliance. Scans, remediates, and monitors drift against DISA STIGs. Continuous monitoring mode.',
     'Xylok is the drift tool; integrate findings into GRC/SIEM for reporting','traditional','full',
     'Configure Xylok scan profiles per STIG, continuous monitoring, integrate with GRC for audit evidence.',
     'DISA STIG,CMMC,NIST 800-53','STIG-only; no CIS Benchmark support; primarily DoD/government'],

    ['Axonius Ax-OS','Axonius','5.x','Security Platform','Asset Management',
     'no',null,'no',null,
     'Axonius is the asset discovery platform — query its own API for asset inventory',
     'built_in','Aggregates compliance state from connected tools. Flags devices that fall out of policy by comparing against defined rules.',
     'Axonius is a meta-layer; it reports what other tools tell it. Only as good as its integrations.','saas','partial',
     'Configure Axonius policy rules, integrate all scanning tools, build compliance dashboards from aggregated data.',
     'HIPAA,SOC 2,NIST 800-53','Axonius discovers and aggregates; does not scan directly'],

    // ── Server Software ──────────────────────────────────────────────────────
    ['Apache HTTP Server','Apache Software Foundation','2.4','Server Software','Web Server',
     'yes','v2.0.0','yes','Apache STIG',
     'Port scan (80/443), httpd -v, process list, service discovery',
     'none','No built-in compliance features. Configuration is file-based.',
     'CIS-CAT Pro, OpenSCAP, FIM on config files, Ansible hardening','traditional','full',
     'CIS-CAT scanning, FIM on httpd.conf, Ansible hardening playbooks, custom config validation.',
     'CIS,DISA STIG,HIPAA,PCI-DSS,NIST 800-53','Widely deployed; straightforward file-based hardening'],

    ['Nginx','F5/Nginx Inc.','1.27','Server Software','Web Server',
     'yes','v2.0.0','no',null,
     'Port scan (80/443), nginx -v, process list, service discovery',
     'none','No built-in compliance features. Configuration is file-based.',
     'CIS-CAT Pro, FIM on config files, Ansible hardening, custom validation scripts','traditional','full',
     'CIS-CAT scanning, FIM on nginx.conf, Ansible hardening playbooks.',
     'CIS,HIPAA,PCI-DSS,SOC 2','Growing market share; no DISA STIG yet'],

    ['Microsoft IIS','Microsoft','10','Server Software','Web Server',
     'yes','v1.0.0','yes','IIS STIG',
     'PowerShell (Get-IISSite), SCCM, port scan (80/443), Windows feature inventory',
     'limited','IIS configuration auditing via PowerShell. Windows Event logs track changes.',
     'CIS-CAT Pro, PowerSTIG, PowerShell compliance scripts, SCCM','traditional','full',
     'PowerSTIG IIS module, CIS-CAT scanning, PowerShell compliance scripts.',
     'CIS,DISA STIG,HIPAA,PCI-DSS,NIST 800-53','Managed via PowerShell; PowerSTIG provides good automation'],

    ['Apache Tomcat','Apache Software Foundation','10','Server Software','Application Server',
     'yes','v1.0.0','yes','Tomcat STIG',
     'Port scan (8080/8443), process list, service discovery, CMDB',
     'none','No built-in compliance features. Configuration is file-based (server.xml, web.xml).',
     'CIS-CAT Pro, FIM on config files, Ansible hardening, custom validation scripts','traditional','full',
     'CIS-CAT scanning, FIM on server.xml/web.xml, Ansible hardening playbooks.',
     'CIS,DISA STIG,HIPAA,PCI-DSS,NIST 800-53','Common in Java enterprise; straightforward XML-based hardening'],

    // ── Multi-function Print Devices ─────────────────────────────────────────
    ['Multi-function Print Devices','Various','Generic','Print','MFP',
     'yes','v1.0.0','yes','MFP STIG',
     'SNMP, network scanning, print management console, CMDB',
     'none','No built-in compliance. Managed via vendor-specific admin consoles.',
     'SNMP monitoring, vendor admin consoles, custom scripts, network FIM','appliance','manual_heavy',
     'SNMP-based compliance checks, vendor console hardening, network segmentation validation.',
     'CIS,DISA STIG,HIPAA,NIST 800-53','Often overlooked; high-risk due to stored documents and network access'],

    // ── Archived / Legacy Products ──────────────────────────────────────────
    ['Microsoft Windows 7 Workstation','Microsoft','7','Windows','Desktop OS',
     'yes','v3.2.0','yes','Windows 7 STIG',
     'Active Directory, SCCM, network scan, WMI query',
     'audit_log_only','Windows Event Logs only. End-of-life; no security updates.',
     'CIS-CAT Pro, SCAP Compliance Checker, PowerSTIG','traditional','full',
     'Legacy — end-of-life Jan 2020. Migration advisory only.',
     'CIS,DISA STIG,NIST 800-53','ARCHIVE — EOL Jan 2020; migration to Win 10/11 recommended'],

    ['Microsoft Windows 8 Enterprise','Microsoft','8','Windows','Desktop OS',
     'yes','v1.0.0','yes','Windows 8 STIG',
     'Active Directory, SCCM, network scan, WMI query',
     'audit_log_only','Windows Event Logs only. End-of-life; no security updates.',
     'CIS-CAT Pro, SCAP Compliance Checker, PowerSTIG','traditional','full',
     'Legacy — end-of-life Jan 2016. Migration advisory only.',
     'CIS,DISA STIG,NIST 800-53','ARCHIVE — EOL Jan 2016; migration to Win 10/11 recommended'],

    ['Microsoft Windows XP','Microsoft','XP','Windows','Desktop OS',
     'yes','v3.1.0','yes','Windows XP STIG',
     'Active Directory, SCCM, network scan, WMI query',
     'none','No compliance features. Extremely end-of-life.',
     'CIS-CAT Pro (legacy), SCAP Compliance Checker','traditional','partial',
     'Legacy — EOL Apr 2014. Immediate migration required.',
     'CIS,DISA STIG','ARCHIVE — EOL Apr 2014; extreme security risk'],

    ['Aliyun Linux (Alibaba Cloud)','Alibaba Cloud','2','Linux','Server OS',
     'yes','v1.0.0','no',null,
     'Alibaba Cloud Console, SSH, cloud inventory API',
     'limited','Alibaba Cloud Security Center provides basic config scanning.',
     'CIS-CAT Pro, OpenSCAP, Ansible hardening','cloud','full',
     'CIS-CAT scanning, OpenSCAP, custom Ansible playbooks for Aliyun Linux.',
     'CIS,SOC 2,ISO 27001','ARCHIVE — Alibaba Cloud Linux, China market focused'],

    ['Linux Mint','Linux Mint','22','Linux','Desktop OS',
     'yes','v1.0.0','no',null,
     'SSH, network scan, CMDB, MDM',
     'none','No built-in compliance features. Based on Ubuntu.',
     'CIS-CAT Pro (Ubuntu mappings), OpenSCAP, Ansible','traditional','full',
     'Use Ubuntu CIS benchmarks as base, customize for Mint-specific config.',
     'CIS','Consumer-focused Linux; enterprise use is rare but growing'],

    ['IBM z/OS','IBM','2.5','Specialized OS','Mainframe',
     'yes','v1.0.0','yes','z/OS STIG',
     'RACF, IBM zSecure, RMF, hardware management console',
     'built_in','RACF provides comprehensive access control and audit. IBM zSecure provides compliance scanning.',
     'IBM zSecure, RACF, CA Compliance Manager','mainframe','partial',
     'RACF hardening, zSecure compliance scanning, SMF audit log analysis.',
     'CIS,DISA STIG,NIST 800-53,PCI-DSS','Mainframe — specialized skills required; high-value targets'],

    ['FreeBSD','FreeBSD Foundation','14','Specialized OS','Server OS',
     'yes','v1.0.0','no',null,
     'SSH, network scan, pkg audit, CMDB',
     'audit_log_only','Basic audit subsystem. No built-in compliance tooling.',
     'CIS-CAT Pro, OpenSCAP (limited), custom scripts, Ansible','traditional','full',
     'CIS-CAT scanning, custom hardening scripts, Ansible playbooks.',
     'CIS,PCI-DSS,SOC 2','ARCHIVE — Niche BSD; limited enterprise tooling'],

    ['Oracle Cloud Infrastructure (OCI)','Oracle','Foundations 2.0','Cloud','Public Cloud',
     'yes','v2.0.0','no',null,
     'OCI CLI, Oracle Cloud Console, Cloud Guard',
     'built_in','Oracle Cloud Guard provides continuous compliance monitoring and auto-remediation.',
     'Cloud Guard, Oracle Data Safe, CIS-CAT Pro','managed','full',
     'Configure Cloud Guard detector/responder recipes, Data Safe assessments.',
     'CIS,SOC 2,ISO 27001,PCI-DSS,HIPAA','Growing cloud provider; strong native compliance for Oracle workloads'],

    ['Snowflake','Snowflake Inc.','Enterprise','Database','Cloud Data Warehouse',
     'yes','v1.0.0','no',null,
     'Snowflake ACCOUNT_USAGE schema, Snowsight console',
     'limited','Account Usage views track login history, query history, access history. Network policies enforce IP restrictions.',
     'Snowflake native views, CIS-CAT Pro, custom SQL compliance checks','saas','partial',
     'CIS benchmark scanning via SQL queries against ACCOUNT_USAGE, network policy hardening.',
     'CIS,SOC 2,HIPAA,PCI-DSS','Cloud-native DW; CIS benchmark is relatively new'],

    ['Microsoft Dynamics 365','Microsoft','Online','SaaS','Business Applications',
     'yes','v1.0.0','no',null,
     'Microsoft 365 Admin Center, Power Platform Admin Center, Azure AD',
     'limited','Inherits Microsoft 365 compliance center capabilities. Audit logging via Purview.',
     'Microsoft Compliance Manager, Purview Audit, Power Platform DLP','saas','partial',
     'Configure Purview compliance policies, Power Platform DLP, security role auditing.',
     'CIS,SOC 2,HIPAA,ISO 27001','Part of M365 ecosystem; compliance via Purview'],

    ['IBM CICS Transaction Server','IBM','6.2','Server Software','Transaction Processing',
     'yes','v1.0.0','yes','CICS STIG',
     'CICS Explorer, CICSPlex SM, RACF, z/OS console',
     'audit_log_only','CICS audit logging and RACF security integration. No built-in drift detection.',
     'IBM zSecure, RACF, CICSPlex SM monitoring','mainframe','partial',
     'RACF-based CICS security hardening, CICSPlex SM monitoring, SMF record analysis.',
     'CIS,DISA STIG,NIST 800-53,PCI-DSS','Mainframe transaction server — specialized IBM skills required'],
  ];

  const tx = db.transaction(() => {
    products.forEach(p => ins.run(...p));
  });
  tx();
  console.log(`Seeded ${products.length} benchmark products`);
}
seedBenchmarkProducts();

// ─── Benchmark Rules Seed (Section Headers) ─────────────────────────────────
function seedBenchmarkRules() {
  const count = db.prepare('SELECT COUNT(*) as n FROM benchmark_rules').get().n;
  if (count > 0) return;

  // Map product names to their benchmark section headers
  // Each entry: [product_name_pattern, source, [[section, subsections...], ...]]
  const sectionMap = {
    // ── Cloud Providers ──
    'Amazon Web Services': { source: 'CIS', sections: [
      'Identity and Access Management', 'Logging', 'Monitoring', 'Networking',
      'Storage', 'Compute', 'Database Services', 'Security Hub'
    ]},
    'Microsoft Azure': { source: 'CIS', sections: [
      'Identity and Access Management', 'Microsoft Defender', 'Storage Accounts',
      'Database Services', 'Logging and Monitoring', 'Networking', 'Virtual Machines',
      'Key Vault', 'App Service'
    ]},
    'Google Cloud Platform': { source: 'CIS', sections: [
      'Identity and Access Management', 'Logging and Monitoring', 'Networking',
      'Virtual Machines', 'Storage', 'Cloud SQL', 'BigQuery', 'Cloud DNS'
    ]},
    'DigitalOcean': { source: 'CIS', sections: [
      'Identity and Access Management', 'Networking', 'Logging and Monitoring',
      'Droplet Configuration', 'Storage', 'Database Clusters'
    ]},
    'Tencent Cloud': { source: 'CIS', sections: [
      'Identity and Access Management', 'Networking', 'Compute', 'Storage',
      'Logging and Monitoring', 'Database Services'
    ]},
    // ── Windows ──
    'Windows Server 2025': { source: 'CIS', sections: [
      'Account Policies', 'Local Policies', 'Event Log', 'Restricted Groups',
      'System Services', 'Registry', 'File System', 'Windows Firewall',
      'Advanced Audit Policy Configuration', 'Administrative Templates'
    ]},
    'Windows Server 2022': { source: 'CIS', sections: [
      'Account Policies', 'Local Policies', 'Event Log', 'Restricted Groups',
      'System Services', 'Registry', 'File System', 'Windows Firewall',
      'Advanced Audit Policy Configuration', 'Administrative Templates'
    ]},
    'Windows Server 2019': { source: 'CIS', sections: [
      'Account Policies', 'Local Policies', 'Event Log', 'Restricted Groups',
      'System Services', 'Registry', 'File System', 'Windows Firewall',
      'Advanced Audit Policy Configuration', 'Administrative Templates'
    ]},
    'Windows 11': { source: 'CIS', sections: [
      'Account Policies', 'Local Policies', 'Event Log', 'System Services',
      'Registry', 'Windows Firewall', 'Advanced Audit Policy Configuration',
      'Administrative Templates', 'BitLocker', 'Windows Defender'
    ]},
    'Windows 10': { source: 'CIS', sections: [
      'Account Policies', 'Local Policies', 'Event Log', 'System Services',
      'Registry', 'Windows Firewall', 'Advanced Audit Policy Configuration',
      'Administrative Templates', 'BitLocker', 'Windows Defender'
    ]},
    // ── Linux ──
    'Red Hat Enterprise Linux 10': { source: 'CIS', sections: [
      'Initial Setup', 'Services', 'Network Configuration', 'Logging and Auditing',
      'Access Authentication and Authorization', 'System Maintenance',
      'Filesystem Configuration', 'Software Updates'
    ]},
    'Red Hat Enterprise Linux 9': { source: 'CIS', sections: [
      'Initial Setup', 'Services', 'Network Configuration', 'Logging and Auditing',
      'Access Authentication and Authorization', 'System Maintenance',
      'Filesystem Configuration', 'Software Updates'
    ]},
    'Red Hat Enterprise Linux 8': { source: 'CIS', sections: [
      'Initial Setup', 'Services', 'Network Configuration', 'Logging and Auditing',
      'Access Authentication and Authorization', 'System Maintenance',
      'Filesystem Configuration', 'Software Updates'
    ]},
    'Ubuntu Linux': { source: 'CIS', sections: [
      'Initial Setup', 'Services', 'Network Configuration', 'Logging and Auditing',
      'Access Authentication and Authorization', 'System Maintenance',
      'Filesystem Configuration', 'AppArmor'
    ]},
    'Debian Linux': { source: 'CIS', sections: [
      'Initial Setup', 'Services', 'Network Configuration', 'Logging and Auditing',
      'Access Authentication and Authorization', 'System Maintenance',
      'Filesystem Configuration', 'AppArmor'
    ]},
    'SUSE Linux': { source: 'CIS', sections: [
      'Initial Setup', 'Services', 'Network Configuration', 'Logging and Auditing',
      'Access Authentication and Authorization', 'System Maintenance',
      'Filesystem Configuration', 'Software Updates'
    ]},
    'Rocky Linux': { source: 'CIS', sections: [
      'Initial Setup', 'Services', 'Network Configuration', 'Logging and Auditing',
      'Access Authentication and Authorization', 'System Maintenance',
      'Filesystem Configuration', 'Software Updates'
    ]},
    'AlmaLinux': { source: 'CIS', sections: [
      'Initial Setup', 'Services', 'Network Configuration', 'Logging and Auditing',
      'Access Authentication and Authorization', 'System Maintenance',
      'Filesystem Configuration', 'Software Updates'
    ]},
    'Oracle Linux': { source: 'CIS', sections: [
      'Initial Setup', 'Services', 'Network Configuration', 'Logging and Auditing',
      'Access Authentication and Authorization', 'System Maintenance',
      'Filesystem Configuration', 'Software Updates'
    ]},
    'Amazon Linux': { source: 'CIS', sections: [
      'Initial Setup', 'Services', 'Network Configuration', 'Logging and Auditing',
      'Access Authentication and Authorization', 'System Maintenance',
      'Filesystem Configuration', 'Software Updates'
    ]},
    'macOS': { source: 'CIS', sections: [
      'Install Updates', 'System Preferences', 'Logging and Auditing',
      'Network Configuration', 'System Access', 'User Accounts',
      'Supplemental', 'Bluetooth', 'FileVault'
    ]},
    // ── Specialized / Legacy OS ──
    'Bottlerocket': { source: 'CIS', sections: [
      'Container Runtime', 'Host Configuration', 'Network Configuration',
      'Filesystem Integrity', 'API Server Configuration', 'Updates and Patching'
    ]},
    'Talos Linux': { source: 'CIS', sections: [
      'Machine Configuration', 'Network Configuration', 'Cluster Configuration',
      'API Access Controls', 'Encryption and Secrets', 'Updates and Patching'
    ]},
    'Wind River': { source: 'custom', sections: [
      'Kernel Hardening', 'Filesystem Permissions', 'Network Configuration',
      'Authentication', 'Logging', 'Real-Time Process Isolation'
    ]},
    'Anduril NixOS': { source: 'custom', sections: [
      'Nix Configuration Integrity', 'Network Configuration', 'Authentication',
      'Filesystem Permissions', 'Service Hardening', 'Update Policy'
    ]},
    'IBM AIX': { source: 'CIS', sections: [
      'Initial Setup', 'Services', 'Network Configuration', 'Logging and Auditing',
      'Access Authentication and Authorization', 'System Maintenance',
      'Trusted Execution', 'File Permissions'
    ]},
    'IBM i': { source: 'CIS', sections: [
      'System Values', 'User Profiles', 'Object Authority', 'Network Security',
      'Auditing', 'Communication Security', 'Program Security', 'Exit Programs'
    ]},
    // ── Mobile ──
    'Apple iOS': { source: 'CIS', sections: [
      'MDM Profile Configuration', 'Passcode Policy', 'Network Configuration',
      'Privacy and Data Protection', 'App Management', 'Restrictions',
      'VPN Configuration', 'Mail and Accounts'
    ]},
    'Motorola': { source: 'CIS', sections: [
      'Device Administration', 'Screen Lock and Authentication', 'Network Configuration',
      'Application Management', 'Encryption', 'Developer Options', 'Logging'
    ]},
    // ── Containers ──
    'Docker': { source: 'CIS', sections: [
      'Host Configuration', 'Docker Daemon Configuration', 'Docker Daemon Configuration Files',
      'Container Images and Build File', 'Container Runtime',
      'Docker Security Operations', 'Docker Swarm Configuration'
    ]},
    'Kubernetes': { source: 'CIS', sections: [
      'Control Plane Components', 'etcd', 'Control Plane Configuration',
      'Worker Nodes', 'Policies', 'Managed Services'
    ]},
    // ── Databases ──
    'Oracle Database': { source: 'CIS', sections: [
      'Installation and Patching', 'Oracle Parameter Settings', 'Oracle Connection and Login',
      'User Account and Privilege', 'Audit and Logging',
      'Network Configuration', 'Backup and Recovery'
    ]},
    'Microsoft SQL Server': { source: 'CIS', sections: [
      'Installation Updates and Patches', 'Surface Area Reduction', 'Authentication and Authorization',
      'Password Policies', 'Auditing and Logging',
      'Application Development', 'Encryption'
    ]},
    'PostgreSQL': { source: 'CIS', sections: [
      'Installation and Permissions', 'Logging and Auditing', 'Connection and Login',
      'Authentication', 'Access Control', 'Replication',
      'Special Configuration', 'Backup and Disaster Recovery'
    ]},
    'MySQL': { source: 'CIS', sections: [
      'Operating System Level Configuration', 'Installation and Planning',
      'File System Permissions', 'General', 'MySQL Permissions Database',
      'Auditing and Logging', 'Authentication', 'Network', 'Replication'
    ]},
    'MongoDB': { source: 'CIS', sections: [
      'Installation and Patching', 'Authentication', 'Access Control',
      'Auditing', 'Network and Transport', 'Operating System',
      'File Permissions', 'Replication'
    ]},
    'IBM Db2': { source: 'CIS', sections: [
      'Installation and Patching', 'Instance-Level Configuration', 'Database-Level Configuration',
      'User and Privilege Management', 'Auditing', 'Network and Communication',
      'Backup and Recovery', 'Encryption'
    ]},
    'Apache Cassandra': { source: 'CIS', sections: [
      'Installation', 'Authentication and Authorization', 'Data Encryption',
      'Auditing and Logging', 'Network Configuration', 'Resource Management',
      'Backup and Recovery'
    ]},
    'SingleStore': { source: 'custom', sections: [
      'Installation and Patching', 'Authentication', 'Access Control',
      'Network Configuration', 'Encryption', 'Auditing and Logging',
      'Backup and Recovery'
    ]},
    'YugabyteDB': { source: 'custom', sections: [
      'Installation and Patching', 'Authentication', 'Access Control',
      'Network and TLS', 'Auditing', 'Encryption at Rest',
      'Backup and Recovery'
    ]},
    // ── Network Devices ──
    'Cisco IOS XE': { source: 'CIS', sections: [
      'Management Plane', 'Control Plane', 'Data Plane',
      'AAA Services', 'Routing', 'Logging', 'NTP', 'SNMP'
    ]},
    'FortiGate': { source: 'CIS', sections: [
      'System Settings', 'Administrator Accounts', 'Firmware and Updates',
      'Logging and Monitoring', 'Firewall Policy', 'VPN',
      'Intrusion Prevention', 'Web Filtering'
    ]},
    'Check Point': { source: 'STIG', sections: [
      'Management Server', 'Security Gateway', 'Logging and Monitoring',
      'Access Control Policy', 'NAT', 'VPN', 'Identity Awareness',
      'Threat Prevention'
    ]},
    'F5 Networks': { source: 'CIS', sections: [
      'System Configuration', 'User Management', 'Network Configuration',
      'SSL/TLS Profiles', 'Logging and Monitoring', 'iRules Security',
      'Virtual Server Configuration', 'Persistence Profiles'
    ]},
    'Arista': { source: 'CIS', sections: [
      'Management Plane', 'Control Plane', 'Data Plane',
      'AAA and Authentication', 'Routing Protocols', 'Logging',
      'NTP', 'SNMP', 'CloudVision'
    ]},
    'Juniper': { source: 'STIG', sections: [
      'Management Plane', 'Control Plane', 'Data Plane',
      'AAA and Authentication', 'Routing', 'Logging',
      'NTP', 'SNMP'
    ]},
    'Sophos Firewall': { source: 'custom', sections: [
      'System Settings', 'Administrator Management', 'Network Configuration',
      'Firewall Rules', 'VPN', 'Web Protection', 'Logging and Reporting',
      'Firmware and Updates'
    ]},
    'pfSense': { source: 'custom', sections: [
      'System Configuration', 'User Management', 'Firewall Rules',
      'NAT', 'VPN', 'DNS and DHCP', 'Logging', 'Package Management'
    ]},
    'OPNsense': { source: 'custom', sections: [
      'System Configuration', 'User Management', 'Firewall Rules',
      'NAT', 'VPN', 'DNS and DHCP', 'Logging', 'Plugin Management'
    ]},
    'Infoblox': { source: 'custom', sections: [
      'Grid Configuration', 'DNS Security', 'DHCP Security',
      'IPAM Configuration', 'User and Access Management',
      'Logging and Monitoring', 'Backup and Recovery'
    ]},
    'Forescout': { source: 'custom', sections: [
      'Appliance Configuration', 'Network Integration', 'Policy Configuration',
      'User and Access Management', 'Module Configuration',
      'Logging and Reporting', 'Updates and Patching'
    ]},
    // ── Browsers ──
    'Google Chrome': { source: 'CIS', sections: [
      'Installation and Updates', 'Default Search Provider', 'Content Settings',
      'Password Manager', 'Network and Proxy', 'Extensions',
      'Privacy and Security', 'Safe Browsing'
    ]},
    'Microsoft Edge': { source: 'CIS', sections: [
      'Installation and Updates', 'Default Search Provider', 'Content Settings',
      'Password Manager', 'Network and Proxy', 'Extensions',
      'Privacy and Security', 'SmartScreen'
    ]},
    'Mozilla Firefox': { source: 'CIS', sections: [
      'Installation and Updates', 'Privacy and Security', 'Content Settings',
      'Password Manager', 'Network Configuration', 'Extensions',
      'Certificate Management', 'Telemetry'
    ]},
    'Apple Safari': { source: 'CIS', sections: [
      'General Settings', 'Privacy and Security', 'AutoFill',
      'Password Management', 'Extensions', 'Search Settings',
      'Downloads', 'Advanced'
    ]},
    // ── SaaS / Identity ──
    'Microsoft 365': { source: 'CIS', sections: [
      'Account and Authentication', 'Microsoft Entra ID', 'Exchange Online',
      'SharePoint and OneDrive', 'Microsoft Teams',
      'Microsoft Defender', 'Data Loss Prevention', 'Information Protection'
    ]},
    'Google Workspace': { source: 'CIS', sections: [
      'Account and Authentication', 'Gmail', 'Google Drive and Docs',
      'Calendar', 'Groups', 'Mobile Management',
      'Marketplace Apps', 'Security and Reporting'
    ]},
    'Okta': { source: 'custom', sections: [
      'Authentication Policies', 'MFA Configuration', 'Application Assignment',
      'Session Management', 'Admin Roles', 'API Security',
      'Network Zones', 'System Log and Monitoring'
    ]},
    'Zoom': { source: 'custom', sections: [
      'Account Settings', 'Authentication', 'Meeting Security',
      'Recording Policies', 'Chat and Channels', 'Phone Settings',
      'Integration Management', 'Data Governance'
    ]},
    // ── Security Platforms ──
    'Tanium': { source: 'STIG', sections: [
      'Server Configuration', 'Module Management', 'Endpoint Configuration',
      'Action Management', 'User Roles and Permissions',
      'Network Configuration', 'Logging and Monitoring'
    ]},
    'Dragos': { source: 'custom', sections: [
      'Appliance Configuration', 'Network Sensor Deployment', 'Asset Discovery',
      'Threat Detection Policies', 'User Management',
      'Integration Configuration', 'Backup and Recovery'
    ]},
    'Xylok': { source: 'STIG', sections: [
      'Server Configuration', 'Scan Profile Management', 'Remediation Policies',
      'User Roles and Permissions', 'Continuous Monitoring',
      'Reporting Configuration', 'Update Management'
    ]},
    'Axonius': { source: 'custom', sections: [
      'Adapter Configuration', 'Query and Discovery', 'Enforcement Policies',
      'User Management', 'Dashboard and Reporting',
      'Integration Management', 'API Configuration'
    ]},
    // ── Server Software ──
    'Apache HTTP': { source: 'CIS', sections: [
      'Planning and Installation', 'Minimize Modules', 'Principles Permissions and Ownership',
      'Apache Access Control', 'Minimize Features', 'Operations Logging and Monitoring',
      'SSL/TLS Configuration', 'Information Leakage', 'Denial of Service Mitigations'
    ]},
    'Nginx': { source: 'CIS', sections: [
      'Installation', 'Basic Configuration', 'Logging',
      'SSL/TLS Configuration', 'Request Limits', 'Information Disclosure',
      'Access Control', 'Proxy Configuration'
    ]},
    'Microsoft IIS': { source: 'CIS', sections: [
      'Basic Configuration', 'Application Pool Configuration', 'Authentication and Authorization',
      'Request Filtering', 'Logging and Monitoring', 'SSL/TLS Configuration',
      'Machine Key Configuration', 'Transport Security'
    ]},
    'Apache Tomcat': { source: 'CIS', sections: [
      'Remove Extraneous Resources', 'Limit Server Connectivity',
      'Protect the Shutdown Port', 'Protect Tomcat Configurations',
      'Configure Realms', 'Connector Security', 'Logging',
      'Application Deployment'
    ]},
    // ── Print ──
    'Multi-function Print': { source: 'CIS', sections: [
      'Physical Security', 'Network Configuration', 'Access Control',
      'Data Storage and Encryption', 'Firmware Updates',
      'Logging and Auditing', 'Document Processing Security'
    ]},
    // ── Archived / Legacy ──
    'Windows 7': { source: 'CIS', sections: [
      'Account Policies', 'Local Policies', 'Event Log', 'System Services',
      'Registry', 'Windows Firewall', 'Advanced Audit Policy Configuration',
      'Administrative Templates'
    ]},
    'Windows 8': { source: 'CIS', sections: [
      'Account Policies', 'Local Policies', 'Event Log', 'System Services',
      'Registry', 'Windows Firewall', 'Advanced Audit Policy Configuration',
      'Administrative Templates'
    ]},
    'Windows XP': { source: 'CIS', sections: [
      'Account Policies', 'Local Policies', 'Event Log', 'System Services',
      'Registry', 'Windows Firewall', 'Administrative Templates'
    ]},
    'Aliyun': { source: 'CIS', sections: [
      'Initial Setup', 'Services', 'Network Configuration', 'Logging and Auditing',
      'Access Authentication and Authorization', 'System Maintenance',
      'Filesystem Configuration'
    ]},
    'Linux Mint': { source: 'CIS', sections: [
      'Initial Setup', 'Services', 'Network Configuration', 'Logging and Auditing',
      'Access Authentication and Authorization', 'System Maintenance',
      'Filesystem Configuration'
    ]},
    'IBM z/OS': { source: 'CIS', sections: [
      'RACF Configuration', 'System Security', 'Network Security',
      'Logging and Auditing', 'Dataset Protection', 'User Management',
      'Encryption and Key Management', 'Batch Processing'
    ]},
    'FreeBSD': { source: 'CIS', sections: [
      'Initial Setup', 'Services', 'Network Configuration', 'Logging and Auditing',
      'Access Authentication and Authorization', 'System Maintenance',
      'Filesystem Configuration'
    ]},
    'Oracle Cloud': { source: 'CIS', sections: [
      'Identity and Access Management', 'Networking', 'Compute',
      'Storage', 'Logging and Monitoring', 'Database Services',
      'Cloud Guard', 'Key Management'
    ]},
    'Snowflake': { source: 'CIS', sections: [
      'Account Configuration', 'Authentication', 'Access Control',
      'Network Policy', 'Data Protection', 'Monitoring and Auditing',
      'Sharing and Replication'
    ]},
    'Dynamics 365': { source: 'CIS', sections: [
      'Identity and Access', 'Security Roles', 'Data Protection',
      'Auditing and Logging', 'Integration Security', 'Environment Configuration'
    ]},
    'IBM CICS': { source: 'CIS', sections: [
      'RACF Security', 'Transaction Security', 'Resource Access Control',
      'Auditing and Logging', 'Network Security', 'Program Security',
      'System Configuration'
    ]},
  };

  const ins = db.prepare(`INSERT INTO benchmark_rules
    (product_id, rule_id, title, section, level, rule_type, source, is_automatable)
    VALUES (?,?,?,?,?,?,?,?)`);

  const allProducts = db.prepare('SELECT id, product_name FROM benchmark_products WHERE is_active = 1').all();
  let totalSections = 0;

  const tx = db.transaction(() => {
    allProducts.forEach(prod => {
      // Find matching section map by product name prefix
      const key = Object.keys(sectionMap).find(k => prod.product_name.includes(k));
      if (!key) return;
      const { source, sections } = sectionMap[key];
      sections.forEach((sectionName, idx) => {
        ins.run(prod.id, `${idx + 1}`, sectionName, sectionName, 0, 'section', source, 1);
        totalSections++;
      });
    });
  });
  tx();
  console.log(`Seeded ${totalSections} benchmark rule sections across ${allProducts.length} products`);
}
seedBenchmarkRules();

// ─── API Routes ─────────────────────────────────────────────────────────────

// Dashboard summary
app.get('/api/dashboard', (req, res) => {
  const totalRevenue = db.prepare('SELECT COALESCE(SUM(amount),0) as total FROM payments').get().total;
  const outstandingInvoices = db.prepare(`
    SELECT COALESCE(SUM(i.total),0) - COALESCE(SUM(p.paid),0) as outstanding
    FROM invoices i
    LEFT JOIN (SELECT invoice_id, SUM(amount) as paid FROM payments GROUP BY invoice_id) p ON i.id = p.invoice_id
    WHERE i.status IN ('sent','overdue')
  `).get().outstanding;
  const activeProjects = db.prepare("SELECT COUNT(*) as n FROM projects WHERE status = 'active'").get().n;
  const activeRetainers = db.prepare("SELECT COUNT(*) as n FROM retainers WHERE status = 'active'").get().n;
  const totalClients = db.prepare('SELECT COUNT(*) as n FROM clients WHERE is_active = 1').get().n;
  const totalHours = db.prepare('SELECT COALESCE(SUM(hours),0) as h FROM time_entries WHERE is_billable = 1').get().h;
  const monthlyExpenses = db.prepare(`SELECT COALESCE(SUM(amount),0) as total FROM expenses WHERE is_recurring = 1`).get().total;
  const pipelineValue = db.prepare(`SELECT COALESCE(SUM(estimated_value),0) as total FROM leads WHERE status NOT IN ('won','lost')`).get().total;

  res.json({
    totalRevenue, outstandingInvoices, activeProjects, activeRetainers,
    totalClients, totalHours, monthlyExpenses, pipelineValue
  });
});

// Clients
app.get('/api/clients', (req, res) => {
  const rows = db.prepare(`
    SELECT c.*, i.name as industry,
      (SELECT COALESCE(SUM(p.amount),0) FROM invoices inv JOIN payments p ON inv.id = p.invoice_id WHERE inv.client_id = c.id) as lifetime_revenue
    FROM clients c LEFT JOIN industries i ON c.industry_id = i.id
    ORDER BY c.company_name
  `).all();
  res.json(rows);
});

// Team members — simple list for dropdowns (assignees, etc.)
app.get('/api/team', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT id, first_name, last_name, email, role, status
      FROM team_members
      WHERE status = 'active'
      ORDER BY first_name
    `).all();
    res.json({ ok: true, members: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Projects
app.get('/api/projects', (req, res) => {
  const rows = db.prepare(`
    SELECT p.*, c.company_name as client_name, s.name as service_name
    FROM projects p
    JOIN clients c ON p.client_id = c.id
    LEFT JOIN services s ON p.service_id = s.id
    ORDER BY p.start_date DESC
  `).all();
  res.json(rows);
});

// Project milestones
app.get('/api/projects/:id/milestones', (req, res) => {
  const rows = db.prepare('SELECT * FROM milestones WHERE project_id = ? ORDER BY sort_order').all(req.params.id);
  res.json(rows);
});

// Pipeline
app.get('/api/pipeline', (req, res) => {
  const rows = db.prepare(`
    SELECT l.*, c.company_name, con.first_name || ' ' || con.last_name as contact_name, ls.name as source
    FROM leads l
    LEFT JOIN clients c ON l.client_id = c.id
    LEFT JOIN contacts con ON l.contact_id = con.id
    LEFT JOIN lead_sources ls ON l.lead_source_id = ls.id
    ORDER BY l.created_at DESC
  `).all();
  res.json(rows);
});

// Invoices
app.get('/api/invoices', (req, res) => {
  const rows = db.prepare(`
    SELECT i.*, c.company_name,
      COALESCE((SELECT SUM(amount) FROM payments WHERE invoice_id = i.id), 0) as paid
    FROM invoices i JOIN clients c ON i.client_id = c.id
    ORDER BY i.issue_date DESC
  `).all();
  res.json(rows);
});

// Expenses
app.get('/api/expenses', (req, res) => {
  const rows = db.prepare('SELECT * FROM expenses ORDER BY expense_date DESC').all();
  res.json(rows);
});

// Time entries
app.get('/api/time', (req, res) => {
  const rows = db.prepare(`
    SELECT te.*, c.company_name, p.name as project_name
    FROM time_entries te
    JOIN clients c ON te.client_id = c.id
    LEFT JOIN projects p ON te.project_id = p.id
    ORDER BY te.entry_date DESC
  `).all();
  res.json(rows);
});

// Activity log
app.get('/api/activity', (req, res) => {
  const rows = db.prepare(`
    SELECT a.*, tm.first_name || ' ' || tm.last_name as team_member_name
    FROM activity_log a
    LEFT JOIN team_members tm ON a.team_member_id = tm.id
    ORDER BY a.logged_at DESC LIMIT 20
  `).all();
  res.json(rows);
});

// Services
app.get('/api/services', (req, res) => {
  const rows = db.prepare('SELECT * FROM services ORDER BY service_type, name').all();
  res.json(rows);
});

// Certifications
app.get('/api/certifications', (req, res) => {
  const rows = db.prepare('SELECT * FROM certifications ORDER BY status, name').all();
  res.json(rows);
});

// ─────────────────────────────────────────────────────────────────────────────
// CRM ENDPOINTS (with input validation)
// ─────────────────────────────────────────────────────────────────────────────

// CRM stage definitions
const CRM_STAGES = {
  'New Lead':                  { trigger: 'Send intro email within 24 hrs', sla: '24 hours',  next: 'Discovery Scheduled',     urgent: true  },
  'Discovery Scheduled':       { trigger: 'Send calendar invite + prep doc',  sla: '48 hours',  next: 'Discovery Complete',       urgent: false },
  'Discovery Complete':        { trigger: 'Send AI Readiness Assessment form', sla: '48 hours',  next: 'Assessment In Progress',   urgent: false },
  'Assessment In Progress':    { trigger: 'Follow up on assessment form',      sla: '5 days',    next: 'Proposal Sent',            urgent: false },
  'Proposal Sent':             { trigger: 'Follow up if no reply in 3 days',   sla: '3 days',    next: 'Active Client',            urgent: true  },
  'Active Client':             { trigger: 'Send onboarding welcome email',     sla: 'Immediate', next: 'Project In Progress',      urgent: true  },
  'Project In Progress':       { trigger: 'Send weekly progress update',       sla: 'Weekly',    next: 'Delivered',                urgent: false },
  'Delivered':                 { trigger: 'Request testimonial + case study',  sla: '1 week',    next: 'Post-Project Follow-Up',   urgent: false },
  'Post-Project Follow-Up':    { trigger: 'Discuss retainer or next project',  sla: '2 weeks',   next: 'Retainer / Upsell',        urgent: false },
  'Retainer / Upsell':         { trigger: 'Send retainer agreement',           sla: '3 days',    next: 'Closed - Won',             urgent: false },
  'Closed - Won':              { trigger: 'Add to alumni newsletter list',     sla: 'This week', next: null,                       urgent: false },
  'Closed - No Sale':          { trigger: 'Send gracious close + stay in touch', sla: '1 week',  next: null,                       urgent: false },
  'On Hold':                   { trigger: 'Set 30-day check-in reminder',      sla: '30 days',   next: null,                       urgent: false },
};

function buildCRMRow(row) {
  const stage = CRM_STAGES[row.crm_status] || CRM_STAGES['New Lead'];
  return {
    id:              row.id,
    customerId:      row.crm_customer_id || row.id.slice(0,8).toUpperCase(),
    company:         row.company_name,
    contactName:     row.crm_contact_name || '',
    contactEmail:    row.crm_contact_email || '',
    contactPhone:    row.crm_contact_phone || '',
    status:          row.crm_status || 'New Lead',
    service:         row.crm_service || '',
    projectName:     row.crm_project_name || '',
    budget:          row.crm_budget || '',
    leadSource:      row.crm_lead_source || '',
    industry:        row.industry || '',
    notes:           row.notes || '',
    lastStatusChange: row.crm_last_status_change || row.created_at,
    createdAt:       row.created_at,
    trigger:         stage.trigger,
    sla:             stage.sla,
    nextStage:       stage.next,
    urgent:          stage.urgent,
  };
}

// GET /api/crm — all CRM customers
app.get('/api/crm', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT c.*, i.name as industry
      FROM clients c
      LEFT JOIN industries i ON c.industry_id = i.id
      WHERE c.is_active = 1
      ORDER BY c.created_at DESC
    `).all();
    res.json({ ok: true, customers: rows.map(buildCRMRow), stages: CRM_STAGES });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/crm/triggers — customers with urgent pending actions
app.get('/api/crm/triggers', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT c.*, i.name as industry
      FROM clients c
      LEFT JOIN industries i ON c.industry_id = i.id
      WHERE c.is_active = 1
      ORDER BY c.crm_last_status_change ASC
    `).all();
    const urgent = rows.map(buildCRMRow).filter(r => r.urgent);
    res.json({ ok: true, triggers: urgent });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/crm/customers — create new CRM customer (validated)
app.post('/api/crm/customers', [
  body('company').trim().notEmpty().withMessage('company is required').isLength({ max: 200 }),
  body('contactName').optional().trim().isLength({ max: 200 }),
  body('contactEmail').optional({ values: 'falsy' }).trim().isEmail().withMessage('Invalid email'),
  body('contactPhone').optional().trim().isLength({ max: 30 }),
  body('status').optional().trim().isIn(Object.keys(CRM_STAGES)).withMessage('Invalid CRM status'),
  body('service').optional().trim().isLength({ max: 200 }),
  body('projectName').optional().trim().isLength({ max: 200 }),
  body('budget').optional().isNumeric().withMessage('budget must be a number'),
  body('leadSource').optional().trim().isLength({ max: 100 }),
  body('industry').optional().trim().isLength({ max: 100 }),
  body('notes').optional().trim().isLength({ max: 2000 }),
], handleValidation, (req, res) => {
  try {
    const { company, contactName, contactEmail, contactPhone,
            status, service, projectName, budget, leadSource,
            industry, notes } = req.body;

    const cid = uuid();
    const now = new Date().toISOString();

    // Resolve or create industry
    let industryId = null;
    if (industry) {
      let indRow = db.prepare('SELECT id FROM industries WHERE name = ?').get(industry);
      if (!indRow) {
        db.prepare('INSERT INTO industries (name) VALUES (?)').run(industry);
        indRow = db.prepare('SELECT id FROM industries WHERE name = ?').get(industry);
      }
      industryId = indRow.id;
    }

    db.prepare(`
      INSERT INTO clients (id, company_name, industry_id, notes, is_active, created_at, updated_at,
        crm_status, crm_budget, crm_project_name, crm_service, crm_lead_source,
        crm_contact_name, crm_contact_email, crm_contact_phone, crm_last_status_change)
      VALUES (?,?,?,?,1,?,?,?,?,?,?,?,?,?,?,?)
    `).run(cid, company, industryId, notes || null, now, now,
           status || 'New Lead', budget || null, projectName || null,
           service || null, leadSource || null,
           contactName || null, contactEmail || null, contactPhone || null, now);

    // Also create a contact record if email provided
    if (contactName || contactEmail) {
      const [fn, ...lnParts] = (contactName || '').split(' ');
      const ln = lnParts.join(' ') || company;
      db.prepare(`INSERT INTO contacts (id, client_id, first_name, last_name, email, phone, is_primary)
                  VALUES (?,?,?,?,?,?,1)`)
        .run(uuid(), cid, fn || '', ln, contactEmail || null, contactPhone || null);
    }

    // Log activity
    db.prepare(`INSERT INTO activity_log (entity_type, entity_id, action, summary, logged_at)
                VALUES ('client', ?, 'crm_created', ?, ?)`)
      .run(cid, `CRM record created: ${company} → ${status || 'New Lead'}`, now);

    const newRow = db.prepare(`
      SELECT c.*, i.name as industry FROM clients c
      LEFT JOIN industries i ON c.industry_id = i.id WHERE c.id = ?
    `).get(cid);
    res.status(201).json({ ok: true, customer: buildCRMRow(newRow) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// PATCH /api/crm/customers/:id/status — update CRM status (validated)
app.patch('/api/crm/customers/:id/status', [
  param('id').trim().notEmpty(),
  body('status').trim().notEmpty().isIn(Object.keys(CRM_STAGES)).withMessage('Invalid CRM status'),
  body('notes').optional().trim().isLength({ max: 2000 }),
], handleValidation, (req, res) => {
  try {
    const { status, notes } = req.body;
    const { id } = req.params;

    const now = new Date().toISOString();
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
    if (!client) return res.status(404).json({ ok: false, error: 'Customer not found' });

    const updates = { crm_status: status, crm_last_status_change: now, updated_at: now };
    if (notes !== undefined) updates.notes = notes;

    const setClause = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    db.prepare(`UPDATE clients SET ${setClause} WHERE id = ?`)
      .run(...Object.values(updates), id);

    // Log the status change
    db.prepare(`INSERT INTO activity_log (entity_type, entity_id, action, summary, logged_at)
                VALUES ('client', ?, 'crm_status_change', ?, ?)`)
      .run(id, `Status changed: ${client.crm_status || 'New Lead'} → ${status}`, now);

    const updRow = db.prepare(`
      SELECT c.*, i.name as industry FROM clients c
      LEFT JOIN industries i ON c.industry_id = i.id WHERE c.id = ?
    `).get(id);
    res.json({ ok: true, customer: buildCRMRow(updRow), stage: CRM_STAGES[status] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// PATCH /api/crm/customers/:id — update CRM customer fields (validated)
app.patch('/api/crm/customers/:id', [
  param('id').trim().notEmpty(),
  body('company_name').optional().trim().isLength({ min: 1, max: 200 }),
  body('notes').optional().trim().isLength({ max: 2000 }),
  body('crm_status').optional().trim().isIn(Object.keys(CRM_STAGES)),
  body('crm_budget').optional().isNumeric(),
  body('crm_project_name').optional().trim().isLength({ max: 200 }),
  body('crm_service').optional().trim().isLength({ max: 200 }),
  body('crm_lead_source').optional().trim().isLength({ max: 100 }),
  body('crm_contact_name').optional().trim().isLength({ max: 200 }),
  body('crm_contact_email').optional({ values: 'falsy' }).trim().isEmail(),
  body('crm_contact_phone').optional().trim().isLength({ max: 30 }),
], handleValidation, (req, res) => {
  try {
    const { id } = req.params;
    const allowed = ['company_name','notes','crm_status','crm_budget','crm_project_name',
                     'crm_service','crm_lead_source','crm_contact_name','crm_contact_email','crm_contact_phone'];
    const updates = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
    if (Object.keys(updates).length === 0) return res.status(400).json({ ok: false, error: 'No valid fields to update' });

    updates.updated_at = new Date().toISOString();
    const setClause = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    const result = db.prepare(`UPDATE clients SET ${setClause} WHERE id = ?`)
      .run(...Object.values(updates), id);

    if (result.changes === 0) return res.status(404).json({ ok: false, error: 'Customer not found' });

    const updRow = db.prepare(`
      SELECT c.*, i.name as industry FROM clients c
      LEFT JOIN industries i ON c.industry_id = i.id WHERE c.id = ?
    `).get(id);
    res.json({ ok: true, customer: buildCRMRow(updRow) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// DELETE /api/crm/customers/:id — soft delete (deactivate)
app.delete('/api/crm/customers/:id', (req, res) => {
  try {
    const { id } = req.params;
    const result = db.prepare("UPDATE clients SET is_active = 0, updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
    if (result.changes === 0) return res.status(404).json({ ok: false, error: 'Customer not found' });
    res.json({ ok: true, message: 'Customer deactivated' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/crm/activity/:id — activity log for a customer
app.get('/api/crm/activity/:id', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT a.*, tm.first_name || ' ' || tm.last_name as team_member_name
      FROM activity_log a
      LEFT JOIN team_members tm ON a.team_member_id = tm.id
      WHERE a.entity_id = ? ORDER BY a.logged_at DESC LIMIT 50
    `).all(req.params.id);
    res.json({ ok: true, activity: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/crm/activity/:id — log a manual activity note (validated)
app.post('/api/crm/activity/:id', [
  param('id').trim().notEmpty(),
  body('action').trim().notEmpty().isLength({ max: 50 }).withMessage('action is required'),
  body('summary').trim().notEmpty().isLength({ max: 2000 }).withMessage('summary is required'),
], handleValidation, (req, res) => {
  try {
    const { action, summary } = req.body;
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO activity_log (entity_type, entity_id, action, summary, logged_at)
                VALUES ('client', ?, ?, ?, ?)`)
      .run(req.params.id, action, summary, now);
    res.status(201).json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TRAINING TRACKER ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/training/programs — list all training programs
app.get('/api/training/programs', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM training_programs ORDER BY created_at DESC').all();
    res.json({ ok: true, programs: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/training/programs/:id — full program with domains, topics, and progress
app.get('/api/training/programs/:id', (req, res) => {
  try {
    const program = db.prepare('SELECT * FROM training_programs WHERE id = ?').get(req.params.id);
    if (!program) return res.status(404).json({ ok: false, error: 'Program not found' });

    const domains = db.prepare('SELECT * FROM training_domains WHERE program_id = ? ORDER BY sort_order').all(program.id);
    const topics = db.prepare(`
      SELECT t.*, tp.team_member_id, tp.completed, tp.completed_at
      FROM training_topics t
      LEFT JOIN training_progress tp ON t.id = tp.topic_id
      WHERE t.domain_id IN (SELECT id FROM training_domains WHERE program_id = ?)
      ORDER BY t.sort_order
    `).all(program.id);

    const members = db.prepare(`
      SELECT DISTINCT tm.id, tm.first_name, tm.last_name, tm.role
      FROM team_members tm
      JOIN training_progress tp ON tm.id = tp.team_member_id
      JOIN training_topics tt ON tp.topic_id = tt.id
      JOIN training_domains td ON tt.domain_id = td.id
      WHERE td.program_id = ?
      UNION
      SELECT tm.id, tm.first_name, tm.last_name, tm.role
      FROM team_members tm
      WHERE tm.status = 'active'
    `).all(program.id);

    // Build domain tree with topics
    const domainTree = domains.map(d => ({
      ...d,
      topics: topics.filter(t => t.domain_id === d.id)
    }));

    res.json({ ok: true, program, domains: domainTree, members });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/training/progress/:programId/:memberId — progress for a specific member
app.get('/api/training/progress/:programId/:memberId', (req, res) => {
  try {
    const { programId, memberId } = req.params;
    const rows = db.prepare(`
      SELECT tp.*, tt.name as topic_name, tt.domain_id, td.name as domain_name
      FROM training_progress tp
      JOIN training_topics tt ON tp.topic_id = tt.id
      JOIN training_domains td ON tt.domain_id = td.id
      WHERE td.program_id = ? AND tp.team_member_id = ? AND tp.completed = 1
    `).all(programId, memberId);
    res.json({ ok: true, progress: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/training/progress — toggle a topic completion
app.post('/api/training/progress', [
  body('team_member_id').trim().notEmpty(),
  body('topic_id').trim().notEmpty(),
  body('completed').isInt({ min: 0, max: 1 }),
], handleValidation, (req, res) => {
  try {
    const { team_member_id, topic_id, completed } = req.body;
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO training_progress (team_member_id, topic_id, completed, completed_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(team_member_id, topic_id)
      DO UPDATE SET completed = excluded.completed, completed_at = excluded.completed_at
    `).run(team_member_id, topic_id, completed, completed ? now : null);

    // Log activity
    const topic = db.prepare(`
      SELECT tt.name as topic, td.name as domain
      FROM training_topics tt JOIN training_domains td ON tt.domain_id = td.id
      WHERE tt.id = ?
    `).get(topic_id);
    const member = db.prepare('SELECT first_name, last_name FROM team_members WHERE id = ?').get(team_member_id);
    if (topic && member) {
      db.prepare(`INSERT INTO activity_log (entity_type, entity_id, action, summary, logged_at)
                  VALUES ('training', ?, ?, ?, ?)`)
        .run(team_member_id,
          completed ? 'topic_completed' : 'topic_unchecked',
          `${member.first_name} ${completed ? 'completed' : 'unchecked'} "${topic.topic}" in ${topic.domain}`,
          now);
    }

    res.json({ ok: true, completed, completed_at: completed ? now : null });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/training/notes/:programId/:memberId — notes for a member
app.get('/api/training/notes/:programId/:memberId', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT * FROM training_notes
      WHERE program_id = ? AND team_member_id = ?
      ORDER BY created_at DESC
    `).all(req.params.programId, req.params.memberId);
    res.json({ ok: true, notes: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/training/notes — add a note
app.post('/api/training/notes', [
  body('team_member_id').trim().notEmpty(),
  body('program_id').trim().notEmpty(),
  body('domain_tag').trim().notEmpty().isLength({ max: 50 }),
  body('note').trim().notEmpty().isLength({ max: 2000 }),
], handleValidation, (req, res) => {
  try {
    const { team_member_id, program_id, domain_tag, note } = req.body;
    const id = uuid();
    const now = new Date().toISOString();
    db.prepare('INSERT INTO training_notes (id, team_member_id, program_id, domain_tag, note, created_at) VALUES (?,?,?,?,?,?)')
      .run(id, team_member_id, program_id, domain_tag, note, now);
    res.status(201).json({ ok: true, note: { id, team_member_id, program_id, domain_tag, note, created_at: now } });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// DELETE /api/training/notes/:id — delete a note
app.delete('/api/training/notes/:id', (req, res) => {
  try {
    const result = db.prepare('DELETE FROM training_notes WHERE id = ?').run(req.params.id);
    if (result.changes === 0) return res.status(404).json({ ok: false, error: 'Note not found' });
    res.json({ ok: true, message: 'Note deleted' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/training/compare/:programId — compare all members on a program
app.get('/api/training/compare/:programId', (req, res) => {
  try {
    const { programId } = req.params;
    const domains = db.prepare('SELECT * FROM training_domains WHERE program_id = ? ORDER BY sort_order').all(programId);
    const members = db.prepare("SELECT id, first_name, last_name, role FROM team_members WHERE status = 'active'").all();

    const comparison = members.map(m => {
      const domainProgress = domains.map(d => {
        const total = db.prepare('SELECT COUNT(*) as n FROM training_topics WHERE domain_id = ?').get(d.id).n;
        const done = db.prepare(`
          SELECT COUNT(*) as n FROM training_progress tp
          JOIN training_topics tt ON tp.topic_id = tt.id
          WHERE tt.domain_id = ? AND tp.team_member_id = ? AND tp.completed = 1
        `).get(d.id, m.id).n;
        return { domain_id: d.id, domain_name: d.name, weight: d.weight, color: d.color, total, done, pct: total ? Math.round((done / total) * 100) : 0 };
      });
      const totalDone = domainProgress.reduce((s, d) => s + d.done, 0);
      const totalTopics = domainProgress.reduce((s, d) => s + d.total, 0);
      const noteCount = db.prepare('SELECT COUNT(*) as n FROM training_notes WHERE program_id = ? AND team_member_id = ?').get(programId, m.id).n;
      const contentIdeas = db.prepare("SELECT COUNT(*) as n FROM training_notes WHERE program_id = ? AND team_member_id = ? AND domain_tag = 'content'").get(programId, m.id).n;
      return {
        member: m,
        overall: { done: totalDone, total: totalTopics, pct: totalTopics ? Math.round((totalDone / totalTopics) * 100) : 0 },
        domains: domainProgress,
        noteCount,
        contentIdeas,
      };
    });

    res.json({ ok: true, comparison });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CRUD ENDPOINTS — Invoices, Time, Expenses, Projects, Milestones
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/invoices — create a new invoice
app.post('/api/invoices', [
  body('client_id').trim().notEmpty().withMessage('client_id is required'),
  body('subtotal').isNumeric().withMessage('subtotal must be a number'),
  body('issue_date').trim().notEmpty().withMessage('issue_date is required'),
  body('due_date').trim().notEmpty().withMessage('due_date is required'),
  body('tax_rate').optional().isNumeric(),
  body('project_id').optional().trim(),
  body('notes').optional().trim().isLength({ max: 2000 }),
], handleValidation, (req, res) => {
  try {
    const { client_id, project_id, subtotal, tax_rate, issue_date, due_date, notes } = req.body;
    const id = uuid();
    const taxR = tax_rate || 0;
    const taxAmt = Math.round(subtotal * taxR) / 100;
    const total = subtotal + taxAmt;
    // Auto-generate invoice number: INV-YYYYMM-XXX
    const count = db.prepare('SELECT COUNT(*) as n FROM invoices').get().n;
    const now = new Date();
    const invoiceNumber = `INV-${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}-${String(count+1).padStart(3,'0')}`;

    db.prepare(`INSERT INTO invoices (id, invoice_number, client_id, project_id, status, issue_date, due_date, subtotal, tax_rate, tax_amount, total, notes)
                VALUES (?,?,?,?,'draft',?,?,?,?,?,?,?)`)
      .run(id, invoiceNumber, client_id, project_id || null, issue_date, due_date, subtotal, taxR, taxAmt, total, notes || null);

    const row = db.prepare(`SELECT i.*, c.company_name, 0 as paid FROM invoices i JOIN clients c ON i.client_id = c.id WHERE i.id = ?`).get(id);
    res.status(201).json({ ok: true, invoice: row });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// PATCH /api/invoices/:id — update invoice status
app.patch('/api/invoices/:id', [
  param('id').trim().notEmpty(),
  body('status').optional().trim().isIn(['draft','sent','paid','overdue','cancelled']),
  body('notes').optional().trim().isLength({ max: 2000 }),
], handleValidation, (req, res) => {
  try {
    const allowed = ['status','notes'];
    const updates = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
    if (Object.keys(updates).length === 0) return res.status(400).json({ ok: false, error: 'No valid fields to update' });

    const setClause = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    const result = db.prepare(`UPDATE invoices SET ${setClause} WHERE id = ?`).run(...Object.values(updates), req.params.id);
    if (result.changes === 0) return res.status(404).json({ ok: false, error: 'Invoice not found' });

    const row = db.prepare(`SELECT i.*, c.company_name, COALESCE((SELECT SUM(amount) FROM payments WHERE invoice_id = i.id),0) as paid FROM invoices i JOIN clients c ON i.client_id = c.id WHERE i.id = ?`).get(req.params.id);
    res.json({ ok: true, invoice: row });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/payments — record a payment against an invoice
app.post('/api/payments', [
  body('invoice_id').trim().notEmpty().withMessage('invoice_id is required'),
  body('amount').isNumeric().withMessage('amount must be a number'),
  body('payment_date').trim().notEmpty().withMessage('payment_date is required'),
  body('payment_method').optional().trim().isLength({ max: 50 }),
  body('reference_number').optional().trim().isLength({ max: 100 }),
], handleValidation, (req, res) => {
  try {
    const { invoice_id, amount, payment_date, payment_method, reference_number } = req.body;
    const id = uuid();
    db.prepare(`INSERT INTO payments (id, invoice_id, amount, payment_date, payment_method, reference_number) VALUES (?,?,?,?,?,?)`)
      .run(id, invoice_id, amount, payment_date, payment_method || null, reference_number || null);

    // Auto-update invoice status to paid if fully paid
    const inv = db.prepare('SELECT total FROM invoices WHERE id = ?').get(invoice_id);
    const totalPaid = db.prepare('SELECT COALESCE(SUM(amount),0) as paid FROM payments WHERE invoice_id = ?').get(invoice_id).paid;
    if (inv && totalPaid >= inv.total) {
      db.prepare("UPDATE invoices SET status = 'paid' WHERE id = ?").run(invoice_id);
    }

    res.status(201).json({ ok: true, payment: { id, invoice_id, amount, payment_date } });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/time — log a time entry
app.post('/api/time', [
  body('client_id').trim().notEmpty().withMessage('client_id is required'),
  body('entry_date').trim().notEmpty().withMessage('entry_date is required'),
  body('hours').isFloat({ min: 0.1, max: 24 }).withMessage('hours must be between 0.1 and 24'),
  body('project_id').optional().trim(),
  body('description').optional().trim().isLength({ max: 1000 }),
  body('is_billable').optional().isBoolean(),
], handleValidation, (req, res) => {
  try {
    const { client_id, project_id, entry_date, hours, description, is_billable } = req.body;
    // Use first active team member as default (single-user for now)
    const member = db.prepare("SELECT id FROM team_members WHERE status = 'active' LIMIT 1").get();
    const memberId = member ? member.id : 'default';

    const result = db.prepare(`INSERT INTO time_entries (team_member_id, client_id, project_id, entry_date, hours, description, is_billable)
                VALUES (?,?,?,?,?,?,?)`)
      .run(memberId, client_id, project_id || null, entry_date, hours, description || null, is_billable !== undefined ? (is_billable ? 1 : 0) : 1);

    res.status(201).json({ ok: true, entry: { id: result.lastInsertRowid, client_id, entry_date, hours } });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/expenses — log a new expense
app.post('/api/expenses', [
  body('category').trim().notEmpty().withMessage('category is required'),
  body('description').trim().notEmpty().withMessage('description is required'),
  body('amount').isNumeric().withMessage('amount must be a number'),
  body('expense_date').trim().notEmpty().withMessage('expense_date is required'),
  body('vendor').optional().trim().isLength({ max: 200 }),
  body('is_recurring').optional().isBoolean(),
  body('recurrence_freq').optional().trim().isIn(['monthly','quarterly','yearly','']),
  body('project_id').optional().trim(),
], handleValidation, (req, res) => {
  try {
    const { category, description, amount, expense_date, vendor, is_recurring, recurrence_freq, project_id } = req.body;
    const id = uuid();
    db.prepare(`INSERT INTO expenses (id, category, vendor, description, amount, expense_date, is_recurring, recurrence_freq, project_id)
                VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(id, category, vendor || null, description, amount, expense_date,
           is_recurring ? 1 : 0, recurrence_freq || null, project_id || null);

    const row = db.prepare('SELECT * FROM expenses WHERE id = ?').get(id);
    res.status(201).json({ ok: true, expense: row });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// PATCH /api/expenses/:id — edit an expense
app.patch('/api/expenses/:id', [
  param('id').trim().notEmpty(),
  body('category').optional().trim().isLength({ min: 1, max: 100 }),
  body('description').optional().trim().isLength({ min: 1, max: 500 }),
  body('amount').optional().isNumeric(),
  body('vendor').optional().trim().isLength({ max: 200 }),
  body('expense_date').optional().trim(),
], handleValidation, (req, res) => {
  try {
    const allowed = ['category','description','amount','vendor','expense_date','is_recurring','recurrence_freq'];
    const updates = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
    if (Object.keys(updates).length === 0) return res.status(400).json({ ok: false, error: 'No valid fields' });

    const setClause = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    const result = db.prepare(`UPDATE expenses SET ${setClause} WHERE id = ?`).run(...Object.values(updates), req.params.id);
    if (result.changes === 0) return res.status(404).json({ ok: false, error: 'Expense not found' });

    const row = db.prepare('SELECT * FROM expenses WHERE id = ?').get(req.params.id);
    res.json({ ok: true, expense: row });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// DELETE /api/expenses/:id — remove an expense
app.delete('/api/expenses/:id', (req, res) => {
  try {
    const result = db.prepare('DELETE FROM expenses WHERE id = ?').run(req.params.id);
    if (result.changes === 0) return res.status(404).json({ ok: false, error: 'Expense not found' });
    res.json({ ok: true, message: 'Expense deleted' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/projects — create a new project
app.post('/api/projects', [
  body('client_id').trim().notEmpty().withMessage('client_id is required'),
  body('name').trim().notEmpty().isLength({ max: 300 }).withMessage('name is required'),
  body('service_id').optional().isNumeric(),
  body('budget').optional().isNumeric(),
  body('start_date').optional().trim(),
  body('target_end_date').optional().trim(),
  body('description').optional().trim().isLength({ max: 2000 }),
  body('status').optional().trim().isIn(['scoping','active','completed','cancelled','on_hold']),
], handleValidation, (req, res) => {
  try {
    const { client_id, name, service_id, budget, start_date, target_end_date, description, status } = req.body;
    const id = uuid();
    db.prepare(`INSERT INTO projects (id, client_id, service_id, name, description, status, budget, start_date, target_end_date, created_at)
                VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))`)
      .run(id, client_id, service_id || null, name, description || null,
           status || 'scoping', budget || null, start_date || null, target_end_date || null);

    const row = db.prepare(`SELECT p.*, c.company_name as client_name, s.name as service_name FROM projects p JOIN clients c ON p.client_id = c.id LEFT JOIN services s ON p.service_id = s.id WHERE p.id = ?`).get(id);
    res.status(201).json({ ok: true, project: row });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// PATCH /api/projects/:id — update a project
app.patch('/api/projects/:id', [
  param('id').trim().notEmpty(),
  body('status').optional().trim().isIn(['scoping','active','completed','cancelled','on_hold']),
  body('name').optional().trim().isLength({ min: 1, max: 300 }),
  body('budget').optional().isNumeric(),
  body('description').optional().trim().isLength({ max: 2000 }),
  body('target_end_date').optional().trim(),
  body('actual_end_date').optional().trim(),
], handleValidation, (req, res) => {
  try {
    const allowed = ['status','name','budget','description','target_end_date','actual_end_date'];
    const updates = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
    if (Object.keys(updates).length === 0) return res.status(400).json({ ok: false, error: 'No valid fields' });

    const setClause = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    const result = db.prepare(`UPDATE projects SET ${setClause} WHERE id = ?`).run(...Object.values(updates), req.params.id);
    if (result.changes === 0) return res.status(404).json({ ok: false, error: 'Project not found' });

    const row = db.prepare(`SELECT p.*, c.company_name as client_name, s.name as service_name FROM projects p JOIN clients c ON p.client_id = c.id LEFT JOIN services s ON p.service_id = s.id WHERE p.id = ?`).get(req.params.id);
    res.json({ ok: true, project: row });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/projects/:id/milestones — add a milestone
app.post('/api/projects/:id/milestones', [
  param('id').trim().notEmpty(),
  body('name').trim().notEmpty().isLength({ max: 200 }).withMessage('name is required'),
  body('due_date').optional().trim(),
  body('sort_order').optional().isNumeric(),
], handleValidation, (req, res) => {
  try {
    const { name, due_date, sort_order } = req.body;
    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ ok: false, error: 'Project not found' });

    const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order),0) as m FROM milestones WHERE project_id = ?').get(req.params.id).m;
    const result = db.prepare(`INSERT INTO milestones (project_id, name, status, due_date, sort_order) VALUES (?,?,'pending',?,?)`)
      .run(req.params.id, name, due_date || null, sort_order !== undefined ? sort_order : maxOrder + 1);

    res.status(201).json({ ok: true, milestone: { id: result.lastInsertRowid, project_id: req.params.id, name, status: 'pending', due_date } });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// PATCH /api/milestones/:id — update a milestone (status, name, due_date)
app.patch('/api/milestones/:id', [
  param('id').trim().notEmpty(),
  body('status').optional().trim().isIn(['pending','in_progress','completed']),
  body('name').optional().trim().isLength({ min: 1, max: 200 }),
  body('due_date').optional().trim(),
], handleValidation, (req, res) => {
  try {
    const allowed = ['status','name','due_date'];
    const updates = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });

    // Auto-set completed_date when marking as completed
    if (updates.status === 'completed') updates.completed_date = new Date().toISOString().split('T')[0];
    if (updates.status && updates.status !== 'completed') updates.completed_date = null;

    if (Object.keys(updates).length === 0) return res.status(400).json({ ok: false, error: 'No valid fields' });

    const setClause = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    const result = db.prepare(`UPDATE milestones SET ${setClause} WHERE id = ?`).run(...Object.values(updates), req.params.id);
    if (result.changes === 0) return res.status(404).json({ ok: false, error: 'Milestone not found' });

    const row = db.prepare('SELECT * FROM milestones WHERE id = ?').get(req.params.id);
    res.json({ ok: true, milestone: row });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Daily Reviews ───────────────────────────────────────────────────────────

// GET — list all daily reviews (most recent first)
app.get('/api/daily-reviews', requireAuth, (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 30, 100);
    const rows = db.prepare('SELECT * FROM daily_reviews ORDER BY review_date DESC LIMIT ?').all(limit);
    res.json({ ok: true, reviews: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET — single daily review by date
app.get('/api/daily-reviews/:date', requireAuth, (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM daily_reviews WHERE review_date = ?').get(req.params.date);
    if (!row) return res.status(404).json({ ok: false, error: 'No review found for this date' });
    res.json({ ok: true, review: row });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST — create or update a daily review (upsert by date)
app.post('/api/daily-reviews', [
  body('review_date').trim().notEmpty().withMessage('review_date is required'),
], handleValidation, (req, res) => {
  try {
    const { review_date, sprint_day, sprint_week, clients_revenue, sprint_progress,
            development, training, services_pricing, marketing, infrastructure,
            other_milestones, reminders, summary, sources_reviewed } = req.body;

    const existing = db.prepare('SELECT id FROM daily_reviews WHERE review_date = ?').get(review_date);
    if (existing) {
      db.prepare(`UPDATE daily_reviews SET
        sprint_day = COALESCE(?, sprint_day), sprint_week = COALESCE(?, sprint_week),
        clients_revenue = COALESCE(?, clients_revenue), sprint_progress = COALESCE(?, sprint_progress),
        development = COALESCE(?, development), training = COALESCE(?, training),
        services_pricing = COALESCE(?, services_pricing), marketing = COALESCE(?, marketing),
        infrastructure = COALESCE(?, infrastructure), other_milestones = COALESCE(?, other_milestones),
        reminders = COALESCE(?, reminders), summary = COALESCE(?, summary),
        sources_reviewed = COALESCE(?, sources_reviewed)
        WHERE review_date = ?`).run(
        sprint_day, sprint_week, clients_revenue, sprint_progress,
        development, training, services_pricing, marketing, infrastructure,
        other_milestones, reminders, summary, sources_reviewed, review_date
      );
      const updated = db.prepare('SELECT * FROM daily_reviews WHERE review_date = ?').get(review_date);
      res.json({ ok: true, review: updated, action: 'updated' });
    } else {
      db.prepare(`INSERT INTO daily_reviews
        (review_date, sprint_day, sprint_week, clients_revenue, sprint_progress,
         development, training, services_pricing, marketing, infrastructure,
         other_milestones, reminders, summary, sources_reviewed)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        review_date, sprint_day || null, sprint_week || null,
        clients_revenue || null, sprint_progress || null,
        development || null, training || null, services_pricing || null,
        marketing || null, infrastructure || null,
        other_milestones || null, reminders || null,
        summary || null, sources_reviewed || null
      );
      const created = db.prepare('SELECT * FROM daily_reviews WHERE review_date = ?').get(review_date);
      res.status(201).json({ ok: true, review: created, action: 'created' });
    }
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// DELETE — remove a daily review
app.delete('/api/daily-reviews/:date', requireAuth, (req, res) => {
  try {
    db.prepare('DELETE FROM daily_reviews WHERE review_date = ?').run(req.params.date);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Document Library ────────────────────────────────────────────────────────

// GET — list all documents (newest first), optional ?date= filter
app.get('/api/documents', requireAuth, (req, res) => {
  try {
    if (req.query.date) {
      const rows = db.prepare('SELECT * FROM documents WHERE linked_date = ? ORDER BY updated_at DESC').all(req.query.date);
      return res.json({ ok: true, documents: rows });
    }
    const rows = db.prepare('SELECT * FROM documents ORDER BY updated_at DESC').all();
    res.json({ ok: true, documents: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET — single document by id
app.get('/api/documents/:id', requireAuth, (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ ok: false, error: 'Document not found' });
    res.json({ ok: true, document: row });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST — create a new document
app.post('/api/documents', [
  body('title').trim().notEmpty().withMessage('title is required'),
], handleValidation, (req, res) => {
  try {
    const { title, description, category, visibility, doc_type, drive_url, tags, linked_date, review_section } = req.body;
    // Auto-set linked_date to today if not provided
    const effectiveDate = linked_date || new Date().toISOString().split('T')[0];
    const result = db.prepare(`INSERT INTO documents
      (title, description, category, visibility, doc_type, drive_url, tags, linked_date, review_section)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      title, description || null, category || 'brand', visibility || 'internal',
      doc_type || 'Word Doc', drive_url || null, tags || null, effectiveDate, review_section || null
    );
    const created = db.prepare('SELECT * FROM documents WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ ok: true, document: created });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// PATCH — update a document
app.patch('/api/documents/:id', requireAuth, (req, res) => {
  try {
    const allowed = ['title', 'description', 'category', 'visibility', 'doc_type', 'drive_url', 'tags', 'linked_date', 'review_section'];
    const updates = {};
    for (const k of allowed) {
      if (req.body[k] !== undefined) updates[k] = req.body[k];
    }
    updates.updated_at = new Date().toISOString();

    if (Object.keys(updates).length <= 1) return res.status(400).json({ ok: false, error: 'No valid fields' });

    const setClause = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    const result = db.prepare(`UPDATE documents SET ${setClause} WHERE id = ?`).run(...Object.values(updates), req.params.id);
    if (result.changes === 0) return res.status(404).json({ ok: false, error: 'Document not found' });

    const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
    res.json({ ok: true, document: row });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// DELETE — remove a document
app.delete('/api/documents/:id', requireAuth, (req, res) => {
  try {
    const result = db.prepare('DELETE FROM documents WHERE id = ?').run(req.params.id);
    if (result.changes === 0) return res.status(404).json({ ok: false, error: 'Document not found' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Skilljar API (CCA Certification Tracking) ─────────────────────────────
const SKILLJAR_API_KEY = process.env.SKILLJAR_API_KEY || '';
const SKILLJAR_DOMAIN = process.env.SKILLJAR_DOMAIN || '';
const SKILLJAR_EMAILS = (process.env.SKILLJAR_EMAILS || '').split(',').map(e => e.trim()).filter(Boolean);

async function skilljarGet(endpoint, params) {
  const url = new URL(`https://api.skilljar.com/v1${endpoint}`);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const resp = await fetch(url.toString(), {
    headers: { 'Authorization': 'Basic ' + Buffer.from(SKILLJAR_API_KEY + ':').toString('base64') }
  });
  if (!resp.ok) throw new Error(`Skilljar API ${resp.status}: ${resp.statusText}`);
  return resp.json();
}

async function skilljarPaginate(endpoint, params) {
  const all = [];
  let page = 1;
  while (true) {
    const data = await skilljarGet(endpoint, { ...(params || {}), page });
    all.push(...(data.results || []));
    if (!data.next) break;
    page++;
  }
  return all;
}

// GET /api/skilljar/progress — full team progress report
app.get('/api/skilljar/progress', requireAuth, async (req, res) => {
  try {
    if (!SKILLJAR_API_KEY || !SKILLJAR_DOMAIN) {
      return res.json({ ok: true, configured: false, message: 'Skilljar not configured. Set SKILLJAR_API_KEY and SKILLJAR_DOMAIN in .env' });
    }

    // Find users by email
    const allUsers = await skilljarPaginate(`/domains/${SKILLJAR_DOMAIN}/users`);
    const emailSet = new Set(SKILLJAR_EMAILS.map(e => e.toLowerCase()));
    const matchedUsers = [];
    for (const record of allUsers) {
      const user = record.user || record;
      if (emailSet.has((user.email || '').toLowerCase())) {
        matchedUsers.push({ id: user.id, first_name: user.first_name || '', last_name: user.last_name || '', email: (user.email || '').toLowerCase() });
      }
    }

    // Get enrollments + lesson progress per user
    const teamProgress = [];
    for (const user of matchedUsers) {
      const enrollments = await skilljarPaginate(`/users/${user.id}/published-courses`);
      const courses = [];
      for (const enrollment of enrollments) {
        const courseId = enrollment.id || enrollment.published_course_id;
        const courseTitle = enrollment.title || (enrollment.course || {}).title || 'Unknown Course';
        let lessons = [];
        try { lessons = await skilljarPaginate(`/users/${user.id}/published-courses/${courseId}/lessons`); } catch(e) {}
        const total = lessons.length;
        const completed = lessons.filter(l => l.completed_at != null).length;
        const pct = total > 0 ? Math.round(completed / total * 100) : 0;
        courses.push({
          id: courseId,
          title: courseTitle,
          completed,
          total,
          pct,
          status: pct === 100 ? 'completed' : pct > 0 ? 'in_progress' : 'not_started',
          lessons: lessons.map(l => ({
            id: l.id,
            title: l.title || l.name || 'Untitled',
            completed: l.completed_at != null,
            completed_at: l.completed_at
          }))
        });
      }
      const totalLessons = courses.reduce((s, c) => s + c.total, 0);
      const completedLessons = courses.reduce((s, c) => s + c.completed, 0);
      const overallPct = totalLessons > 0 ? Math.round(completedLessons / totalLessons * 100) : 0;
      teamProgress.push({
        user,
        courses,
        overall: { completed: completedLessons, total: totalLessons, pct: overallPct }
      });
    }

    res.json({ ok: true, configured: true, generated_at: new Date().toISOString(), domain: SKILLJAR_DOMAIN, teamProgress });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Tickets API ────────────────────────────────────────────────────────────

// GET — list tickets with filters
app.get('/api/tickets', requireAuth, (req, res) => {
  try {
    const { status, priority, ticket_type, assigned_to, client_id, project_id, category, notion_unsynced } = req.query;
    let where = [];
    let params = [];
    if (status) { where.push('t.status = ?'); params.push(status); }
    if (priority) { where.push('t.priority = ?'); params.push(priority); }
    if (ticket_type) { where.push('t.ticket_type = ?'); params.push(ticket_type); }
    if (assigned_to) { where.push('t.assigned_to = ?'); params.push(assigned_to); }
    if (client_id) { where.push('t.client_id = ?'); params.push(client_id); }
    if (project_id) { where.push('t.project_id = ?'); params.push(project_id); }
    if (category) { where.push('t.category = ?'); params.push(category); }
    if (notion_unsynced === '1') { where.push("t.category = 'action' AND t.notion_page_id IS NULL"); }
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const rows = db.prepare(`
      SELECT t.*,
        tm.first_name || ' ' || tm.last_name as assignee_name,
        c.company_name as client_name,
        p.name as project_name
      FROM tickets t
      LEFT JOIN team_members tm ON t.assigned_to = tm.id
      LEFT JOIN clients c ON t.client_id = c.id
      LEFT JOIN projects p ON t.project_id = p.id
      ${clause}
      ORDER BY
        CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END,
        t.sort_order, t.created_at DESC
    `).all(...params);
    res.json({ ok: true, tickets: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET — ticket dashboard summary
app.get('/api/tickets/summary', requireAuth, (req, res) => {
  try {
    const byStatus = db.prepare("SELECT status, COUNT(*) as count FROM tickets GROUP BY status").all();
    const byPriority = db.prepare("SELECT priority, COUNT(*) as count FROM tickets GROUP BY priority").all();
    const byType = db.prepare("SELECT ticket_type, COUNT(*) as count FROM tickets GROUP BY ticket_type").all();
    const overdue = db.prepare("SELECT COUNT(*) as count FROM tickets WHERE due_date < date('now') AND status NOT IN ('done', 'cancelled')").get();
    const completedThisWeek = db.prepare("SELECT COUNT(*) as count FROM tickets WHERE completed_date >= date('now', '-7 days')").get();
    const total = db.prepare("SELECT COUNT(*) as count FROM tickets").get();
    const open = db.prepare("SELECT COUNT(*) as count FROM tickets WHERE status NOT IN ('done', 'cancelled')").get();
    res.json({ ok: true, byStatus, byPriority, byType, overdue: overdue.count, completedThisWeek: completedThisWeek.count, total: total.count, open: open.count });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST — create ticket
app.post('/api/tickets', requireAuth, [
  body('title').trim().notEmpty().withMessage('Title is required'),
  body('ticket_type').optional().isIn(['client', 'internal']),
  body('priority').optional().isIn(['low', 'medium', 'high', 'urgent']),
  body('status').optional().isIn(['backlog', 'todo', 'in_progress', 'review', 'done', 'cancelled']),
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ ok: false, errors: errors.array() });
  try {
    const id = uuid();
    const { title, description, ticket_type, category, status, priority, assigned_to, client_id, project_id, due_date, tags } = req.body;
    db.prepare(`INSERT INTO tickets (id, title, description, ticket_type, category, status, priority, assigned_to, client_id, project_id, due_date, tags, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, title, description || null, ticket_type || 'internal', category || 'general',
      status || 'backlog', priority || 'medium', assigned_to || null, client_id || null,
      project_id || null, due_date || null, tags || null, req.user?.username || 'system'
    );
    const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
    res.status(201).json({ ok: true, ticket });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// PATCH — update ticket
app.patch('/api/tickets/:id', requireAuth, (req, res) => {
  try {
    const allowed = ['title', 'description', 'ticket_type', 'category', 'status', 'priority', 'assigned_to', 'client_id', 'project_id', 'due_date', 'tags', 'sort_order', 'notion_page_id'];
    const updates = {};
    for (const k of allowed) {
      if (req.body[k] !== undefined) updates[k] = req.body[k];
    }
    if (req.body.status === 'done' && !req.body.completed_date) {
      updates.completed_date = new Date().toISOString().split('T')[0];
    }
    if (req.body.status && req.body.status !== 'done') {
      updates.completed_date = null;
    }
    updates.updated_at = new Date().toISOString();
    if (Object.keys(updates).length <= 1) return res.status(400).json({ ok: false, error: 'No valid fields' });
    const setClause = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    const result = db.prepare(`UPDATE tickets SET ${setClause} WHERE id = ?`).run(...Object.values(updates), req.params.id);
    if (result.changes === 0) return res.status(404).json({ ok: false, error: 'Ticket not found' });
    // Ticket done → cascade to linked action item
    if (req.body.status === 'done') {
      const linked = db.prepare('SELECT action_item_id FROM tickets WHERE id = ?').get(req.params.id);
      if (linked && linked.action_item_id) {
        db.prepare("UPDATE action_items SET status = 'done', completed_at = datetime('now') WHERE id = ? AND status != 'done'").run(linked.action_item_id);
      }
    }
    const ticket = db.prepare(`
      SELECT t.*, tm.first_name || ' ' || tm.last_name as assignee_name, c.company_name as client_name, p.name as project_name
      FROM tickets t LEFT JOIN team_members tm ON t.assigned_to = tm.id LEFT JOIN clients c ON t.client_id = c.id LEFT JOIN projects p ON t.project_id = p.id
      WHERE t.id = ?`).get(req.params.id);
    res.json({ ok: true, ticket });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// DELETE — remove ticket
app.delete('/api/tickets/:id', requireAuth, (req, res) => {
  try {
    db.prepare('DELETE FROM ticket_comments WHERE ticket_id = ?').run(req.params.id);
    const result = db.prepare('DELETE FROM tickets WHERE id = ?').run(req.params.id);
    if (result.changes === 0) return res.status(404).json({ ok: false, error: 'Ticket not found' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET — ticket comments
app.get('/api/tickets/:id/comments', requireAuth, (req, res) => {
  try {
    const comments = db.prepare('SELECT * FROM ticket_comments WHERE ticket_id = ? ORDER BY created_at ASC').all(req.params.id);
    res.json({ ok: true, comments });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST — add comment
app.post('/api/tickets/:id/comments', requireAuth, [
  body('comment').trim().notEmpty()
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ ok: false, errors: errors.array() });
  try {
    const ticket = db.prepare('SELECT id FROM tickets WHERE id = ?').get(req.params.id);
    if (!ticket) return res.status(404).json({ ok: false, error: 'Ticket not found' });
    db.prepare('INSERT INTO ticket_comments (ticket_id, author, comment) VALUES (?, ?, ?)').run(
      req.params.id, req.user?.username || req.body.author || 'system', req.body.comment
    );
    const comments = db.prepare('SELECT * FROM ticket_comments WHERE ticket_id = ? ORDER BY created_at ASC').all(req.params.id);
    res.json({ ok: true, comments });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Benchmark Products API ─────────────────────────────────────────────────

// List all products with optional filters
app.get('/api/benchmark-products', (req, res) => {
  try {
    let sql = `SELECT bp.*,
      (SELECT COUNT(*) FROM benchmark_rules br WHERE br.product_id = bp.id AND br.rule_type = 'rule' AND (br.benchmark_status = 'active' OR br.benchmark_status IS NULL)) as active_rule_count
      FROM benchmark_products bp WHERE bp.is_active = 1`;
    const params = [];

    if (req.query.category) {
      sql += ' AND bp.category = ?';
      params.push(req.query.category);
    }
    if (req.query.subcategory) {
      sql += ' AND bp.subcategory = ?';
      params.push(req.query.subcategory);
    }
    if (req.query.cis_benchmark) {
      sql += ' AND bp.cis_benchmark = ?';
      params.push(req.query.cis_benchmark);
    }
    if (req.query.disa_stig) {
      sql += ' AND bp.disa_stig = ?';
      params.push(req.query.disa_stig);
    }
    if (req.query.drift_detection_capability) {
      sql += ' AND bp.drift_detection_capability = ?';
      params.push(req.query.drift_detection_capability);
    }
    if (req.query.automation_ceiling) {
      sql += ' AND bp.automation_ceiling = ?';
      params.push(req.query.automation_ceiling);
    }
    if (req.query.vendor) {
      sql += ' AND bp.vendor = ?';
      params.push(req.query.vendor);
    }
    if (req.query.search) {
      sql += ' AND (bp.product_name LIKE ? OR bp.vendor LIKE ? OR bp.notes LIKE ?)';
      const term = `%${req.query.search}%`;
      params.push(term, term, term);
    }

    sql += ' ORDER BY bp.category, bp.subcategory, bp.product_name';
    const rows = db.prepare(sql).all(...params);
    res.json({ ok: true, count: rows.length, products: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Summary stats (must be before :id route)
app.get('/api/benchmark-products/stats/summary', (req, res) => {
  try {
    const total = db.prepare('SELECT COUNT(*) as n FROM benchmark_products WHERE is_active = 1').get().n;
    const byCIS = db.prepare("SELECT cis_benchmark, COUNT(*) as n FROM benchmark_products WHERE is_active = 1 GROUP BY cis_benchmark").all();
    const bySTIG = db.prepare("SELECT disa_stig, COUNT(*) as n FROM benchmark_products WHERE is_active = 1 GROUP BY disa_stig").all();
    const byCategory = db.prepare("SELECT category, COUNT(*) as n FROM benchmark_products WHERE is_active = 1 GROUP BY category ORDER BY n DESC").all();
    const byDrift = db.prepare("SELECT drift_detection_capability, COUNT(*) as n FROM benchmark_products WHERE is_active = 1 GROUP BY drift_detection_capability ORDER BY n DESC").all();
    const byAutomation = db.prepare("SELECT automation_ceiling, COUNT(*) as n FROM benchmark_products WHERE is_active = 1 GROUP BY automation_ceiling ORDER BY n DESC").all();
    const byArchitecture = db.prepare("SELECT architecture_type, COUNT(*) as n FROM benchmark_products WHERE is_active = 1 GROUP BY architecture_type ORDER BY n DESC").all();
    res.json({ ok: true, total, byCIS, bySTIG, byCategory, byDrift, byAutomation, byArchitecture });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Get single product by ID
app.get('/api/benchmark-products/:id', (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM benchmark_products WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ ok: false, error: 'Product not found' });
    res.json({ ok: true, product: row });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Benchmark Rules API ────────────────────────────────────────────────────

// Rules for a product (with filters)
app.get('/api/benchmark-products/:id/rules', (req, res) => {
  try {
    let sql = 'SELECT * FROM benchmark_rules WHERE product_id = ? AND is_active = 1';
    const params = [req.params.id];
    if (req.query.rule_type) { sql += ' AND rule_type = ?'; params.push(req.query.rule_type); }
    if (req.query.source) { sql += ' AND source = ?'; params.push(req.query.source); }
    if (req.query.severity) { sql += ' AND severity = ?'; params.push(req.query.severity); }
    if (req.query.section) { sql += ' AND section = ?'; params.push(req.query.section); }
    if (req.query.check_type) { sql += ' AND check_type = ?'; params.push(req.query.check_type); }
    if (req.query.benchmark_version) { sql += ' AND benchmark_version = ?'; params.push(req.query.benchmark_version); }
    if (req.query.benchmark_status) { sql += ' AND benchmark_status = ?'; params.push(req.query.benchmark_status); }
    if (req.query.search) {
      sql += ' AND (title LIKE ? OR description LIKE ? OR config_parameter LIKE ?)';
      const t = `%${req.query.search}%`; params.push(t, t, t);
    }
    sql += ' ORDER BY section, level, rule_id';
    const rows = db.prepare(sql).all(...params);
    res.json({ ok: true, count: rows.length, rules: rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Rules summary for a product
app.get('/api/benchmark-products/:id/rules/summary', (req, res) => {
  try {
    const pid = req.params.id;
    const total = db.prepare('SELECT COUNT(*) as n FROM benchmark_rules WHERE product_id = ? AND is_active = 1').get(pid).n;
    const bySection = db.prepare("SELECT section, section_name, COUNT(*) as n FROM benchmark_rules WHERE product_id = ? AND is_active = 1 GROUP BY section ORDER BY n DESC").all(pid);
    const byType = db.prepare("SELECT rule_type, COUNT(*) as n FROM benchmark_rules WHERE product_id = ? AND is_active = 1 GROUP BY rule_type").all(pid);
    const bySeverity = db.prepare("SELECT severity, COUNT(*) as n FROM benchmark_rules WHERE product_id = ? AND is_active = 1 AND severity IS NOT NULL GROUP BY severity").all(pid);
    const byCheckType = db.prepare("SELECT check_type, COUNT(*) as n FROM benchmark_rules WHERE product_id = ? AND is_active = 1 AND check_type IS NOT NULL GROUP BY check_type").all(pid);
    const bySource = db.prepare("SELECT source, COUNT(*) as n FROM benchmark_rules WHERE product_id = ? AND is_active = 1 GROUP BY source").all(pid);
    const byVersion = db.prepare("SELECT benchmark_version, benchmark_status, COUNT(*) as n FROM benchmark_rules WHERE product_id = ? AND is_active = 1 AND benchmark_version IS NOT NULL GROUP BY benchmark_version, benchmark_status ORDER BY benchmark_version").all(pid);
    res.json({ ok: true, total, bySection, byType, bySeverity, byCheckType, bySource, byVersion });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Single rule detail
app.get('/api/benchmark-rules/:ruleId', (req, res) => {
  try {
    const row = db.prepare('SELECT r.*, p.product_name, p.vendor FROM benchmark_rules r JOIN benchmark_products p ON r.product_id = p.id WHERE r.id = ?').get(req.params.ruleId);
    if (!row) return res.status(404).json({ ok: false, error: 'Rule not found' });
    res.json({ ok: true, rule: row });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Add a single rule
app.post('/api/benchmark-products/:id/rules', express.json(), (req, res) => {
  try {
    const b = req.body;
    if (!b.title) return res.status(400).json({ ok: false, error: 'Title is required' });
    // Auto-generate cis_uid if not provided
    let uid = b.cis_uid || null;
    if (!uid) {
      const maxSeq = db.prepare("SELECT COUNT(*) as n FROM benchmark_rules WHERE product_id = ? AND rule_type = 'rule'").get(req.params.id).n;
      uid = `CIS-2026-${String(req.params.id).padStart(5,'0')}.${String(maxSeq + 1).padStart(3,'0')}`;
    }
    const result = db.prepare(`INSERT INTO benchmark_rules
      (product_id, rule_id, title, section, subsection, level, rule_type, source,
       severity, cis_profile, check_type, description, rationale, remediation,
       audit_command, default_value, recommended_value, config_parameter, config_location,
       benchmark_version, benchmark_status, cis_uid, is_automatable, "references", section_name)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      req.params.id, b.rule_id||null, b.title, b.section||null, b.subsection||null,
      b.level||0, b.rule_type||'rule', b.source||null, b.severity||null,
      b.cis_profile||null, b.check_type||null, b.description||null, b.rationale||null,
      b.remediation||null, b.audit_command||null, b.default_value||null,
      b.recommended_value||null, b.config_parameter||null, b.config_location||null,
      b.benchmark_version||null, b.benchmark_status||'active', uid,
      b.is_automatable !== undefined ? b.is_automatable : 1,
      b.references||null, b.section_name||null
    );
    res.json({ ok: true, id: result.lastInsertRowid, cis_uid: uid });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Bulk import rules from JSON array
app.post('/api/benchmark-products/:id/rules/import', express.json({ limit: '10mb' }), (req, res) => {
  try {
    const rules = req.body.rules;
    if (!Array.isArray(rules) || rules.length === 0) return res.status(400).json({ ok: false, error: 'rules array is required' });
    const ins = db.prepare(`INSERT INTO benchmark_rules
      (product_id, rule_id, title, section, subsection, level, rule_type, source,
       severity, cis_profile, check_type, description, rationale, remediation,
       audit_command, default_value, recommended_value, config_parameter, config_location,
       benchmark_version, benchmark_status, is_automatable, "references", section_name)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const tx = db.transaction(() => {
      rules.forEach(b => {
        ins.run(req.params.id, b.rule_id||null, b.title, b.section||null, b.subsection||null,
          b.level||0, b.rule_type||'rule', b.source||null, b.severity||null,
          b.cis_profile||null, b.check_type||null, b.description||null, b.rationale||null,
          b.remediation||null, b.audit_command||null, b.default_value||null,
          b.recommended_value||null, b.config_parameter||null, b.config_location||null,
          b.benchmark_version||null, b.benchmark_status||'active',
          b.is_automatable !== undefined ? b.is_automatable : 1,
          b.references||null, b.section_name||null
        );
      });
    });
    tx();
    res.json({ ok: true, imported: rules.length });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─── Global error handler ───────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('[ERROR]', err.stack || err.message);
  res.status(500).json({ ok: false, error: 'Internal server error' });
});

// ─── CIS Compliance Chat ────────────────────────────────────────────────────
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
console.log(`[Chat] ANTHROPIC_API_KEY: ${anthropic ? 'loaded' : 'NOT SET — AI chat disabled'}`);

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

function searchProducts(query) {
  // Search benchmark_products for product-level info when a product is mentioned
  const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
  if (terms.length === 0) return [];

  const conditions = terms.map(() => `LOWER(bp.product_name) LIKE ?`).join(' OR ');
  const params = terms.map(t => `%${t}%`);

  try {
    return db.prepare(`
      SELECT bp.*,
        (SELECT COUNT(*) FROM benchmark_rules br WHERE br.product_id = bp.id AND br.rule_type = 'rule' AND (br.benchmark_status = 'active' OR br.benchmark_status IS NULL)) as active_rule_count
      FROM benchmark_products bp
      WHERE bp.is_active = 1 AND (${conditions})
      LIMIT 5
    `).all(...params);
  } catch (e) { return []; }
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

function searchRules(query, limit = 12) {
  // Search benchmark_rules using LIKE — OR between terms for recall, rank by match count
  const stopwords = new Set(['the','a','an','is','are','for','to','in','on','of','and','or','what','how','which','that','this','with','can','do','does','should','would','about','from','key','rules','ensure']);
  const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2 && !stopwords.has(t));
  if (terms.length === 0) return [];

  const conditions = terms.map(() =>
    `(LOWER(br.title) LIKE ? OR LOWER(br.description) LIKE ? OR LOWER(br.remediation) LIKE ? OR LOWER(br.rule_id) LIKE ?)`
  );

  // OR between terms for broad matching, then rank by how many terms matched
  const matchScores = terms.map(() =>
    `(CASE WHEN LOWER(br.title) LIKE ? THEN 3 ELSE 0 END + CASE WHEN LOWER(br.description) LIKE ? THEN 1 ELSE 0 END + CASE WHEN LOWER(br.remediation) LIKE ? THEN 1 ELSE 0 END)`
  );

  const params = [];
  for (const t of terms) {
    const like = `%${t}%`;
    params.push(like, like, like, like);
  }
  // Score params
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
  const allParams = [...params, ...scoreParams, limit];

  try {
    return db.prepare(sql).all(...allParams);
  } catch (e) {
    console.error('[Chat Search Error]', e.message);
    return [];
  }
}

function buildContext(rules) {
  if (rules.length === 0) return 'No relevant CIS Benchmark rules were found for this query.';
  return rules.map(r => {
    let ctx = `--- [${r.product_name}] CIS UID: ${r.cis_uid || 'N/A'} | Rule ${r.rule_id}: ${r.title} (${r.cis_profile}, ${r.check_type}, v${r.benchmark_version || '?'})`;
    if (r.description) ctx += `\nDescription: ${r.description.substring(0, 600)}`;
    if (r.rationale) ctx += `\nRationale: ${r.rationale.substring(0, 400)}`;
    if (r.remediation) ctx += `\nRemediation: ${r.remediation.substring(0, 400)}`;
    return ctx;
  }).join('\n\n');
}

app.post('/api/chat', express.json(), async (req, res) => {
  if (!anthropic) {
    return res.status(503).json({ ok: false, error: 'ANTHROPIC_API_KEY not set. Set it as an environment variable to enable AI chat.' });
  }

  const { message, history } = req.body;
  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({ ok: false, error: 'Message is required' });
  }

  try {
    // Search for relevant rules and matching products
    const rules = searchRules(message.trim(), 12);
    const products = searchProducts(message.trim());
    const context = buildContext(rules) + buildProductContext(products);

    // Build messages array with history
    const messages = [];
    if (Array.isArray(history)) {
      for (const h of history.slice(-10)) {  // Keep last 10 exchanges
        if (h.role === 'user' || h.role === 'assistant') {
          messages.push({ role: h.role, content: h.content });
        }
      }
    }

    // Add current message with context
    messages.push({
      role: 'user',
      content: `Context from CIS Benchmark knowledge base (${rules.length} rules found):\n\n${context}\n\n---\nUser question: ${message.trim()}`
    });

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      system: CIS_SYSTEM_PROMPT,
      messages
    });

    const answer = response.content[0].text;
    res.json({ ok: true, answer, rulesFound: rules.length });
  } catch (e) {
    console.error('[Chat Error]', e.message);
    res.status(500).json({ ok: false, error: 'AI chat error: ' + e.message });
  }
});

// ─── Operational Inventory API ───────────────────────────────────────────────

// Tools
app.get('/api/tools', requireAuth, (req, res) => {
  try {
    let sql = 'SELECT * FROM tools WHERE 1=1';
    const params = [];
    if (req.query.category) { sql += ' AND category = ?'; params.push(req.query.category); }
    if (req.query.suite) { sql += ' AND suite = ?'; params.push(req.query.suite); }
    if (req.query.relevance) { sql += ' AND relevance = ?'; params.push(req.query.relevance); }
    if (req.query.utilization) { sql += ' AND utilization = ?'; params.push(req.query.utilization); }
    if (req.query.q) { sql += ' AND (name LIKE ? OR description LIKE ?)'; params.push(`%${req.query.q}%`, `%${req.query.q}%`); }
    sql += ' ORDER BY category, suite, name';
    res.json({ ok: true, data: db.prepare(sql).all(...params) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/tools/summary', requireAuth, (req, res) => {
  try {
    const byCategory = db.prepare('SELECT category, COUNT(*) as count FROM tools GROUP BY category').all();
    const byRelevance = db.prepare('SELECT relevance, COUNT(*) as count FROM tools GROUP BY relevance').all();
    const byUtilization = db.prepare('SELECT utilization, COUNT(*) as count FROM tools GROUP BY utilization').all();
    const bySuite = db.prepare("SELECT suite, COUNT(*) as count FROM tools WHERE suite IS NOT NULL GROUP BY suite ORDER BY count DESC").all();
    const total = db.prepare('SELECT COUNT(*) as n FROM tools').get().n;
    res.json({ ok: true, data: { total, byCategory, byRelevance, byUtilization, bySuite } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/tools/:id', requireAuth, (req, res) => {
  try {
    const tool = db.prepare('SELECT * FROM tools WHERE id = ?').get(req.params.id);
    if (!tool) return res.status(404).json({ ok: false, error: 'Tool not found' });
    res.json({ ok: true, data: tool });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/tools', requireAuth, [
  body('name').trim().notEmpty().withMessage('Name is required'),
  body('category').isIn(['custom_skill', 'plugin', 'connector']).withMessage('Invalid category'),
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ ok: false, errors: errors.array() });
  try {
    const { name, category, suite, description, business_use, relevance, utilization, trigger_phrase } = req.body;
    const result = db.prepare('INSERT INTO tools (name, category, suite, description, business_use, relevance, utilization, trigger_phrase) VALUES (?,?,?,?,?,?,?,?)').run(name, category, suite || null, description || null, business_use || null, relevance || null, utilization || null, trigger_phrase || null);
    res.json({ ok: true, data: db.prepare('SELECT * FROM tools WHERE id = ?').get(result.lastInsertRowid) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.patch('/api/tools/:id', requireAuth, (req, res) => {
  try {
    const tool = db.prepare('SELECT * FROM tools WHERE id = ?').get(req.params.id);
    if (!tool) return res.status(404).json({ ok: false, error: 'Tool not found' });
    const fields = ['name', 'description', 'business_use', 'relevance', 'utilization', 'trigger_phrase'];
    const updates = [];
    const params = [];
    fields.forEach(f => {
      if (req.body[f] !== undefined) { updates.push(`${f} = ?`); params.push(req.body[f]); }
    });
    if (updates.length === 0) return res.status(400).json({ ok: false, error: 'No fields to update' });
    updates.push("updated_at = datetime('now')");
    params.push(req.params.id);
    db.prepare(`UPDATE tools SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    res.json({ ok: true, data: db.prepare('SELECT * FROM tools WHERE id = ?').get(req.params.id) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Business Assets
app.get('/api/assets', requireAuth, (req, res) => {
  try {
    let sql = 'SELECT * FROM business_assets WHERE 1=1';
    const params = [];
    if (req.query.folder) { sql += ' AND folder = ?'; params.push(req.query.folder); }
    if (req.query.format) { sql += ' AND format = ?'; params.push(req.query.format); }
    if (req.query.status) { sql += ' AND status = ?'; params.push(req.query.status); }
    if (req.query.q) { sql += ' AND (name LIKE ? OR purpose LIKE ?)'; params.push(`%${req.query.q}%`, `%${req.query.q}%`); }
    sql += ' ORDER BY folder, name';
    res.json({ ok: true, data: db.prepare(sql).all(...params) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/assets/summary', requireAuth, (req, res) => {
  try {
    const byFolder = db.prepare('SELECT folder, COUNT(*) as count FROM business_assets GROUP BY folder').all();
    const byFormat = db.prepare('SELECT format, COUNT(*) as count FROM business_assets GROUP BY format ORDER BY count DESC').all();
    const byStatus = db.prepare('SELECT status, COUNT(*) as count FROM business_assets GROUP BY status').all();
    const total = db.prepare('SELECT COUNT(*) as n FROM business_assets').get().n;
    res.json({ ok: true, data: { total, byFolder, byFormat, byStatus } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/assets', requireAuth, [
  body('name').trim().notEmpty().withMessage('Name is required'),
  body('folder').trim().notEmpty().withMessage('Folder is required'),
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ ok: false, errors: errors.array() });
  try {
    const { name, folder, format, status, purpose, file_path } = req.body;
    const result = db.prepare('INSERT INTO business_assets (name, folder, format, status, purpose, file_path) VALUES (?,?,?,?,?,?)').run(name, folder, format || null, status || 'planned', purpose || null, file_path || null);
    res.json({ ok: true, data: db.prepare('SELECT * FROM business_assets WHERE id = ?').get(result.lastInsertRowid) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.patch('/api/assets/:id', requireAuth, (req, res) => {
  try {
    const asset = db.prepare('SELECT * FROM business_assets WHERE id = ?').get(req.params.id);
    if (!asset) return res.status(404).json({ ok: false, error: 'Asset not found' });
    const fields = ['name', 'folder', 'format', 'status', 'purpose', 'file_path'];
    const updates = [];
    const params = [];
    fields.forEach(f => {
      if (req.body[f] !== undefined) { updates.push(`${f} = ?`); params.push(req.body[f]); }
    });
    if (updates.length === 0) return res.status(400).json({ ok: false, error: 'No fields to update' });
    updates.push("updated_at = datetime('now')");
    params.push(req.params.id);
    db.prepare(`UPDATE business_assets SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    res.json({ ok: true, data: db.prepare('SELECT * FROM business_assets WHERE id = ?').get(req.params.id) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Maturity Scores
app.get('/api/maturity', requireAuth, (req, res) => {
  try {
    res.json({ ok: true, data: db.prepare('SELECT * FROM maturity_scores ORDER BY score DESC').all() });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.patch('/api/maturity/:area', requireAuth, [
  body('score').optional().isInt({ min: 0, max: 100 }).withMessage('Score must be 0-100'),
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ ok: false, errors: errors.array() });
  try {
    const area = decodeURIComponent(req.params.area);
    const existing = db.prepare('SELECT * FROM maturity_scores WHERE area = ?').get(area);
    if (!existing) return res.status(404).json({ ok: false, error: 'Maturity area not found' });
    const updates = [];
    const params = [];
    if (req.body.score !== undefined) {
      updates.push('score = ?'); params.push(req.body.score);
      const s = req.body.score;
      const rating = s >= 75 ? 'strong' : s >= 50 ? 'good' : s >= 30 ? 'developing' : 'early';
      updates.push('rating = ?'); params.push(rating);
    }
    if (req.body.analysis) { updates.push('analysis = ?'); params.push(req.body.analysis); }
    if (updates.length === 0) return res.status(400).json({ ok: false, error: 'No fields to update' });
    updates.push("assessed_at = datetime('now')");
    params.push(area);
    db.prepare(`UPDATE maturity_scores SET ${updates.join(', ')} WHERE area = ?`).run(...params);
    res.json({ ok: true, data: db.prepare('SELECT * FROM maturity_scores WHERE area = ?').get(area) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Action Items
app.get('/api/actions', requireAuth, (req, res) => {
  try {
    let sql = 'SELECT * FROM action_items WHERE 1=1';
    const params = [];
    if (req.query.urgency) { sql += ' AND urgency = ?'; params.push(req.query.urgency); }
    if (req.query.status) { sql += ' AND status = ?'; params.push(req.query.status); }
    sql += ' ORDER BY priority';
    res.json({ ok: true, data: db.prepare(sql).all(...params) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/actions', requireAuth, [
  body('title').trim().notEmpty().withMessage('Title is required'),
  body('urgency').optional().isIn(['immediate', 'this_week', 'this_month', 'this_quarter', 'next_2_weeks', 'next_30_days']).withMessage('Invalid urgency'),
  body('priority').optional().isInt({ min: 1, max: 100 }).withMessage('Priority must be 1-100'),
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ ok: false, errors: errors.array() });
  try {
    const { title, description, urgency, priority, tools_to_use } = req.body;
    const urg = urgency || 'this_month';
    const createActionAndTicket = db.transaction(() => {
      const result = db.prepare('INSERT INTO action_items (title, description, urgency, priority, tools_to_use, status) VALUES (?,?,?,?,?,?)').run(
        title, description || null, urg, priority || 50, tools_to_use || null, 'pending'
      );
      const actionId = result.lastInsertRowid;
      const ticketId = uuid();
      db.prepare(`INSERT INTO tickets (id, title, description, ticket_type, category, status, priority, action_item_id, tags, created_by)
        VALUES (?, ?, ?, 'internal', 'action', 'backlog', ?, ?, 'action-item', 'system')`)
        .run(ticketId, title, description || null, urgencyToPriority(urg), actionId);
      db.prepare('UPDATE action_items SET ticket_id = ? WHERE id = ?').run(ticketId, actionId);
      return { actionId, ticketId };
    });
    const { actionId, ticketId } = createActionAndTicket();
    res.json({
      ok: true,
      data: db.prepare('SELECT * FROM action_items WHERE id = ?').get(actionId),
      ticket: db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId)
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Backfill: link existing action items to tickets
app.post('/api/actions/backfill-tickets', requireAuth, (req, res) => {
  try {
    const unlinked = db.prepare('SELECT * FROM action_items WHERE ticket_id IS NULL').all();
    let created = 0, linked = 0;
    for (const action of unlinked) {
      const match = db.prepare("SELECT id FROM tickets WHERE category = 'action' AND action_item_id IS NULL AND title = ?").get(action.title);
      if (match) {
        db.prepare('UPDATE tickets SET action_item_id = ? WHERE id = ?').run(action.id, match.id);
        db.prepare('UPDATE action_items SET ticket_id = ? WHERE id = ?').run(match.id, action.id);
        linked++;
      } else {
        const ticketId = uuid();
        db.prepare(`INSERT INTO tickets (id, title, description, ticket_type, category, status, priority, action_item_id, tags, created_by)
          VALUES (?, ?, ?, 'internal', 'action', 'backlog', ?, ?, 'action-item', 'system')`)
          .run(ticketId, action.title, action.description, urgencyToPriority(action.urgency), action.id);
        db.prepare('UPDATE action_items SET ticket_id = ? WHERE id = ?').run(ticketId, action.id);
        created++;
      }
    }
    res.json({ ok: true, linked, created, total: unlinked.length });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.patch('/api/actions/:id', requireAuth, [
  body('status').optional().isIn(['pending', 'in_progress', 'done']).withMessage('Invalid status'),
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ ok: false, errors: errors.array() });
  try {
    const action = db.prepare('SELECT * FROM action_items WHERE id = ?').get(req.params.id);
    if (!action) return res.status(404).json({ ok: false, error: 'Action item not found' });
    const updates = [];
    const params = [];
    if (req.body.status) {
      updates.push('status = ?'); params.push(req.body.status);
      if (req.body.status === 'done') { updates.push("completed_at = datetime('now')"); }
      else { updates.push('completed_at = NULL'); }
    }
    if (req.body.title) { updates.push('title = ?'); params.push(req.body.title); }
    if (req.body.description) { updates.push('description = ?'); params.push(req.body.description); }
    if (updates.length === 0) return res.status(400).json({ ok: false, error: 'No fields to update' });
    params.push(req.params.id);
    db.prepare(`UPDATE action_items SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    res.json({ ok: true, data: db.prepare('SELECT * FROM action_items WHERE id = ?').get(req.params.id) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─── Development Insights Endpoints ─────────────────────────────────────────

// Sync: import facets + session-meta JSON into SQLite
app.post('/api/dev-insights/sync', requireAuth, (req, res) => {
  try {
    const facetsDir = path.join(CLAUDE_USAGE_PATH, 'facets');
    const metaDir = path.join(CLAUDE_USAGE_PATH, 'session-meta');
    let importedSessions = 0, importedFacets = 0;

    const insertSession = db.prepare(`INSERT OR IGNORE INTO dev_sessions
      (session_id, project_path, start_time, duration_minutes, user_message_count, assistant_message_count,
       tool_counts, tool_errors, tool_error_categories, lines_added, lines_removed, files_modified,
       git_commits, languages, uses_mcp)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

    const insertFacet = db.prepare(`INSERT OR IGNORE INTO dev_facets
      (session_id, underlying_goal, goal_categories, outcome, friction_counts, friction_detail,
       primary_success, brief_summary, claude_helpfulness, session_type)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);

    const syncAll = db.transaction(() => {
      // Import session-meta files
      if (fs.existsSync(metaDir)) {
        for (const file of fs.readdirSync(metaDir).filter(f => f.endsWith('.json'))) {
          try {
            const d = JSON.parse(fs.readFileSync(path.join(metaDir, file), 'utf8'));
            const r = insertSession.run(
              d.session_id, d.project_path || null, d.start_time || null,
              d.duration_minutes || 0, d.user_message_count || 0, d.assistant_message_count || 0,
              JSON.stringify(d.tool_counts || {}), d.tool_errors || 0,
              JSON.stringify(d.tool_error_categories || {}),
              d.lines_added || 0, d.lines_removed || 0, d.files_modified || 0,
              d.git_commits || 0, JSON.stringify(d.languages || {}), d.uses_mcp ? 1 : 0
            );
            if (r.changes > 0) importedSessions++;
          } catch (_) { /* skip malformed files */ }
        }
      }
      // Import facet files
      if (fs.existsSync(facetsDir)) {
        for (const file of fs.readdirSync(facetsDir).filter(f => f.endsWith('.json'))) {
          try {
            const d = JSON.parse(fs.readFileSync(path.join(facetsDir, file), 'utf8'));
            const sid = d.session_id || file.replace('.json', '');
            const r = insertFacet.run(
              sid, d.underlying_goal || null, JSON.stringify(d.goal_categories || {}),
              d.outcome || null, JSON.stringify(d.friction_counts || {}),
              d.friction_detail || null, d.primary_success || null,
              d.brief_summary || null, d.claude_helpfulness || null, d.session_type || null
            );
            if (r.changes > 0) importedFacets++;
          } catch (_) { /* skip malformed files */ }
        }
      }
    });
    syncAll();
    res.json({ ok: true, importedSessions, importedFacets });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Import: accept sessions + facets via POST body (for pushing to remote environments)
app.post('/api/dev-insights/import', requireAuth, express.json({ limit: '5mb' }), (req, res) => {
  try {
    const { sessions = [], facets = [] } = req.body || {};
    if (!sessions.length && !facets.length) return res.status(400).json({ ok: false, error: 'Provide sessions and/or facets arrays' });

    let importedSessions = 0, importedFacets = 0;
    const insertSession = db.prepare(`INSERT OR IGNORE INTO dev_sessions
      (session_id, project_path, start_time, duration_minutes, user_message_count, assistant_message_count,
       tool_counts, tool_errors, tool_error_categories, lines_added, lines_removed, files_modified,
       git_commits, languages, uses_mcp)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insertFacet = db.prepare(`INSERT OR IGNORE INTO dev_facets
      (session_id, underlying_goal, goal_categories, outcome, friction_counts, friction_detail,
       primary_success, brief_summary, claude_helpfulness, session_type)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);

    const importAll = db.transaction(() => {
      for (const d of sessions) {
        const r = insertSession.run(
          d.session_id, d.project_path || null, d.start_time || null,
          d.duration_minutes || 0, d.user_message_count || 0, d.assistant_message_count || 0,
          typeof d.tool_counts === 'string' ? d.tool_counts : JSON.stringify(d.tool_counts || {}),
          d.tool_errors || 0,
          typeof d.tool_error_categories === 'string' ? d.tool_error_categories : JSON.stringify(d.tool_error_categories || {}),
          d.lines_added || 0, d.lines_removed || 0, d.files_modified || 0,
          d.git_commits || 0,
          typeof d.languages === 'string' ? d.languages : JSON.stringify(d.languages || {}),
          d.uses_mcp ? 1 : 0
        );
        if (r.changes > 0) importedSessions++;
      }
      for (const d of facets) {
        const r = insertFacet.run(
          d.session_id, d.underlying_goal || null,
          typeof d.goal_categories === 'string' ? d.goal_categories : JSON.stringify(d.goal_categories || {}),
          d.outcome || null,
          typeof d.friction_counts === 'string' ? d.friction_counts : JSON.stringify(d.friction_counts || {}),
          d.friction_detail || null, d.primary_success || null,
          d.brief_summary || null, d.claude_helpfulness || null, d.session_type || null
        );
        if (r.changes > 0) importedFacets++;
      }
    });
    importAll();
    res.json({ ok: true, importedSessions, importedFacets });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Export: return all synced data (for pushing to another environment)
app.get('/api/dev-insights/export', requireAuth, (req, res) => {
  try {
    const sessions = db.prepare('SELECT * FROM dev_sessions').all();
    const facets = db.prepare('SELECT * FROM dev_facets').all();
    res.json({ ok: true, sessions, facets });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Auto-ticket: create tickets for friction items and failed outcomes
app.post('/api/dev-insights/auto-ticket', requireAuth, (req, res) => {
  try {
    const facets = db.prepare('SELECT * FROM dev_facets').all();
    const sessions = db.prepare('SELECT * FROM dev_sessions').all();
    const sessionMap = {};
    sessions.forEach(s => { sessionMap[s.session_id] = s; });

    let created = 0;
    const checkDup = db.prepare('SELECT 1 FROM dev_insight_tickets WHERE session_id = ? AND insight_type = ? AND insight_key = ?');
    const insertTracker = db.prepare('INSERT INTO dev_insight_tickets (session_id, insight_type, insight_key, ticket_id, action_item_id) VALUES (?,?,?,?,?)');

    const createInsightTicket = db.transaction((sessionId, insightType, insightKey, title, description, urgency) => {
      if (checkDup.get(sessionId, insightType, insightKey)) return null;
      const urg = urgency || 'this_month';
      const result = db.prepare('INSERT INTO action_items (title, description, urgency, priority, tools_to_use, status) VALUES (?,?,?,?,?,?)')
        .run(title, description || null, urg, 50, null, 'pending');
      const actionId = result.lastInsertRowid;
      const ticketId = uuid();
      db.prepare(`INSERT INTO tickets (id, title, description, ticket_type, category, status, priority, action_item_id, tags, created_by)
        VALUES (?, ?, ?, 'internal', 'dev-insight', 'backlog', ?, ?, 'dev-insight,claude-code', 'system')`)
        .run(ticketId, title, description || null, urgencyToPriority(urg), actionId);
      db.prepare('UPDATE action_items SET ticket_id = ? WHERE id = ?').run(ticketId, actionId);
      insertTracker.run(sessionId, insightType, insightKey, ticketId, actionId);
      return { ticketId, actionId };
    });

    for (const f of facets) {
      const fc = JSON.parse(f.friction_counts || '{}');
      const goal = f.underlying_goal || f.brief_summary || 'Unknown session';
      const detail = f.friction_detail || '';

      // Friction triggers
      if ((fc.buggy_code || 0) > 0) {
        const r = createInsightTicket(f.session_id, 'friction', `buggy_code:${f.session_id}`,
          `Dev Friction: Buggy code in session`, `${goal}\n\nFriction: ${detail}`, 'this_week');
        if (r) created++;
      }
      if ((fc.wrong_approach || 0) > 0) {
        const r = createInsightTicket(f.session_id, 'friction', `wrong_approach:${f.session_id}`,
          `Dev Friction: Wrong approach taken`, `${goal}\n\nFriction: ${detail}`, 'this_week');
        if (r) created++;
      }
      if ((fc.excessive_changes || 0) > 0) {
        const r = createInsightTicket(f.session_id, 'friction', `excessive_changes:${f.session_id}`,
          `Dev Friction: Excessive changes`, `${goal}\n\nFriction: ${detail}`, 'next_2_weeks');
        if (r) created++;
      }

      // Outcome triggers
      if (f.outcome === 'not_achieved') {
        const r = createInsightTicket(f.session_id, 'failed_outcome', f.session_id,
          `Dev: Goal not achieved`, `${goal}\n\nFriction: ${detail}`, 'this_week');
        if (r) created++;
      }
      if (f.outcome === 'partially_achieved') {
        const r = createInsightTicket(f.session_id, 'failed_outcome', f.session_id,
          `Dev: Goal partially achieved`, `${goal}\n\nFriction: ${detail}`, 'next_2_weeks');
        if (r) created++;
      }

      // High error rate
      const sess = sessionMap[f.session_id];
      if (sess && sess.tool_errors >= 10) {
        const r = createInsightTicket(f.session_id, 'error_category', `high_errors:${f.session_id}`,
          `Dev: High error rate (${sess.tool_errors} errors)`, `${goal}\n\n${sess.tool_errors} tool errors in session`, 'next_30_days');
        if (r) created++;
      }
    }

    res.json({ ok: true, ticketsCreated: created });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Summary: aggregated dev insights metrics
app.get('/api/dev-insights/summary', requireAuth, (req, res) => {
  try {
    const sessions = db.prepare('SELECT * FROM dev_sessions').all();
    const facets = db.prepare('SELECT * FROM dev_facets').all();
    const trackers = db.prepare('SELECT session_id, insight_type, insight_key FROM dev_insight_tickets').all();
    const ticketedSet = new Set(trackers.map(t => `${t.session_id}:${t.insight_type}:${t.insight_key}`));

    const totalSessions = sessions.length;
    const totalDuration = sessions.reduce((s, r) => s + (r.duration_minutes || 0), 0);
    const avgDuration = totalSessions ? Math.round(totalDuration / totalSessions) : 0;
    const totalLinesAdded = sessions.reduce((s, r) => s + (r.lines_added || 0), 0);
    const totalLinesRemoved = sessions.reduce((s, r) => s + (r.lines_removed || 0), 0);

    // Outcome distribution
    const outcomes = {};
    facets.forEach(f => { outcomes[f.outcome || 'unknown'] = (outcomes[f.outcome || 'unknown'] || 0) + 1; });

    // Friction totals
    const frictionTotals = { buggy_code: 0, wrong_approach: 0, excessive_changes: 0, misunderstood_request: 0 };
    facets.forEach(f => {
      const fc = JSON.parse(f.friction_counts || '{}');
      Object.keys(fc).forEach(k => { frictionTotals[k] = (frictionTotals[k] || 0) + fc[k]; });
    });
    const totalFriction = Object.values(frictionTotals).reduce((a, b) => a + b, 0);

    // Success rate
    const achieved = (outcomes.fully_achieved || 0) + (outcomes.mostly_achieved || 0);
    const successRate = facets.length ? Math.round((achieved / facets.length) * 100) : 0;

    // Recent friction items
    const recentFriction = facets
      .filter(f => {
        const fc = JSON.parse(f.friction_counts || '{}');
        return Object.values(fc).some(v => v > 0) || f.outcome === 'not_achieved' || f.outcome === 'partially_achieved';
      })
      .map(f => {
        const fc = JSON.parse(f.friction_counts || '{}');
        const sess = sessions.find(s => s.session_id === f.session_id);
        const frictionTypes = Object.entries(fc).filter(([, v]) => v > 0).map(([k]) => k);
        const ticketed = frictionTypes.some(ft => ticketedSet.has(`${f.session_id}:friction:${ft}:${f.session_id}`)) ||
          ticketedSet.has(`${f.session_id}:failed_outcome:${f.session_id}`);
        return {
          session_id: f.session_id,
          goal: f.underlying_goal || f.brief_summary || 'Unknown',
          outcome: f.outcome,
          friction_types: frictionTypes,
          friction_detail: f.friction_detail,
          date: sess?.start_time || null,
          ticketed
        };
      })
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
      .slice(0, 10);

    // Unticketed count
    let unticketedCount = 0;
    facets.forEach(f => {
      const fc = JSON.parse(f.friction_counts || '{}');
      if ((fc.buggy_code || 0) > 0 && !ticketedSet.has(`${f.session_id}:friction:buggy_code:${f.session_id}`)) unticketedCount++;
      if ((fc.wrong_approach || 0) > 0 && !ticketedSet.has(`${f.session_id}:friction:wrong_approach:${f.session_id}`)) unticketedCount++;
      if (f.outcome === 'not_achieved' && !ticketedSet.has(`${f.session_id}:failed_outcome:${f.session_id}`)) unticketedCount++;
      if (f.outcome === 'partially_achieved' && !ticketedSet.has(`${f.session_id}:failed_outcome:${f.session_id}`)) unticketedCount++;
    });

    res.json({
      ok: true,
      data: {
        totalSessions, avgDuration, successRate, totalFriction,
        totalLinesAdded, totalLinesRemoved, unticketedCount,
        outcomes, frictionTotals, recentFriction
      }
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─── Financials: Stripe + QuickBooks Endpoints ─────────────────────────────

// QuickBooks OAuth flow
app.get('/api/qbo/connect', requireAuth, (req, res) => {
  try {
    const uri = qboService.getOAuthUri();
    res.redirect(uri);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/qbo/callback', async (req, res) => {
  try {
    const { code, realmId } = req.query;
    if (!code || !realmId) return res.status(400).send('Missing code or realmId');
    await qboService.handleCallback(code, realmId);
    res.send('<html><body style="background:#0d0f1a;color:#e0e0e0;font-family:Inter,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh"><div style="text-align:center"><h2 style="color:#34d399">QuickBooks Connected!</h2><p>You can close this window and return to the dashboard.</p><script>setTimeout(()=>window.close(),3000)</script></div></body></html>');
  } catch (e) {
    res.status(500).send('OAuth failed: ' + e.message);
  }
});

app.get('/api/qbo/status', requireAuth, (req, res) => {
  res.json({ ok: true, connected: qboService.isConnected() });
});

// Aggregated KPIs
app.get('/api/financials/kpis', requireAuth, async (req, res) => {
  try {
    const now = new Date();
    const yearStart = `${now.getFullYear()}-01-01`;
    const today = now.toISOString().split('T')[0];

    const [stripeBalance, qbPnl, stripeSubs] = await Promise.allSettled([
      stripeService.getBalance(),
      qboService.getProfitAndLoss(yearStart, today),
      stripeService.getSubscriptions(),
    ]);

    // Local data
    const localRevenue = db.prepare('SELECT COALESCE(SUM(amount),0) as total FROM payments').get().total;
    const localOutstanding = db.prepare(`
      SELECT COALESCE(SUM(i.total),0) - COALESCE(SUM(p.paid),0) as outstanding
      FROM invoices i LEFT JOIN (SELECT invoice_id, SUM(amount) as paid FROM payments GROUP BY invoice_id) p ON i.id = p.invoice_id
      WHERE i.status IN ('sent','overdue')
    `).get().outstanding;

    const balance = stripeBalance.status === 'fulfilled' ? stripeBalance.value.data : null;
    const pnl = qbPnl.status === 'fulfilled' ? qbPnl.value.data : null;
    const subs = stripeSubs.status === 'fulfilled' ? stripeSubs.value.data : [];

    const warnings = [];
    if (stripeBalance.status === 'rejected' || (stripeBalance.value && stripeBalance.value.error))
      warnings.push('Stripe data unavailable');
    if (qbPnl.status === 'rejected' || (qbPnl.value && qbPnl.value.error))
      warnings.push('QuickBooks data unavailable');

    res.json({
      ok: true,
      kpis: {
        totalRevenue: pnl ? pnl.totalIncome : localRevenue,
        netIncome: pnl ? pnl.netIncome : null,
        totalExpenses: pnl ? pnl.totalExpenses : null,
        grossProfit: pnl ? pnl.grossProfit : null,
        stripeBalance: balance ? { available: balance.availableTotal, pending: balance.pendingTotal } : null,
        outstandingInvoices: localOutstanding,
        activeSubscriptions: subs.length,
        localRevenue,
      },
      sources: { stripe: stripeService.isConnected(), quickbooks: qboService.isConnected() },
      warnings,
      lastUpdated: cacheService.getUpdatedAt('qbo:pnl:' + yearStart + ':' + today) || new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Merged invoices (QB + local)
app.get('/api/financials/invoices', requireAuth, async (req, res) => {
  try {
    const source = req.query.source || 'all';
    const results = [];

    if (source === 'all' || source === 'local') {
      const local = db.prepare(`
        SELECT i.*, c.company_name, COALESCE((SELECT SUM(amount) FROM payments WHERE invoice_id = i.id), 0) as paid
        FROM invoices i JOIN clients c ON i.client_id = c.id ORDER BY i.issue_date DESC
      `).all();
      results.push(...local.map(i => ({
        id: i.id, invoiceNumber: i.invoice_number, client: i.company_name,
        status: i.status, issueDate: i.issue_date, dueDate: i.due_date,
        total: i.total, paid: i.paid, balance: i.total - i.paid, source: 'local',
      })));
    }

    if (source === 'all' || source === 'quickbooks') {
      const qbResult = await qboService.getInvoices();
      if (qbResult.data) {
        results.push(...qbResult.data.map(i => ({
          id: 'qb-' + i.id, invoiceNumber: i.docNumber, client: i.customerName,
          status: i.status, issueDate: i.txnDate, dueDate: i.dueDate,
          total: i.totalAmt, paid: i.totalAmt - i.balance, balance: i.balance, source: 'quickbooks',
        })));
      }
    }

    results.sort((a, b) => (b.issueDate || '').localeCompare(a.issueDate || ''));
    res.json({ ok: true, invoices: results, sources: { stripe: stripeService.isConnected(), quickbooks: qboService.isConnected() } });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Merged payments (Stripe + local)
app.get('/api/financials/payments', requireAuth, async (req, res) => {
  try {
    const source = req.query.source || 'all';
    const results = [];

    if (source === 'all' || source === 'local') {
      const local = db.prepare(`
        SELECT p.*, i.invoice_number, c.company_name
        FROM payments p JOIN invoices i ON p.invoice_id = i.id JOIN clients c ON i.client_id = c.id
        ORDER BY p.payment_date DESC
      `).all();
      results.push(...local.map(p => ({
        id: p.id, date: p.payment_date, client: p.company_name,
        amount: p.amount, method: p.payment_method, reference: p.reference_number || p.invoice_number,
        status: 'completed', source: 'local',
      })));
    }

    if (source === 'all' || source === 'stripe') {
      const stripeResult = await stripeService.getPaymentIntents();
      if (stripeResult.data) {
        results.push(...stripeResult.data.filter(p => p.status === 'succeeded').map(p => ({
          id: p.id, date: p.created, client: p.customerEmail || p.description || 'Stripe Payment',
          amount: p.amount, method: p.paymentMethod || 'card', reference: p.id,
          status: p.status, source: 'stripe',
        })));
      }
    }

    results.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    res.json({ ok: true, payments: results, sources: { stripe: stripeService.isConnected(), quickbooks: qboService.isConnected() } });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Revenue summary (QB P&L)
app.get('/api/financials/revenue', requireAuth, async (req, res) => {
  try {
    const now = new Date();
    const startDate = req.query.start || `${now.getFullYear()}-01-01`;
    const endDate = req.query.end || now.toISOString().split('T')[0];
    const result = await qboService.getProfitAndLoss(startDate, endDate);
    res.json({ ok: true, revenue: result.data, stale: result.stale || false, error: result.error || null,
      sources: { stripe: stripeService.isConnected(), quickbooks: qboService.isConnected() } });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Monthly revenue breakdown for charts
app.get('/api/financials/revenue/monthly', requireAuth, async (req, res) => {
  try {
    const year = req.query.year || new Date().getFullYear();
    const result = await qboService.getProfitAndLossMonthly(year);
    res.json({ ok: true, monthly: result.data, stale: result.stale || false, error: result.error || null,
      sources: { stripe: stripeService.isConnected(), quickbooks: qboService.isConnected() } });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Stripe balance
app.get('/api/stripe/balance', requireAuth, async (req, res) => {
  try {
    const result = await stripeService.getBalance();
    res.json({ ok: true, balance: result.data, stale: result.stale || false, error: result.error || null });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Stripe customers
app.get('/api/stripe/customers', requireAuth, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const result = await stripeService.getCustomers(limit);
    res.json({ ok: true, customers: result.data, stale: result.stale || false, error: result.error || null });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Stripe products & subscriptions
app.get('/api/stripe/products', requireAuth, async (req, res) => {
  try {
    const result = await stripeService.getProducts();
    res.json({ ok: true, products: result.data, error: result.error || null });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/stripe/subscriptions', requireAuth, async (req, res) => {
  try {
    const result = await stripeService.getSubscriptions();
    res.json({ ok: true, subscriptions: result.data, error: result.error || null });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Cache refresh
app.post('/api/financials/refresh', requireAuth, (req, res) => {
  const cleared = cacheService.invalidateAll();
  res.json({ ok: true, message: 'Cache cleared', cleared });
});

// ─── Environment info endpoint ─────────────────────────────────────────────
app.get('/api/env', requireAuth, (req, res) => {
  res.json({ ok: true, environment: APP_ENV });
});

// ─── Auto-seed demo environment ────────────────────────────────────────────
if (APP_ENV === 'demo') {
  try {
    const clientCount = db.prepare('SELECT COUNT(*) as n FROM clients').get().n;
    if (clientCount === 0) {
      console.log('Demo environment detected with empty DB — running seed...');
      require('child_process').execSync('node seed-demo.js --reset', {
        stdio: 'inherit',
        cwd: __dirname,
        env: { ...process.env, DB_PATH }  // pass persistent volume path to child
      });
      console.log('Demo seed complete.');
    }
  } catch (e) { console.error('Demo auto-seed failed:', e.message); }
}

// ─── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  PRISM AI Analytics Dashboard (v2.0 — Hardened)`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  Environment: ${APP_ENV}`);
  console.log(`  Auth: ${API_KEY ? 'API key + user login' : 'User login (set API_KEY for external access)'}\n`);
});
