// Seed script: Import daily reviews from March 31 – April 8 logs
// Usage: node seed-april-reviews.js
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'prism.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const reviews = [
  {
    review_date: '2026-03-31',
    sprint_day: 12,
    sprint_week: 2,
    summary: 'Significant infrastructure and organization work since last review (Mar 29). Notion Knowledge Library (13 articles), Meeting Notes & Content Calendar databases created. Claude Chat organized into 7 projects. Dashboard deploy confirmed with training registration, nav reorg, and tickets page.',
    clients_revenue: 'No new client activity or revenue changes detected since Mar 29. CRM tracker unchanged (~8 active clients, ~$24K active projects). Bloom Creative retainer renewal due tomorrow (April 1).',
    sprint_progress: 'Sprint Day 12, Week 2 of 30/60/90 plan (March 20 – June 18). Notion project management hub fully operational with 4 sections. Knowledge Library and Content Calendar created — key Sprint Week 2 deliverables.',
    development: 'Dashboard deploy confirmed on Railway — all changes from Mar 29 sessions live. Training registration management (add/remove courses, lesson progress bars, click-to-edit). Nav reorganization (Overview → Operations → Team → Business → Finance). Tickets page added to dashboard. KPI cards compacted to single row; Prism Shared Drive with actual folder structure. 10 git commits reviewed (Mar 29).',
    infrastructure: 'Claude Chat organized into 7 projects (Clients, Marketing, Admin, Research, Services, Development, Training) with project instructions and chat history organized. Notion Knowledge Library created: 13 articles across 6 categories (Services & Pricing, Client Processes, Brand & Voice, Sales & Outreach, Competitive Intel, Operations & Admin). Notion databases added: Meeting Notes & Discovery Calls, Content Calendar. Notion hub page reorganized into 4 sections (Work Management, Client Relations, Content & Marketing, Knowledge & Reference).',
    training: 'Google AI Essentials still in progress (target: April 15).',
    marketing: 'LinkedIn post drafted about Claude/AI tools — ready for review and publishing. Brand logo files updated in Marketing/Brand folder.',
    reminders: 'April 1: Bloom Creative retainer renewal due.\nApril 15: Google AI Essentials target completion.\nLinkedIn post ready for publishing.',
    sources_reviewed: 'Workspace files (Daily_Logs, Admin, Clients, Services, Marketing), Session transcripts (8 sessions), Google Drive, Dashboard git log (10 commits)'
  },
  {
    review_date: '2026-04-02',
    sprint_day: 14,
    sprint_week: 2,
    summary: 'Stock Trading Education Agent built on April 1 — a full-stack Streamlit application using the Claude Sonnet 4.6 API with paper trading, technical analysis, and chart generation. Claude Chat organized into 7 projects. Bloom Creative retainer renewal (due April 1) still needs confirmation.',
    clients_revenue: 'No new client activity detected. Bloom Creative retainer renewal was due April 1 — status unconfirmed, follow-up recommended. CRM continues tracking approximately 8 active clients with ~$24K in active projects.',
    sprint_progress: 'Sprint Day 14, Week 2 of the 30/60/90 plan (March 20 – June 18, 2026). No sprint tasks formally completed, but the stock trading agent represents significant development work aligned with technical credibility and training goals.',
    development: 'NEW: Stock Trading Education Agent (stock_trading_agent/) built April 1. Full-stack Streamlit app using Claude Sonnet 4.6 API featuring:\n— Paper trading system with $100,000 virtual cash\n— Real market data fetching and fundamental analysis\n— Technical analysis tools: RSI, MACD, SMA, EMA, Bollinger Bands\n— PNG chart generation with indicator overlays\n— Multi-tab dashboard: market overview, portfolio, watchlist, chat interface\n\nThis is a strong portfolio piece demonstrating Claude API integration with tool use, financial data engineering, interactive Streamlit dashboards, and educational AI agent design.',
    training: 'The stock trading agent doubles as a training exercise in Claude API tool use, financial data analysis, and Streamlit app development. Google AI Essentials certification target remains April 15 (13 days remaining).',
    infrastructure: 'Claude Chat organized into 7 projects (Clients, Marketing, Admin, Research, Services, Development, Training) with project instructions and chat history sorted. This establishes a clean workflow foundation across Chat and Cowork.',
    marketing: 'LinkedIn post on Claude/AI tools still drafted and ready to publish since March 31. The stock trading agent could make excellent LinkedIn content showcasing AI + finance capabilities.',
    reminders: 'ACTION: Bloom Creative retainer renewal (due April 1) — confirm status.\nGoogle AI Essentials certification target: April 15 (13 days remaining).\nLinkedIn post ready to publish — consider scheduling this week.\nStock trading agent could be showcased on LinkedIn or in client demos as a portfolio piece.',
    sources_reviewed: 'Workspace files: stock_trading_agent/ created Apr 1 (15+ files), Daily_Log existed from earlier run. Session transcripts: 6 sessions reviewed (Chat organization, earlier daily reviews, Notion work). Google Drive: 1 folder modified (pycache), no document changes. CRM tracker and sprint plan: unchanged since March 21.'
  },
  {
    review_date: '2026-04-03',
    sprint_day: 15,
    sprint_week: 3,
    summary: 'Major marketing milestone today: a full social media content strategy was built in Notion, including 5 content pillars, a content calendar with 10 Launch Week 1 posts planned for June 1–6, a platform playbook for LinkedIn/Twitter/Instagram/TikTok, and the first TikTok script was drafted for the AI Readiness Assessment service.',
    clients_revenue: 'No new client or revenue activity detected. Bloom Creative retainer renewal (due April 1) remains unconfirmed — needs follow-up.',
    sprint_progress: 'Sprint Day 15, entering Week 3. The social media content strategy work advances the Content Channel strategy track from the 30/60/90 sprint plan. No changes to CRM tracker or sprint plan files.',
    development: 'No new development work today. Stock Trading Education Agent (built April 1) remains the most recent technical project.',
    training: 'Google AI Essentials certification target: April 15 (12 days remaining). No new training activity detected today.',
    infrastructure: 'NotebookLM skill verified as not currently installed in Cowork setup. Obsidian knowledge management setup explored.',
    marketing: 'Social Media Content Strategy Hub built in Notion with 3-phase launch plan (Foundation → Content Bank → Launch). 5 Content Pillars database created: Data Demystified (credibility), Small Biz AI Wins (lead gen), Founder\'s Journey (community), Industry Insights & Trends (all goals), Actionable Tips & Frameworks (lead gen). Content Calendar: 10 sample entries for Launch Week 1 (June 1–6) across all 4 platforms, with status tracking (Idea → Drafting → Ready → Scheduled → Published). Platform Playbook: Tone, formats, best posting times, and hashtag strategy defined per channel. Content Repurposing Workflow: 1 research paper → 8–12 posts methodology established. First TikTok Script Drafted: 60-second AI Readiness Assessment explainer video — now in "Drafting" status in Notion calendar.',
    reminders: 'OVERDUE: Bloom Creative retainer renewal (due April 1).\nApril 15: Google AI Essentials certification target (12 days).\nReady to publish: LinkedIn post (Claude/AI tools topic).\nJune 1–6: Social media Launch Week 1.\nContent idea: Stock trading agent demo for LinkedIn.',
    sources_reviewed: 'Workspace files (Admin/Daily_Logs, CRM tracker), Session transcripts (5 sessions: social media content strategy, NotebookLM skill check, Obsidian setup, 2x Apr 2 daily reviews), Google Drive (no activity detected).'
  },
  {
    review_date: '2026-04-06',
    sprint_day: 18,
    sprint_week: 3,
    summary: 'Major content milestone: 6 blog posts created from research papers with website integration handoff prepared for Claude Code. CIS Benchmarks MCP pipeline confirmed fully operational (56K rules, 351 benchmarks, 66 dashboard products). Blog content advances the Content Channel sprint strategy and provides SEO, social media, and thought leadership assets.',
    clients_revenue: 'No new client or revenue activity since last review. ACTION: Bloom Creative retainer renewal is now 6 days overdue (due April 1). Follow up needed.',
    sprint_progress: 'Content Channel strategy advanced significantly with 6 blog posts completed from research papers and a website integration handoff document created for Claude Code deployment. CIS Benchmarks workstream pipeline integration complete. These advance both the marketing content and compliance/security service tracks.',
    development: 'Blog Posts Created (6 standalone HTML files):\n1. What Is an AI Readiness Assessment\n2. 5 Signs Your Small Business Is Ready for AI\n3. Why Most Small Businesses Are Behind on Data\n4. How a Fractional AI Advisor Can Transform Your Business\n5. From Spreadsheets to Dashboards\n6. Configuration Drift: The Silent Security Risk\n\nWebsite handoff document prepared with Netlify deployment plan: add /blog/ listing page, integrate site nav, clean URL structure, deploy.\n\nCIS Dashboard: MCP pipeline fully operational (56,106 rules, 351 benchmarks, 66 products). Filtering improved (0-rule products hidden, sorted by count). Benchmark Extractor skill packaged. New CIS PDFs batch added (Kubernetes, Docker, IBM, GKE).',
    training: 'No new certification progress. Google AI Essentials cert target remains April 15 (9 days away).',
    marketing: '6 blog posts completed and ready for website integration. Topics span AI readiness, data analytics, fractional AI advisory, dashboard modernization, and security compliance — covering multiple content pillars from the social media strategy. Website handoff document prepared. LinkedIn content pipeline active with first post drafted.',
    infrastructure: 'Google Drive login folder created. ui-ux-pro-max design skill installed in workspace.',
    other_milestones: 'Blog content library now at 6 posts — a significant content asset for SEO, social media repurposing, and thought leadership positioning. CIS Benchmarks knowledge base at 56,106 rules — major data asset for compliance consulting services.',
    reminders: 'OVERDUE: Bloom Creative retainer renewal (due April 1, 6 days overdue).\nGoogle AI Essentials certification target: April 15 (9 days).\nSocial media Launch Week 1: June 1–6.\nSprint end: June 18, 2026.\nNEXT: Integrate blog posts into website via Claude Code.',
    sources_reviewed: 'Workspace files (Daily_Logs, SKILL.md modified), Session transcripts (5 sessions: blog creation + handoff, 2x daily review, CIS benchmarks filtering, CIS gameplans), Google Drive (login folder created). Company profile skill and CRM Dashboard updated.'
  },
  {
    review_date: '2026-04-08',
    sprint_day: 20,
    sprint_week: 3,
    summary: 'Active client work with Cafe Uvee — Spanish employee hours Google Form created (April 7) and WhatsApp chat data imported (April 8). Dashboard development files updated. No new revenue changes since April 6 review.',
    clients_revenue: 'Cafe Uvee: Active client delivery work. Created a Spanish-language Google Form ("Registro de Horas de Trabajo") for employee hours tracking with linked Google Sheets response collector. WhatsApp chat history ("Horario de Trabajo Uvee Uveros") imported to Clients/Cafe Uvee folder for employee hours data extraction. This is the first evidence of hands-on operational service delivery for a client.\n\nNo changes to CRM tracker revenue figures. ~8 active clients, ~$24K in active projects.',
    sprint_progress: 'Blog section now fully integrated into prism_website_project/blog/ with 6 post pages and a listing page (completed April 6 handoff via Claude Code). Website project updated with clean URL structure. Cafe Uvee operational work aligns with service delivery sprint goals.',
    development: 'Dashboard server.js and public/index.html updated (April 7). BRD document and bulk-push-rules.js also recently modified — ongoing CRM dashboard improvements.',
    training: 'No new training activity detected. Google AI Essentials certification target: April 15 (7 days remaining).',
    marketing: '6 blog posts now integrated into website project. No new social media or LinkedIn content since last review.',
    infrastructure: 'Spanish Google Form created for Cafe Uvee employee hours tracking — operational tool setup. Google Drive folder "run-con" created April 7.',
    reminders: 'OVERDUE: Bloom Creative retainer renewal (due April 1, now 7 days overdue).\nUPCOMING: Google AI Essentials certification target — April 15 (7 days).\nVERIFY: Blog posts Netlify deployment status — posts are in project folder, confirm live on prismaianalytics.com.',
    sources_reviewed: 'Workspace files (8 modified since April 6), Session transcripts (6 sessions), Google Drive (1 new folder), Daily logs (last entry April 6).'
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

console.log(`Seeded ${reviews.length} daily reviews (March 31 – April 8) into ${DB_PATH}`);
db.close();
