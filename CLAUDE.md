# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
```

## Deployment

`Procfile` is configured for Railway/Heroku: `web: node server.js`. The SQLite DB file (`prism.db`) is gitignored and must be initialized on the server at first run.

## Known Issues

- `better-sqlite3` requires native compilation (node-gyp + Visual Studio C++ Build Tools + Python). On Windows, ensure the "Desktop development with C++" workload is installed in VS Build Tools before running `npm install`.
- The `xlsx` package has unpatched vulnerabilities (prototype pollution, ReDoS) — only use it with trusted input files.
