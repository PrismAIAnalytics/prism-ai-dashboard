// Seed script: Run once to populate daily_reviews table with historical data
// Usage: node seed-daily-reviews.js
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'prism.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create table if not exists
db.exec(`CREATE TABLE IF NOT EXISTS daily_reviews (
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
)`);

const reviews = [
  {
    review_date: '2026-03-21',
    sprint_day: 2,
    sprint_week: 1,
    summary: 'Sprint kickoff day. CRM tracker setup, documentation index created, sprint plan finalized.',
    development: 'Initial dashboard API scaffolding and database schema design. Express.js server with SQLite backend chosen.',
    sprint_progress: 'Sprint Day 2 of 90. 30/60/90 plan document finalized covering AI Bridge, Content Channel, CRM Development, and Training strategies.',
    clients_revenue: 'CRM tracker initialized with ~8 active clients, ~$24K in active projects.',
    training: 'Google AI Essentials certification started on Coursera. Target: April 15.',
    sources_reviewed: 'Workspace files, Sprint plan'
  },
  {
    review_date: '2026-03-22',
    sprint_day: 3,
    sprint_week: 1,
    summary: 'Major CRM dashboard development day. Full API with 20+ endpoints built, 8-page admin UI created.',
    development: 'CRM Express.js API built with 20+ endpoints. Admin dashboard UI created with 8 pages: Dashboard, Clients, CRM, Pipeline, Projects, Invoices, Expenses, Time. SQLite database with full relational schema. KPI charts and navigation working.',
    sprint_progress: 'Sprint Day 3. CRM Development track making rapid progress — ahead of schedule.',
    sources_reviewed: 'Workspace files, Session transcripts'
  },
  {
    review_date: '2026-03-23',
    sprint_day: 4,
    sprint_week: 1,
    summary: 'Dashboard hardening and deployment preparation. Security middleware added, auth system built.',
    development: 'Dashboard hardened with Helmet CSP, CORS, rate limiting, input validation via express-validator. Bearer token auth system with user login. Services page added (9th page).',
    sprint_progress: 'Sprint Day 4. CRM Dashboard approaching deployment-ready state.',
    sources_reviewed: 'Workspace files, Session transcripts'
  },
  {
    review_date: '2026-03-24',
    sprint_day: 5,
    sprint_week: 1,
    summary: 'No major updates. Steady progress on sprint plan.',
    sprint_progress: 'Sprint Day 5 — end of Week 1. On track across all strategy tracks.',
    sources_reviewed: 'Workspace files'
  },
  {
    review_date: '2026-03-25',
    sprint_day: 6,
    sprint_week: 1,
    summary: 'No major updates detected. Continuing per plan.',
    sprint_progress: 'Sprint Day 6. All tracks progressing steadily.',
    sources_reviewed: 'Workspace files'
  },
  {
    review_date: '2026-03-27',
    sprint_day: 8,
    sprint_week: 2,
    summary: 'CRM Dashboard deployed to Railway. CSP/Helmet bug fixes resolved. Training tracker integration started.',
    development: 'CRM Dashboard fully deployed and functional on Railway. Fixed CSP/Helmet bugs that were blocking navigation. All 9 pages operational. Training tracker with multi-user login (Michele & Izayah) kicked off.',
    sprint_progress: 'Sprint Day 8, Week 2. Major milestone: CRM Dashboard live on Railway.',
    reminders: 'Bloom Creative retainer renewal due April 1.',
    sources_reviewed: 'Workspace files, Session transcripts'
  },
  {
    review_date: '2026-03-28',
    sprint_day: 9,
    sprint_week: 2,
    summary: 'Dashboard CSP/Helmet bug fixes completed, full navigation restored on Railway. Training tracker integration in progress. Daily review task enhanced to check 3 sources.',
    development: 'CRM Dashboard CSP/Helmet bug fixes completed. Full navigation restored on Railway deployment. Training tracker integration with multi-user login continuing.',
    infrastructure: 'Daily review scheduled task enhanced to check three sources: workspace files, Cowork session transcripts, and Google Drive.',
    sprint_progress: 'Sprint Day 9, Week 2. Dashboard fully operational. Training tracker in active development.',
    reminders: 'Bloom Creative retainer renewal due April 1 (4 days). Google AI Essentials target: April 15 (18 days).',
    sources_reviewed: 'Workspace files, Session transcripts, Google Drive'
  },
  {
    review_date: '2026-03-29',
    sprint_day: 10,
    sprint_week: 2,
    summary: '3 updates today: CRM Dashboard branding, LinkedIn post drafted, Google Drive audit completed.',
    development: 'CRM Dashboard Branding: Added Prism AI branded login screen with full logo, tagline, and gradient sign-in button. Added prism triangle mark to nav sidebar. Patch script (patch-branding.js) created and ready for deployment.\n\nFiles modified: Development/dashboard/patch-branding.js (new), server.js (updated), upgrade-v3.js (updated)',
    marketing: 'LinkedIn Post Drafted: First LinkedIn post written for Michele about using Claude in her AI consulting workflow. ~170 words, on-brand voice, conversational tone with engagement question. Topic: AI tools that deliver real business value for small businesses.',
    infrastructure: 'Google Drive Audit Completed: Full audit found the Drive contains only empty folder structures with duplicates. No actual documents or files at risk. Cleanup plan provided with 6 specific items to delete (duplicate folder trees, empty dev artifact folders).\n\nDaily Review Task Enhanced: The scheduled daily review task now checks three sources: workspace files, Cowork session transcripts, and Google Drive.',
    clients_revenue: 'No changes detected. CRM tracker unchanged since last review.',
    training: 'No new updates. Google AI Essentials certification still in progress (target: April 15).',
    sprint_progress: 'Sprint Day 10, Week 2. Dashboard branding work aligns with CRM Development strategy track. LinkedIn post creation aligns with Content Channel strategy track. Both are on-plan activities.',
    reminders: 'Bloom Creative retainer renewal due April 1 (3 days away).\nGoogle AI Essentials target: April 15 (17 days away).',
    sources_reviewed: 'Workspace files (3 modified), Session transcripts (4 sessions), Google Drive (no docs changed)'
  }
];

const insert = db.prepare(`INSERT OR REPLACE INTO daily_reviews
  (review_date, sprint_day, sprint_week, clients_revenue, sprint_progress,
   development, training, services_pricing, marketing, infrastructure,
   other_milestones, reminders, summary, sources_reviewed)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

const tx = db.transaction(() => {
  for (const r of reviews) {
    insert.run(
      r.review_date, r.sprint_day || null, r.sprint_week || null,
      r.clients_revenue || null, r.sprint_progress || null,
      r.development || null, r.training || null, r.services_pricing || null,
      r.marketing || null, r.infrastructure || null,
      r.other_milestones || null, r.reminders || null,
      r.summary || null, r.sources_reviewed || null
    );
  }
});
tx();

console.log(`Seeded ${reviews.length} daily reviews into ${DB_PATH}`);
db.close();
