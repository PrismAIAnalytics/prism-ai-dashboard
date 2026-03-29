// ─────────────────────────────────────────────────────────────────────────────
// PRISM AI Analytics — Admin Dashboard API (v2.0 — Hardened)
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { body, param, validationResult } = require('express-validator');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Security middleware ────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc:   ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc:    ["'self'", "https://fonts.gstatic.com"],
      scriptSrc:  ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
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
const fs = require('fs');

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
  `);
  // Auth tables
  db.exec(`
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
  `);
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

  // Industries
  const industries = ['Finance','Healthcare','Retail','Hospitality','Real Estate','Professional Services','Technology','Manufacturing','Education','Nonprofit'];
  const insInd = db.prepare('INSERT INTO industries (name) VALUES (?)');
  industries.forEach(n => insInd.run(n));

  // Lead sources
  const sources = [['LinkedIn','social'],['Website/SEO','organic'],['Google Business Profile','organic'],['Email Newsletter','email'],['Charlotte Chamber','event'],['SBDC Partnership','referral'],['Speaking Engagement','event'],['Client Referral','referral'],['Partner Referral','referral'],['Cold Outreach','outbound']];
  const insLS = db.prepare('INSERT INTO lead_sources (name, channel) VALUES (?, ?)');
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
  ];
  const insSvc = db.prepare('INSERT INTO services (name, service_type, price_min, price_max, price_unit) VALUES (?,?,?,?,?)');
  svcs.forEach(s => insSvc.run(...s));

  // Founder
  const mId = uuid();
  db.prepare('INSERT INTO team_members (id, first_name, last_name, email, role, title, hourly_rate, start_date) VALUES (?,?,?,?,?,?,?,?)')
    .run(mId, 'Michele', 'Fisher', 'michele@prismaianalytics.com', 'founder', 'Founder & AI Analytics Consultant', 135, '2026-03-01');

  // Certifications
  const certs = [['Google AI Essentials','Google / Coursera','in_progress'],['PL-300: Power BI Data Analyst','Microsoft Learn','planned'],['AI for Everyone','Coursera / Andrew Ng','planned'],['AWS Certified AI Practitioner','AWS','planned'],['AI for Business Strategy','Wharton / Coursera','planned']];
  const insCert = db.prepare('INSERT INTO certifications (team_member_id, name, provider, status) VALUES (?,?,?,?)');
  certs.forEach(c => insCert.run(mId, ...c));

  // Junior Engineer — Izayah Fisher
  const izId = uuid();
  db.prepare('INSERT INTO team_members (id, first_name, last_name, email, role, title, hourly_rate, start_date) VALUES (?,?,?,?,?,?,?,?)')
    .run(izId, 'Izayah', 'Fisher', 'izayah@prismaianalytics.com', 'contractor', 'Junior AI/ML Engineer', 45, '2026-03-15');

  // CCA Foundations Training Program
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

seedIfEmpty();
seedUsersIfEmpty();

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

// ─── Daily Review ────────────────────────────────────────────────────────────
app.get('/api/daily-review', requireAuth, (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const monthStart = today.slice(0, 7) + '-01';

    // ── KPI snapshot ──
    const totalRevenue = db.prepare('SELECT COALESCE(SUM(amount),0) as v FROM payments').get().v;
    const outstandingInvoices = db.prepare(`
      SELECT COALESCE(SUM(i.total),0) - COALESCE(SUM(p.paid),0) as v
      FROM invoices i
      LEFT JOIN (SELECT invoice_id, SUM(amount) as paid FROM payments GROUP BY invoice_id) p ON i.id = p.invoice_id
      WHERE i.status IN ('sent','overdue')
    `).get().v;
    const pipelineValue = db.prepare(`SELECT COALESCE(SUM(estimated_value),0) as v FROM leads WHERE status NOT IN ('won','lost')`).get().v;
    const activeClients = db.prepare('SELECT COUNT(*) as v FROM clients WHERE is_active = 1').get().v;
    const activeProjects = db.prepare("SELECT COUNT(*) as v FROM projects WHERE status = 'active'").get().v;
    const activeRetainers = db.prepare("SELECT COUNT(*) as v FROM retainers WHERE status = 'active'").get().v;

    // ── Client activity (recent 7 days) ──
    const newClients = db.prepare(`SELECT COUNT(*) as v FROM clients WHERE created_at >= date('now', '-7 days')`).get().v;
    const clientList = db.prepare(`
      SELECT c.company_name, c.is_active, i.name as industry,
        (SELECT COALESCE(SUM(p.amount),0) FROM invoices inv JOIN payments p ON inv.id = p.invoice_id WHERE inv.client_id = c.id) as lifetime_revenue
      FROM clients c LEFT JOIN industries i ON c.industry_id = i.id
      WHERE c.is_active = 1 ORDER BY lifetime_revenue DESC LIMIT 5
    `).all();

    // ── Pipeline summary ──
    const pipelineByStage = db.prepare(`
      SELECT status, COUNT(*) as count, COALESCE(SUM(estimated_value),0) as value
      FROM leads WHERE status NOT IN ('won','lost')
      GROUP BY status ORDER BY count DESC
    `).all();
    const recentWins = db.prepare(`
      SELECT l.*, c.company_name
      FROM leads l LEFT JOIN clients c ON l.client_id = c.id
      WHERE l.status = 'won' ORDER BY l.close_date DESC LIMIT 3
    `).all();

    // ── Project status ──
    const projects = db.prepare(`
      SELECT p.id, p.name, p.status, p.budget, p.start_date, p.target_end_date,
        c.company_name as client_name
      FROM projects p JOIN clients c ON p.client_id = c.id
      WHERE p.status = 'active' ORDER BY p.target_end_date ASC
    `).all();
    // Get milestone progress for each active project
    const projectsWithProgress = projects.map(p => {
      const ms = db.prepare('SELECT status FROM milestones WHERE project_id = ?').all(p.id);
      const done = ms.filter(m => m.status === 'completed').length;
      return { ...p, milestones_total: ms.length, milestones_done: done, progress: ms.length ? Math.round(done / ms.length * 100) : 0 };
    });

    // ── Finance snapshot ──
    const monthRevenue = db.prepare(`SELECT COALESCE(SUM(amount),0) as v FROM payments WHERE payment_date >= ?`).get(monthStart).v;
    const overdueInvoices = db.prepare(`
      SELECT i.invoice_number, i.total, i.due_date, c.company_name
      FROM invoices i JOIN clients c ON i.client_id = c.id
      WHERE i.status = 'overdue' ORDER BY i.due_date ASC
    `).all();
    const monthExpenses = db.prepare(`SELECT COALESCE(SUM(amount),0) as v FROM expenses WHERE expense_date >= ?`).get(monthStart).v;
    const recurringExpenses = db.prepare(`SELECT COALESCE(SUM(amount),0) as v FROM expenses WHERE is_recurring = 1`).get().v;

    // ── Time tracking (this month) ──
    const monthHours = db.prepare(`SELECT COALESCE(SUM(hours),0) as v FROM time_entries WHERE entry_date >= ?`).get(monthStart).v;
    const billableHours = db.prepare(`SELECT COALESCE(SUM(hours),0) as v FROM time_entries WHERE entry_date >= ? AND is_billable = 1`).get(monthStart).v;

    // ── Recent activity ──
    const recentActivity = db.prepare(`
      SELECT a.*, tm.first_name || ' ' || tm.last_name as team_member_name
      FROM activity_log a LEFT JOIN team_members tm ON a.team_member_id = tm.id
      ORDER BY a.logged_at DESC LIMIT 10
    `).all();

    // ── Upcoming deadlines (next 14 days) ──
    const upcomingDeadlines = [];
    // Project deadlines
    const projDeadlines = db.prepare(`
      SELECT name, target_end_date as due_date, 'project' as type, status
      FROM projects WHERE status = 'active' AND target_end_date <= date('now', '+14 days') AND target_end_date >= date('now')
      ORDER BY target_end_date ASC
    `).all();
    upcomingDeadlines.push(...projDeadlines);
    // Invoice due dates
    const invDeadlines = db.prepare(`
      SELECT i.invoice_number as name, i.due_date, 'invoice' as type, i.status
      FROM invoices i WHERE i.status IN ('sent','overdue') AND i.due_date <= date('now', '+14 days') AND i.due_date >= date('now')
      ORDER BY i.due_date ASC
    `).all();
    upcomingDeadlines.push(...invDeadlines);
    // Retainer renewals
    const retDeadlines = db.prepare(`
      SELECT c.company_name as name, r.end_date as due_date, 'retainer' as type, r.status
      FROM retainers r JOIN clients c ON r.client_id = c.id
      WHERE r.status = 'active' AND r.end_date <= date('now', '+14 days') AND r.end_date >= date('now')
      ORDER BY r.end_date ASC
    `).all();
    upcomingDeadlines.push(...retDeadlines);
    // Milestone deadlines
    const msDeadlines = db.prepare(`
      SELECT m.name, m.due_date, 'milestone' as type, m.status
      FROM milestones m JOIN projects p ON m.project_id = p.id
      WHERE p.status = 'active' AND m.status != 'completed' AND m.due_date <= date('now', '+14 days') AND m.due_date >= date('now')
      ORDER BY m.due_date ASC
    `).all();
    upcomingDeadlines.push(...msDeadlines);
    upcomingDeadlines.sort((a, b) => (a.due_date || '').localeCompare(b.due_date || ''));

    // ── Training progress ──
    let trainingProgress = [];
    try {
      const programs = db.prepare('SELECT * FROM training_programs').all();
      const members = db.prepare('SELECT * FROM team_members WHERE status = ?').all('active');
      trainingProgress = programs.map(prog => {
        const memberProgress = members.map(m => {
          const total = db.prepare('SELECT COUNT(*) as v FROM training_topics t JOIN training_domains d ON t.domain_id = d.id WHERE d.program_id = ?').get(prog.id).v;
          const done = db.prepare('SELECT COUNT(*) as v FROM training_progress tp JOIN training_topics t ON tp.topic_id = t.id JOIN training_domains d ON t.domain_id = d.id WHERE d.program_id = ? AND tp.team_member_id = ? AND tp.completed = 1').get(prog.id, m.id).v;
          return { name: m.first_name + ' ' + m.last_name, total, done, pct: total ? Math.round(done / total * 100) : 0 };
        });
        return { program: prog.name, provider: prog.provider, members: memberProgress };
      });
    } catch(e) { /* training tables might not exist */ }

    // ── Certifications ──
    let certs = [];
    try { certs = db.prepare('SELECT c.*, tm.first_name || \' \' || tm.last_name as member_name FROM certifications c JOIN team_members tm ON c.team_member_id = tm.id ORDER BY c.completion_date DESC').all(); } catch(e) {}

    res.json({
      date: today,
      kpis: { totalRevenue, outstandingInvoices, pipelineValue, activeClients, activeProjects, activeRetainers, monthRevenue, monthExpenses, recurringExpenses, monthHours, billableHours },
      clients: { active: activeClients, newThisWeek: newClients, topClients: clientList },
      pipeline: { byStage: pipelineByStage, recentWins },
      projects: projectsWithProgress,
      finance: { overdueInvoices },
      time: { monthHours, billableHours },
      deadlines: upcomingDeadlines,
      activity: recentActivity,
      training: trainingProgress,
      certifications: certs
    });
  } catch (e) {
    console.error('[daily-review]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Global error handler ───────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('[ERROR]', err.stack || err.message);
  res.status(500).json({ ok: false, error: 'Internal server error' });
});

// ─── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  PRISM AI Analytics Dashboard (v2.0 — Hardened)`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  Auth: ${API_KEY ? 'API key + user login' : 'User login (set API_KEY for external access)'}\n`);
});
