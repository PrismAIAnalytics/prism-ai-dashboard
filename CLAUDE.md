# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Read these before any work

This repo runs under a strict AI-coordination protocol because production has been wiped twice. **Before touching any file, read in this order:**

1. **[WORKFLOW.md](WORKFLOW.md)** — the protocol. WIP=1, branch-per-task, never push to main, squash-merge only.
2. **[TASKS.md](TASKS.md)** — the lock. Confirm In Progress is empty (or owned by you) before starting work.
3. **[INCIDENT_FINDINGS.md](INCIDENT_FINDINGS.md)** — root cause of the two prod wipes. Why the protocol exists.
4. **[DEPLOY_RUNBOOK.md](DEPLOY_RUNBOOK.md)** — pre-deploy checklist and rollback procedures.
5. **[PR_JOB_AID.md](PR_JOB_AID.md)** — operator walkthrough for opening PRs and squash-merging.
6. **[STAGING_SETUP.md](STAGING_SETUP.md)** — one-time setup guide for the staging Railway service (T-008).

If In Progress in TASKS.md is non-empty and the owner isn't you, **stop and ask Michele.**

## Environments

- **Production:** https://dashboard-api-production-dabe.up.railway.app — deploys from `main` on every merge
- **Staging:** `<set after T-008 Railway service is created — see STAGING_SETUP.md>` — deploys from `staging`, holds seed data only, used on-demand for risky changes per [WORKFLOW.md](WORKFLOW.md) §4.5
- **Legacy:** https://web-production-7058a.up.railway.app — kept as a recovery source; not under active development

## Environment
- OS: Windows (PowerShell)
- Use PowerShell-compatible syntax for environment variables (e.g., `$env:VAR` not `VAR=value`)
- When starting local servers, default to port 3000 unless otherwise specified

## Project Stack
- Primary languages: HTML, JavaScript, Python
- Frontend: HTML dashboards with CSS styling
- Backend: Node.js, Python (Flask/Streamlit)
- Always verify CSS class names match between JS/HTML and stylesheets after making UI changes

## Conventions
- When asked to replace or swap a UI element, confirm exactly which element by quoting it back before making the edit
- Prefer minimal, targeted edits over broad rewrites
- After any frontend change, verify the result visually using the preview tool

## Commands

```bash
npm run dev          # Start the server (port 3000)
npm run start        # Same as dev — used in production
npm run import:crm   # Import CRM data from Excel file into SQLite
```

There is no build step, test runner, or linter configured.

## Architecture

Single-file Express.js backend (`server.js`) serving a vanilla JS single-page app (`public/index.html`). No frontend framework, no bundler, no TypeScript.

**Stack**: Express.js + better-sqlite3 + Vanilla HTML/CSS/JS

**Database**: SQLite at `./prism.db`. No ORM — raw SQL via `better-sqlite3` prepared statements. WAL mode and foreign keys are enabled. Schema is auto-created and seeded on first run via `initDB()` and `seedIfEmpty()` in `server.js`. Safe column migrations run via `migrateCRMColumns()`.

**Auth**: Optional Bearer token via `API_KEY` env var. If `API_KEY` is not set, all `/api/*` routes are open. `/health` is always public.

**All backend logic lives in `server.js`** — routes, middleware, DB schema, seed data, and migrations are all in this one file (~864 lines).

## API Structure

- `GET /health` — public health check
- `GET /api/dashboard` — KPI summary
- `GET|POST /api/crm` — CRM customer list and creation
- `PATCH /api/crm/customers/:id` — update CRM fields
- `PATCH /api/crm/customers/:id/status` — update CRM stage
- `DELETE /api/crm/customers/:id` — soft delete (sets `active = 0`)
- `GET|POST /api/crm/activity/:id` — activity log per customer
- Standard CRUD for clients, projects, pipeline, invoices, expenses, time entries
- Financials integration (Stripe + QuickBooks):
  - `GET /api/financials/kpis` — aggregated KPIs from Stripe + QB + local
  - `GET /api/financials/invoices?source=all|quickbooks|local` — merged invoices
  - `GET /api/financials/payments?source=all|stripe|local` — merged payments
  - `GET /api/financials/revenue?start=&end=` — QB P&L summary
  - `GET /api/financials/revenue/monthly?year=` — monthly breakdown for charts
  - `GET /api/stripe/balance` — Stripe available + pending
  - `GET /api/stripe/customers` — Stripe customer list
  - `GET /api/stripe/products` — products with prices
  - `GET /api/stripe/subscriptions` — active subscriptions
  - `POST /api/financials/refresh` — clear data cache
  - `GET /api/qbo/connect` — QuickBooks OAuth redirect
  - `GET /api/qbo/callback` — OAuth callback handler
  - `GET /api/qbo/status` — QB connection status

Input validation on all write endpoints uses `express-validator`.

## CRM Pipeline

12-stage workflow: New Lead → Discovery → Assessment → Proposal → Active Client → Project In Progress → Delivered → Post-Project Follow-Up → Retainer/Upsell → Closed Won/No Sale/On Hold. Each stage has SLAs and trigger actions defined as constants in `server.js`.

## Environment

Copy `.env.example` to `.env`:

```
PORT=3000
API_KEY=           # leave empty for open/dev mode
CORS_ORIGIN=*
NODE_ENV=production
STRIPE_SECRET_KEY= # from Stripe dashboard
QBO_CLIENT_ID=     # from Intuit Developer portal
QBO_CLIENT_SECRET=
QBO_REALM_ID=
QBO_REDIRECT_URI=http://localhost:3000/api/qbo/callback
QBO_ENVIRONMENT=production
```

## Deployment

`Procfile` is configured for Railway/Heroku: `web: node server.js`. The SQLite DB file (`prism.db`) is gitignored and must be initialized on the server at first run.

## Known Issues

- `better-sqlite3` requires native compilation (node-gyp + Visual Studio C++ Build Tools + Python). On Windows, ensure the "Desktop development with C++" workload is installed in VS Build Tools before running `npm install`.
- The `xlsx` package has unpatched vulnerabilities (prototype pollution, ReDoS) — only use it with trusted input files.
