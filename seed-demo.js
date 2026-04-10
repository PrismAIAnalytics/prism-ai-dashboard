// seed-demo.js — Populate demo environment with fictional data
// Usage: node seed-demo.js [--reset]
// --reset: drops and recreates all data (use for fresh demo resets)

const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'prism.db');
const RESET = process.argv.includes('--reset');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function uid() { return crypto.randomUUID(); }
function fmtDate(d) { return d.toISOString().split('T')[0]; }
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return fmtDate(d); }

if (RESET) {
  console.log('Resetting demo data...');
  const tables = [
    'action_items', 'maturity_scores', 'business_assets', 'tools',
    'benchmark_rules', 'benchmark_products',
    'ticket_comments', 'tickets', 'documents', 'daily_reviews',
    'training_notes', 'training_progress', 'training_topics', 'training_domains', 'training_programs',
    'certifications', 'ai_readiness_assessments',
    'referrals', 'referral_partners',
    'activity_log', 'time_entries', 'expenses', 'payments', 'invoices',
    'retainers', 'milestones', 'projects',
    'leads', 'lead_sources', 'contacts', 'clients',
    'services', 'team_members', 'industries',
    'sessions', 'users'
  ];
  tables.forEach(t => { try { db.prepare(`DELETE FROM ${t}`).run(); } catch(e) {} });
  console.log('All tables cleared.');
}

// ─── Industries ───
const industryNames = ['Technology', 'Healthcare', 'Retail', 'Hospitality', 'Financial Services', 'Real Estate', 'Professional Services', 'Manufacturing'];
const insInd = db.prepare('INSERT OR IGNORE INTO industries (name) VALUES (?)');
industryNames.forEach(i => insInd.run(i));
// Build lookup: name -> id
const industryLookup = {};
db.prepare('SELECT id, name FROM industries').all().forEach(r => { industryLookup[r.name] = r.id; });

// ─── Services (matches real Prism tiers) ───
const services = [
  ['AI Readiness Assessment', 'assessment', 500, 2500, 'fixed'],
  ['Analytics & Reporting Modernization', 'project', 3000, 10000, 'project'],
  ['AI Workflow Automation', 'project', 5000, 15000, 'project'],
  ['Fractional AI Advisor', 'retainer', 2000, 5000, 'monthly'],
  ['Analytics Support Retainer', 'retainer', 1000, 3000, 'monthly'],
];
const insSvc = db.prepare('INSERT OR IGNORE INTO services (name, service_type, price_min, price_max, price_unit) VALUES (?,?,?,?,?)');
services.forEach(s => insSvc.run(...s));
// Build lookup: name -> id
const serviceLookup = {};
db.prepare('SELECT id, name FROM services').all().forEach(r => { serviceLookup[r.name] = r.id; });

// ─── Team Members ───
const michele_id = uid();
const izayah_id = uid();
db.prepare('INSERT OR REPLACE INTO team_members (id, first_name, last_name, email, role, title, hourly_rate, start_date) VALUES (?,?,?,?,?,?,?,?)')
  .run(michele_id, 'Michele', 'Fisher', 'michele@prismaianalytics.com', 'founder', 'Founder & Principal Consultant', 150, '2026-02-01');
db.prepare('INSERT OR REPLACE INTO team_members (id, first_name, last_name, email, role, title, hourly_rate, start_date) VALUES (?,?,?,?,?,?,?,?)')
  .run(izayah_id, 'Izayah', 'Fisher', 'izayah@prismaianalytics.com', 'associate', 'Junior Analyst', 50, '2026-03-01');

// ─── Lead Sources ───
const leadSources = [['LinkedIn','social'], ['Referral','partner'], ['Website','organic'], ['Conference','event'], ['Cold Outreach','direct']];
const insLS = db.prepare('INSERT OR IGNORE INTO lead_sources (name, channel) VALUES (?, ?)');
leadSources.forEach(ls => insLS.run(...ls));

// ─── Demo Clients (fictional) ───
const demoClients = [
  { company: 'Bloom Creative Agency', industry: 'Retail', size: '11-50', city: 'Charlotte', state: 'NC', status: 'Active Client', budget: 3000, service: 'Fractional AI Advisor', contact: ['Sarah', 'Chen', 'sarah@bloomcreative.demo', '704-555-0101'] },
  { company: 'Cafe Uvee', industry: 'Hospitality', size: '1-10', city: 'Charlotte', state: 'NC', status: 'Active Client', budget: 1500, service: 'Analytics Support Retainer', contact: ['Marcus', 'Thompson', 'marcus@cafeuvee.demo', '704-555-0202'] },
  { company: 'Meridian Health Partners', industry: 'Healthcare', size: '51-200', city: 'Raleigh', state: 'NC', status: 'Proposal Sent', budget: 12000, service: 'AI Workflow Automation', contact: ['Dr. Lisa', 'Patel', 'lpatel@meridianhp.demo', '919-555-0303'] },
  { company: 'Parkside Properties', industry: 'Real Estate', size: '11-50', city: 'Charlotte', state: 'NC', status: 'Discovery', budget: 2500, service: 'AI Readiness Assessment', contact: ['James', 'Rodriguez', 'james@parksideprop.demo', '704-555-0404'] },
  { company: 'Summit Financial Advisors', industry: 'Financial Services', size: '11-50', city: 'Asheville', state: 'NC', status: 'Qualified Lead', budget: 8000, service: 'Analytics & Reporting Modernization', contact: ['Amanda', 'Brooks', 'abrooks@summitfa.demo', '828-555-0505'] },
  { company: 'TechForge Solutions', industry: 'Technology', size: '51-200', city: 'Durham', state: 'NC', status: 'Active Client', budget: 15000, service: 'AI Workflow Automation', contact: ['Kevin', 'Walsh', 'kwalsh@techforge.demo', '919-555-0606'] },
  { company: 'Magnolia Boutique Hotel', industry: 'Hospitality', size: '11-50', city: 'Charleston', state: 'SC', status: 'New Lead', budget: 2000, service: 'AI Readiness Assessment', contact: ['Diana', 'Summers', 'diana@magnoliabh.demo', '843-555-0707'] },
  { company: 'Precision Manufacturing Co', industry: 'Manufacturing', size: '201-500', city: 'Greensboro', state: 'NC', status: 'Negotiation', budget: 20000, service: 'Analytics & Reporting Modernization', contact: ['Robert', 'Kim', 'rkim@precisionmfg.demo', '336-555-0808'] },
];

const insCli = db.prepare('INSERT INTO clients (id, company_name, industry_id, company_size, city, state, acquired_date, is_active, crm_status, crm_budget, crm_service, crm_contact_name, crm_contact_email, crm_contact_phone) VALUES (?,?,?,?,?,?,?,1,?,?,?,?,?,?)');
const insCon = db.prepare('INSERT INTO contacts (id, client_id, first_name, last_name, email, phone, is_primary) VALUES (?,?,?,?,?,?,1)');

const clientIds = [];
demoClients.forEach((c, i) => {
  const cid = uid();
  clientIds.push(cid);
  insCli.run(cid, c.company, industryLookup[c.industry], c.size, c.city, c.state, daysAgo(90 - i * 10), c.status, c.budget, c.service, `${c.contact[0]} ${c.contact[1]}`, c.contact[2], c.contact[3]);
  insCon.run(uid(), cid, c.contact[0], c.contact[1], c.contact[2], c.contact[3]);
});

// ─── Projects for active clients ───
const insProj = db.prepare('INSERT INTO projects (id, client_id, service_id, assigned_to, name, status, budget, start_date, target_end_date) VALUES (?,?,?,?,?,?,?,?,?)');
const projIds = [];

[
  [0, 'Fractional AI Advisor', 'Bloom Creative — AI Content Strategy', 'active', 3000, 60, 30],
  [1, 'Analytics Support Retainer', 'Cafe Uvee — POS Analytics Dashboard', 'active', 1500, 45, 15],
  [5, 'AI Workflow Automation', 'TechForge — Workflow Automation Phase 1', 'active', 15000, 30, 60],
  [2, 'AI Workflow Automation', 'Meridian Health — AI Workflow Proposal', 'scoping', 12000, 10, 80],
  [7, 'Analytics & Reporting Modernization', 'Precision Mfg — Reporting Assessment', 'scoping', 20000, 5, 85],
].forEach(([ci, svcName, name, status, budget, startAgo, endFromNow]) => {
  const pid = uid();
  projIds.push(pid);
  insProj.run(pid, clientIds[ci], serviceLookup[svcName], michele_id, name, status, budget, daysAgo(startAgo), daysAgo(-endFromNow));
});

// ─── Invoices & Payments ───
const insInv = db.prepare('INSERT INTO invoices (id, invoice_number, client_id, project_id, status, issue_date, due_date, subtotal, total) VALUES (?,?,?,?,?,?,?,?,?)');
const insPay = db.prepare('INSERT INTO payments (id, invoice_id, amount, payment_date, payment_method) VALUES (?,?,?,?,?)');

const invoiceData = [
  [0, 0, 'PRISM-2026-001', 'paid', 2500, 60, 30],
  [1, 1, 'PRISM-2026-002', 'paid', 1500, 45, 15],
  [5, 2, 'PRISM-2026-003', 'paid', 7500, 30, 0],
  [5, 2, 'PRISM-2026-004', 'sent', 7500, 5, -25],
  [0, 0, 'PRISM-2026-005', 'sent', 3000, 3, -27],
];
invoiceData.forEach(([ci, pi, num, status, amount, issueAgo, dueAgo]) => {
  const iid = uid();
  insInv.run(iid, num, clientIds[ci], projIds[pi], status, daysAgo(issueAgo), daysAgo(dueAgo), amount, amount);
  if (status === 'paid') {
    insPay.run(uid(), iid, amount, daysAgo(dueAgo > 0 ? dueAgo - 5 : 0), 'Stripe');
  }
});

// ─── Expenses ───
const insExp = db.prepare('INSERT INTO expenses (id, category, vendor, description, amount, expense_date, is_recurring, recurrence_freq) VALUES (?,?,?,?,?,?,?,?)');
[
  ['Software', 'Railway', 'Dashboard hosting', 5.00, 30, 1, 'monthly'],
  ['Software', 'Claude', 'Claude Pro subscription', 20.00, 30, 1, 'monthly'],
  ['Software', 'Stripe', 'Payment processing fees', 12.50, 15, 1, 'monthly'],
  ['Marketing', 'Canva', 'Design tools', 12.99, 30, 1, 'monthly'],
  ['Legal', 'LegalZoom', 'LLC annual filing', 150.00, 60, 0, null],
  ['Office', 'Google', 'Workspace subscription', 7.20, 30, 1, 'monthly'],
  ['Training', 'Coursera', 'Google AI Essentials', 49.00, 20, 0, null],
].forEach(([cat, vendor, desc, amount, dAgo, recurring, freq]) => {
  insExp.run(uid(), cat, vendor, desc, amount, daysAgo(dAgo), recurring, freq);
});

// ─── Time Entries ───
const insTime = db.prepare('INSERT INTO time_entries (team_member_id, project_id, client_id, entry_date, hours, description, is_billable) VALUES (?,?,?,?,?,?,1)');
for (let d = 0; d < 30; d++) {
  if (d % 7 === 0 || d % 7 === 6) continue; // skip weekends
  const entries = [
    [michele_id, projIds[0], clientIds[0], 2 + Math.random(), 'Client strategy & content review'],
    [michele_id, projIds[1], clientIds[1], 1.5 + Math.random(), 'Dashboard development & data analysis'],
    [michele_id, projIds[2], clientIds[5], 3 + Math.random() * 2, 'Automation workflow design'],
  ];
  entries.forEach(([tm, proj, cli, hrs, desc]) => {
    insTime.run(tm, proj, cli, daysAgo(d), Math.round(hrs * 10) / 10, desc);
  });
}

// ─── Daily Reviews (last 7 days) ───
const insReview = db.prepare('INSERT OR IGNORE INTO daily_reviews (review_date, sprint_day, sprint_week, summary, clients_revenue, sprint_progress, development, training, reminders) VALUES (?,?,?,?,?,?,?,?,?)');
for (let d = 6; d >= 0; d--) {
  const sprintDay = 22 - d;
  insReview.run(
    daysAgo(d), sprintDay, Math.ceil(sprintDay / 7),
    `Demo daily review — Sprint Day ${sprintDay}. Dashboard development, client work, and training progressing on schedule.`,
    'Bloom Creative retainer active. Cafe Uvee analytics on track. TechForge automation Phase 1 at 60%.',
    `Sprint Day ${sprintDay}: ${3 - Math.floor(d/3)} tasks completed this week.`,
    'CRM dashboard improvements, Stripe integration testing, Financials page development.',
    'Google AI Essentials certification in progress. Claude API tool-use training ongoing.',
    'Bloom Creative monthly check-in next week. Precision Mfg proposal due in 2 weeks.'
  );
}

// ─── Activity Log ───
const insAct = db.prepare('INSERT INTO activity_log (entity_type, entity_id, team_member_id, action, summary, logged_at) VALUES (?,?,?,?,?,?)');
[
  ['client', clientIds[0], 'Status updated to Active Client', 60],
  ['client', clientIds[1], 'Status updated to Active Client', 45],
  ['client', clientIds[5], 'Status updated to Active Client', 30],
  ['project', projIds[0], 'Project kicked off — AI Content Strategy', 58],
  ['project', projIds[2], 'Phase 1 milestone: workflow mapping complete', 15],
  ['invoice', 'inv', 'Invoice PRISM-2026-003 paid via Stripe', 10],
  ['client', clientIds[3], 'Discovery call scheduled', 5],
  ['client', clientIds[7], 'Proposal draft started', 3],
].forEach(([type, eid, summary, dAgo]) => {
  insAct.run(type, eid, michele_id, type === 'invoice' ? 'payment_received' : 'update', summary, new Date(Date.now() - dAgo * 86400000).toISOString());
});

// ─── Users (demo login) ───
const salt = crypto.randomBytes(16).toString('hex');
const hash = crypto.scryptSync('demo2026', salt, 64).toString('hex');
db.prepare('INSERT OR REPLACE INTO users (id, username, password_hash, salt, team_member_id, role) VALUES (?,?,?,?,?,?)')
  .run(uid(), 'michele', hash, salt, michele_id, 'admin');

// Create a second demo user
const salt2 = crypto.randomBytes(16).toString('hex');
const hash2 = crypto.scryptSync('demo2026', salt2, 64).toString('hex');
db.prepare('INSERT OR REPLACE INTO users (id, username, password_hash, salt, team_member_id, role) VALUES (?,?,?,?,?,?)')
  .run(uid(), 'demo', hash2, salt2, null, 'viewer');

console.log('Demo seed complete!');
console.log('  Login: michele / demo2026  OR  demo / demo2026');
console.log('  Clients:', demoClients.length);
console.log('  Projects:', projIds.length);
console.log('  Invoices:', invoiceData.length);
console.log('  Daily reviews: 7');
console.log('  Time entries: ~' + (22 * 3) + ' (30 days, weekdays)');
db.close();
