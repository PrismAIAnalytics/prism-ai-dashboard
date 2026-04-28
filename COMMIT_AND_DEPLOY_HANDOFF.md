# Claude Code Handoff — Commit, Push & Deploy

**Date:** April 10, 2026
**Project:** Prism AI CRM Dashboard
**Repo:** `prismai-dotcom/prism-ai-dashboard` (GitHub, private)
**Deployed to:** Railway (auto-deploys from `main` branch)
**Working directory:** The dashboard folder (wherever this file lives)

---

## Context

There are 3 local commits not yet pushed to origin, plus a set of uncommitted changes from the Stripe/QuickBooks integration work (April 9) and a CSP bugfix (April 10). Everything needs to be committed and pushed so Railway can deploy.

## Step 0 — Remove stale git lock

A previous process left a lock file. Remove it first:

```bash
rm -f .git/index.lock
```

## Step 1 — Verify unpushed commits

There should be 3 commits ahead of origin:

```bash
git log --oneline origin/main..HEAD
```

Expected:
```
01b6fd5 Fix CSP: add connect-src directive for cdnjs.cloudflare.com
7dab952 Add CIS Compliance AI chat, bulk rule import, and remove seed data
5a96469 Add Security Baselines compliance page with CIS Benchmark management
```

## Step 2 — Stage the Stripe/QB integration + frontend changes

These files should be committed together as the Stripe & QuickBooks integration:

```bash
git add \
  .env.example \
  CLAUDE.md \
  package.json \
  package-lock.json \
  public/index.html \
  services/cacheService.js \
  services/stripeService.js \
  services/quickbooksService.js \
  test.http
```

### What each file contains:

| File | What changed |
|---|---|
| `.env.example` | Added `STRIPE_SECRET_KEY`, `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, `QBO_REALM_ID`, `QBO_REDIRECT_URI`, `QBO_ENVIRONMENT` |
| `CLAUDE.md` | Added environment/conventions sections, documented 16 new financial API endpoints |
| `package.json` | Added `stripe` and `node-quickbooks` dependencies |
| `package-lock.json` | Lock file for new deps |
| `public/index.html` | +952 lines: Financials dashboard page (Stripe balance, revenue charts, invoices, payments, QB P&L), payment links management UI, financial KPI cards on main dashboard |
| `services/stripeService.js` | New file: Stripe API wrapper (balance, customers, products, invoices, payments, subscriptions) |
| `services/quickbooksService.js` | New file: QuickBooks API wrapper (P&L reports, monthly revenue, invoice sync, OAuth flow) |
| `services/cacheService.js` | New file: In-memory TTL cache for API responses (avoids hammering Stripe/QB on every page load) |
| `test.http` | New file: HTTP test requests for all new financial endpoints |

### Files to NOT commit (leave as-is):

| File | Reason |
|---|---|
| `bulk-push-rules.js` | Minor tweak, not related to this feature — commit separately if desired |
| `server.js.bak` | Backup file, should not be in repo |
| `public/index.html.bak` | Backup file, should not be in repo |
| `fix-nav.js` | One-time migration script, not needed in repo |
| `patch-branding.js` | One-time script |
| `upgrade-v3.js` | One-time migration script |
| `seed-april-reviews.js` | One-time seed script |
| `import-cis-benchmarks.js` | One-time import script |
| `prism (1).db-wal` | Database WAL file, already gitignored pattern |
| `Prism_AI_Dashboard_API.postman_collection.json` | Optional — commit if you want Postman collection in repo |
| `docs/` | Optional — commit if ready |

## Step 3 — Commit

```bash
git commit -m "Add Stripe & QuickBooks integration with Financials dashboard

- Stripe service layer: balance, customers, products, invoices, payments
- QuickBooks service layer: P&L reports, monthly revenue, OAuth flow
- Cache service with TTL to avoid rate limiting
- Financials dashboard page with revenue charts, invoice/payment tables
- Payment links management UI
- Financial KPI cards on main dashboard
- 16 new API endpoints (/api/financials/*, /api/stripe/*, /api/qbo/*)
- Updated .env.example and CLAUDE.md with new config and endpoints"
```

## Step 4 — Push all commits

```bash
git push origin main
```

This pushes all 4 commits:
1. `Add Security Baselines compliance page with CIS Benchmark management`
2. `Add CIS Compliance AI chat, bulk rule import, and remove seed data`
3. `Fix CSP: add connect-src directive for cdnjs.cloudflare.com`
4. `Add Stripe & QuickBooks integration with Financials dashboard` (new)

## Step 5 — Verify Railway deployment

Railway auto-deploys from the `main` branch. After pushing:

1. Check Railway dashboard for build status (should take 1-2 minutes)
2. Once deployed, verify the CSP fix: open https://web-production-7058a.up.railway.app/ in browser, open DevTools console, navigate to Daily Review page — the Chart.js source map error should be gone
3. Verify Financials page loads (it won't have data until Stripe/QB env vars are set on Railway)

## Step 6 — Set environment variables on Railway (if not already set)

In Railway dashboard → your service → Variables, add:

```
STRIPE_SECRET_KEY=<your Stripe secret key>
QBO_CLIENT_ID=<your QuickBooks client ID>
QBO_CLIENT_SECRET=<your QuickBooks client secret>
QBO_REALM_ID=<your QuickBooks realm ID>
QBO_REDIRECT_URI=https://web-production-7058a.up.railway.app/api/qbo/callback
QBO_ENVIRONMENT=production
```

The Financials dashboard will show live data once these are configured.

## Optional cleanup

Add a `.gitignore` entry for backup files and one-time scripts, or delete them:

```bash
rm -f server.js.bak public/index.html.bak fix-nav.js patch-branding.js upgrade-v3.js "prism (1).db-wal"
```

---

## Quick copy-paste version

```bash
rm -f .git/index.lock
git add .env.example CLAUDE.md package.json package-lock.json public/index.html services/cacheService.js services/stripeService.js services/quickbooksService.js test.http
git commit -m "Add Stripe & QuickBooks integration with Financials dashboard"
git push origin main
```
