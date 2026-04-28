# Claude Code Handoff — Demo/UAT Environment Setup

**Date:** April 10, 2026  
**Project:** Prism AI CRM Dashboard  
**Repo:** `prismai-dotcom/prism-ai-dashboard` (GitHub, private)  
**Goal:** Create a separate demo/UAT instance with seed data for client demos, testing, and development — alongside the existing production instance.

---

## Architecture

```
GitHub Repo: prismai-dotcom/prism-ai-dashboard
├── main branch ──────► Railway Service: "prism-dashboard-prod"
│                        URL: web-production-7058a.up.railway.app
│                        DB:  prism.db (live data)
│
└── staging branch ───► Railway Service: "prism-dashboard-demo"
                         URL: (auto-generated, then demo.prismaianalytics.com)
                         DB:  prism.db (seed data, safe to reset)
```

Both services run the same codebase. The `staging` branch tracks `main` and can optionally include demo-specific tweaks (banner, seed data flag, etc.).

---

## Step 0 — Prerequisites

Before starting, resolve the git state in the dashboard directory:

```bash
cd <dashboard-directory>

# Remove stale lock file from previous Cowork session
rm -f .git/index.lock

# Commit the uncommitted Stripe/QB integration work
git add .env.example CLAUDE.md package.json package-lock.json public/index.html services/cacheService.js services/stripeService.js services/quickbooksService.js test.http
git commit -m "Add Stripe & QuickBooks integration with Financials dashboard"

# Push all pending commits (3 prior + 1 new = 4 total)
git push origin main
```

Verify Railway auto-deploys the production instance successfully before proceeding.

---

## Step 1 — Add environment indicator to the app

Add a small environment-awareness feature so the demo instance shows a banner. Edit `server.js`:

```javascript
// Near the top, after existing env vars
const APP_ENV = process.env.APP_ENV || 'production';

// Add a new endpoint
app.get('/api/env', requireAuth, (req, res) => {
  res.json({ ok: true, environment: APP_ENV });
});
```

Edit `public/index.html` — add a demo banner that only appears when `APP_ENV !== 'production'`:

```javascript
// In the page init / DOMContentLoaded section, after login check:
async function checkEnvBanner() {
  try {
    const d = await api('env');
    if (d.environment && d.environment !== 'production') {
      const banner = document.createElement('div');
      banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:999;background:linear-gradient(90deg,#fbbf24,#f59e0b);color:#1a1a2e;text-align:center;padding:6px;font-size:12px;font-weight:700;letter-spacing:1px;';
      banner.textContent = '⚠ DEMO / UAT ENVIRONMENT — NOT PRODUCTION DATA';
      document.body.prepend(banner);
      document.querySelector('nav').style.top = '30px';
      document.querySelector('.main').style.paddingTop = '30px';
    }
  } catch(e) {}
}
checkEnvBanner();
```

---

## Step 2 — Create the seed data script

Create `seed-demo.js` in the project root. This populates realistic but fictional data for demos.

```javascript
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
const industries = ['Technology', 'Healthcare', 'Retail', 'Hospitality', 'Financial Services', 'Real Estate', 'Professional Services', 'Manufacturing'];
const insInd = db.prepare('INSERT OR IGNORE INTO industries (name) VALUES (?)');
industries.forEach(i => insInd.run(i));

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

// ─── Team Members ───
const michele_id = uid();
const izayah_id = uid();
db.prepare('INSERT INTO team_members (id, first_name, last_name, email, role, title, hourly_rate, start_date) VALUES (?,?,?,?,?,?,?,?)')
  .run(michele_id, 'Michele', 'Fisher', 'michele@prismaianalytics.com', 'founder', 'Founder & Principal Consultant', 150, '2026-02-01');
db.prepare('INSERT INTO team_members (id, first_name, last_name, email, role, title, hourly_rate, start_date) VALUES (?,?,?,?,?,?,?,?)')
  .run(izayah_id, 'Izayah', 'Fisher', 'izayah@prismaianalytics.com', 'associate', 'Junior Analyst', 50, '2026-03-01');

// ─── Lead Sources ───
const leadSources = [['LinkedIn','social'], ['Referral','partner'], ['Website','organic'], ['Conference','event'], ['Cold Outreach','direct']];
const insLS = db.prepare('INSERT OR IGNORE INTO lead_sources (name, channel) VALUES (?, ?)');
leadSources.forEach(ls => insLS.run(...ls));

// ─── Demo Clients (fictional) ───
const demoClients = [
  { company: 'Bloom Creative Agency', industry: 3, size: '11-50', city: 'Charlotte', state: 'NC', status: 'Active Client', budget: 3000, service: 'Fractional AI Advisor', contact: ['Sarah', 'Chen', 'sarah@bloomcreative.demo', '704-555-0101'] },
  { company: 'Cafe Uvee', industry: 4, size: '1-10', city: 'Charlotte', state: 'NC', status: 'Active Client', budget: 1500, service: 'Analytics Support Retainer', contact: ['Marcus', 'Thompson', 'marcus@cafeuvee.demo', '704-555-0202'] },
  { company: 'Meridian Health Partners', industry: 2, size: '51-200', city: 'Raleigh', state: 'NC', status: 'Proposal Sent', budget: 12000, service: 'AI Workflow Automation', contact: ['Dr. Lisa', 'Patel', 'lpatel@meridianhp.demo', '919-555-0303'] },
  { company: 'Parkside Properties', industry: 6, size: '11-50', city: 'Charlotte', state: 'NC', status: 'Discovery', budget: 2500, service: 'AI Readiness Assessment', contact: ['James', 'Rodriguez', 'james@parksideprop.demo', '704-555-0404'] },
  { company: 'Summit Financial Advisors', industry: 5, size: '11-50', city: 'Asheville', state: 'NC', status: 'Qualified Lead', budget: 8000, service: 'Analytics & Reporting Modernization', contact: ['Amanda', 'Brooks', 'abrooks@summitfa.demo', '828-555-0505'] },
  { company: 'TechForge Solutions', industry: 1, size: '51-200', city: 'Durham', state: 'NC', status: 'Active Client', budget: 15000, service: 'AI Workflow Automation', contact: ['Kevin', 'Walsh', 'kwalsh@techforge.demo', '919-555-0606'] },
  { company: 'Magnolia Boutique Hotel', industry: 4, size: '11-50', city: 'Charleston', state: 'SC', status: 'New Lead', budget: 2000, service: 'AI Readiness Assessment', contact: ['Diana', 'Summers', 'diana@magnoliabh.demo', '843-555-0707'] },
  { company: 'Precision Manufacturing Co', industry: 8, size: '201-500', city: 'Greensboro', state: 'NC', status: 'Negotiation', budget: 20000, service: 'Analytics & Reporting Modernization', contact: ['Robert', 'Kim', 'rkim@precisionmfg.demo', '336-555-0808'] },
];

const insCli = db.prepare('INSERT INTO clients (id, company_name, industry_id, company_size, city, state, acquired_date, is_active, crm_status, crm_budget, crm_service, crm_contact_name, crm_contact_email, crm_contact_phone) VALUES (?,?,?,?,?,?,?,1,?,?,?,?,?,?)');
const insCon = db.prepare('INSERT INTO contacts (id, client_id, first_name, last_name, email, phone, is_primary) VALUES (?,?,?,?,?,?,1)');

const clientIds = [];
demoClients.forEach((c, i) => {
  const cid = uid();
  clientIds.push(cid);
  insCli.run(cid, c.company, c.industry, c.size, c.city, c.state, daysAgo(90 - i * 10), c.status, c.budget, c.service, `${c.contact[0]} ${c.contact[1]}`, c.contact[2], c.contact[3]);
  insCon.run(uid(), cid, c.contact[0], c.contact[1], c.contact[2], c.contact[3]);
});

// ─── Projects for active clients ───
const insProj = db.prepare('INSERT INTO projects (id, client_id, service_id, assigned_to, name, status, budget, start_date, target_end_date) VALUES (?,?,?,?,?,?,?,?,?)');
const projIds = [];

[
  [0, 4, 'Bloom Creative — AI Content Strategy', 'in_progress', 3000, 60, 30],
  [1, 5, 'Cafe Uvee — POS Analytics Dashboard', 'in_progress', 1500, 45, 15],
  [5, 3, 'TechForge — Workflow Automation Phase 1', 'in_progress', 15000, 30, 60],
  [2, 3, 'Meridian Health — AI Workflow Proposal', 'scoping', 12000, 10, 80],
  [7, 2, 'Precision Mfg — Reporting Assessment', 'scoping', 20000, 5, 85],
].forEach(([ci, si, name, status, budget, startAgo, endFromNow]) => {
  const pid = uid();
  projIds.push(pid);
  insProj.run(pid, clientIds[ci], si, michele_id, name, status, budget, daysAgo(startAgo), daysAgo(-endFromNow));
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

console.log('✓ Demo seed complete!');
console.log('  Login: michele / demo2026  OR  demo / demo2026');
console.log('  Clients:', demoClients.length);
console.log('  Projects:', projIds.length);
console.log('  Invoices:', invoiceData.length);
console.log('  Daily reviews: 7');
console.log('  Time entries: ~' + (22 * 3) + ' (30 days, weekdays)');
db.close();
```

---

## Step 3 — Create the staging branch

```bash
# From the dashboard directory, after pushing main
git checkout -b staging
git add seed-demo.js
git commit -m "Add demo seed script and environment indicator

- seed-demo.js: populates 8 fictional clients, projects, invoices, expenses, time entries, daily reviews
- APP_ENV indicator: banner + /api/env endpoint for non-production environments
- Demo login: michele/demo2026 or demo/demo2026 (viewer)"

git push -u origin staging
```

---

## Step 4 — Set up Railway demo service

In the Railway dashboard (https://railway.app):

1. Open the existing project that contains `prism-dashboard-prod`
2. Click **"+ New"** → **"Service"** → **"GitHub Repo"** → select `prismai-dotcom/prism-ai-dashboard`
3. Name the service: `prism-dashboard-demo`
4. In the service settings → **"Source"** → set **Branch** to `staging`
5. Add these **environment variables**:

```
PORT=3000
NODE_ENV=production
APP_ENV=demo
API_KEY=<generate a new key for demo: openssl rand -hex 32>
CORS_ORIGIN=*
ANTHROPIC_API_KEY=<same as prod, or leave empty to disable AI chat in demo>
```

**Do NOT set** `STRIPE_SECRET_KEY` or `QBO_*` variables on demo — the Financials page will gracefully show "not configured" messages, and demo data covers invoices/payments locally.

6. Railway will auto-deploy. Note the generated URL (e.g., `prism-dashboard-demo-xyz.up.railway.app`)
7. Once deployed, SSH or use Railway CLI to run the seed script:

```bash
# Option A: Railway CLI
railway run node seed-demo.js --reset

# Option B: Add a startup seed check (see Step 5 below)
```

---

## Step 5 — Auto-seed on first boot (optional but recommended)

Add this to `server.js` so the demo instance seeds itself when the database is empty:

```javascript
// After the existing seed/init section, before app.listen()
if (process.env.APP_ENV === 'demo') {
  const clientCount = db.prepare('SELECT COUNT(*) as n FROM clients').get().n;
  if (clientCount === 0) {
    console.log('Demo environment detected with empty DB — running seed...');
    require('child_process').execSync('node seed-demo.js --reset', { stdio: 'inherit', cwd: __dirname });
    console.log('Demo seed complete.');
  }
}
```

---

## Step 6 — Configure custom domain (demo.prismaianalytics.com)

1. In Railway → `prism-dashboard-demo` service → **Settings** → **Networking** → **Custom Domain**
2. Add: `demo.prismaianalytics.com`
3. Railway will show a CNAME record to add
4. In your DNS provider (wherever prismaianalytics.com is managed):
   - Add a **CNAME record**: `demo` → `<value Railway provides>.up.railway.app`
   - TTL: 300 (5 min) or auto
5. Wait for DNS propagation (~5 min) and Railway SSL provisioning (~2 min)
6. Verify: `https://demo.prismaianalytics.com` loads the dashboard with the amber "DEMO" banner

---

## Step 7 — Update CORS for production

Now that demo has a custom domain, lock down CORS on the **production** service:

```
CORS_ORIGIN=https://web-production-7058a.up.railway.app
```

And on demo:
```
CORS_ORIGIN=https://demo.prismaianalytics.com
```

---

## Ongoing workflow

| Action | How |
|---|---|
| **Reset demo data** | `railway run node seed-demo.js --reset` (or redeploy — auto-seeds if DB is empty) |
| **Sync demo with prod code** | `git checkout staging && git merge main && git push` |
| **Add demo-only features** | Commit to `staging` branch only |
| **Deploy to prod** | Push to `main` — Railway auto-deploys prod service |
| **Deploy to demo** | Push to `staging` — Railway auto-deploys demo service |

---

## Quick copy-paste summary for Claude Code

```bash
# 1. Fix git lock and push existing work to main
rm -f .git/index.lock
git add .env.example CLAUDE.md package.json package-lock.json public/index.html services/cacheService.js services/stripeService.js services/quickbooksService.js test.http
git commit -m "Add Stripe & QuickBooks integration with Financials dashboard"
git push origin main

# 2. Add env indicator to server.js and index.html (see Step 1 above)

# 3. Create seed script (see Step 2 above — save as seed-demo.js)

# 4. Create and push staging branch
git checkout -b staging
git add seed-demo.js server.js public/index.html
git commit -m "Add demo environment: seed script, env indicator, demo banner"
git push -u origin staging

# 5. Configure Railway: new service from staging branch (see Step 4)
# 6. Configure DNS: CNAME demo → Railway (see Step 6)
```

---

## File summary

| File | Action | Purpose |
|---|---|---|
| `seed-demo.js` | **CREATE** | Seed script with 8 fictional clients, projects, invoices, expenses, time entries, daily reviews, demo users |
| `server.js` | **EDIT** | Add `APP_ENV` env var, `/api/env` endpoint, optional auto-seed on boot |
| `public/index.html` | **EDIT** | Add amber demo banner when `APP_ENV !== 'production'` |
| Railway | **CONFIGURE** | New service from `staging` branch with demo env vars |
| DNS | **CONFIGURE** | CNAME `demo.prismaianalytics.com` → Railway |
