# Job Aid — Setting up the staging Railway service

> **Audience:** Michele (one-time setup).
> **When to run:** once, after T-008 PR merges.
> **Time required:** ~30 minutes.
> **Prerequisite:** T-008 PR merged on `main` so `STAGING_SETUP.md` exists in the repo.

---

## What you're building

A second Railway service that deploys from the `staging` branch instead of `main`. Same code, but its own database, its own URL, its own volume. Used as a sandbox for testing risky changes before they hit prod.

```
GitHub repo: PrismAIAnalytics/prism-ai-dashboard
├── main branch     → dabe service (production)
└── staging branch  → dabe-staging service (you're creating this)
```

---

## Step 1 — Create the `staging` branch on GitHub (~1 min)

In PowerShell:

```powershell
cd "C:\Users\miche\Prism AI\PRISM AI Analytics\Development\dashboard"
git checkout main
git pull --ff-only
git checkout -b staging
git push -u origin staging
```

That creates `staging` from current main and pushes it. From now on, both branches exist on GitHub.

---

## Step 2 — Create the Railway service (~10 min)

1. Open Railway dashboard. You should already see the existing `prism-dashboard` project containing the `dabe` service.

2. Inside that same project, click **"+ New"** → **"GitHub Repo"**.

3. Pick `PrismAIAnalytics/prism-ai-dashboard`.

4. Service name: `dabe-staging` (or whatever you prefer; keep it distinct from `dabe`).

5. **Don't deploy yet.** Click into the new service's Settings before the first deploy completes.

### Configure Source

Settings → **Source** section:

- **Source Repo:** `PrismAIAnalytics/prism-ai-dashboard` (auto-set)
- **Branch connected to production:** change from `main` to **`staging`**
- **Wait for CI:** leave OFF for staging (no backup workflow targets staging — see "Why no backups on staging" at the bottom)

### Attach a fresh persistent volume

Settings → **Volumes** section → **"+ New Volume"**:

- **Mount path:** `/app/data`
- **Size:** 1 GB (matches dabe; can grow later)

This is **NOT** the same volume as dabe. Each service gets its own. **Critical** — sharing volumes would let staging clobber prod data.

### Set environment variables

Settings → **Variables** section → click "+ New Variable" for each:

| Variable | Value | Why |
|---|---|---|
| `NODE_ENV` | `production` | Triggers the volume-required code path in `getDBPath()` (T-001 fail-hard guard); we still want strict path handling on staging |
| `APP_ENV` | `demo` | Tells `seedIfEmpty()` etc. to populate with demo data on first boot. (Anything other than `production` works; `demo` is the convention.) |
| `DB_PATH` | `/app/data/prism.db` | Authoritative path on the new volume |
| `API_KEY` | (generate fresh) | Run `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` once and paste. **Different from dabe's** so a leaked staging key can't hit prod. |
| `ADMIN_KEY` | (generate fresh, same way) | Same reasoning. **Different from dabe's `ADMIN_KEY`.** |
| `CORS_ORIGIN` | `*` for now (tighten later if you make staging public-facing) | — |
| `STRIPE_SECRET_KEY` | leave blank or use Stripe's **test-mode** key (`sk_test_...`) | NEVER use the live Stripe key on staging. Either omit Stripe entirely or use test mode keys |
| `QBO_CLIENT_ID` / `QBO_CLIENT_SECRET` / `QBO_REALM_ID` | omit for now | QuickBooks sandbox setup is its own task; skip until you actually need to test QBO flows on staging |
| `ANTHROPIC_API_KEY` | copy from dabe (same key is fine; Anthropic doesn't have prod/test split) | Chat endpoint will work |

### Save and let it deploy

Click "Deploy" or wait for the auto-deploy. Watch the logs. You should see:

```
Volume /app/data is ready
Opening database at: /app/data/prism.db
[startup] APP_ENV=demo — running seed functions
[seed] inserted N clients, N contacts, N projects, N tickets, ...
[stripe] Initialized
PRISM AI Analytics Dashboard (v2.0 — Hardened)
```

The seed functions run because `APP_ENV` is not `production` — `seedIfEmpty()` populates the DB with demo data.

### Capture the URL

Railway gives the new service a URL, something like:

```
https://dabe-staging-production-XXXX.up.railway.app
```

Copy that — you'll need it in Step 4.

---

## Step 3 — Verify staging is healthy (~2 min)

```powershell
$STAGING = "https://your-actual-staging-url.up.railway.app"  # paste from Railway
curl "$STAGING/health"
```

Expected:
```json
{"status":"healthy","uptime":...,"timestamp":"..."}
```

Then in a browser, open the staging URL. You should see the dashboard with seed data populated:

- 5 demo clients
- ~25 demo tickets
- Demo invoices, projects, etc.

If any of this is missing, check Railway logs for `seedIfEmpty` errors. The `APP_ENV` env var is the most common culprit — if it's set to `production`, seeds won't run.

---

## Step 4 — Update CLAUDE.md with the actual URL (~2 min)

The repo's `CLAUDE.md` currently has a placeholder:

```markdown
- Staging URL: <set after T-008 Railway service is created>
```

Replace with the real URL. Either edit it on GitHub directly via a quick PR, or tell the next AI session "the staging URL is `https://...`" and have it bundled into the next task's first commit (per WORKFLOW.md §4 close-out pattern).

---

## Step 5 — Add branch protection on `staging` (optional, ~2 min)

Strict protection on `staging` is **not** required — the whole point is to be a freer sandbox. But you might want light guardrails:

GitHub → repo Settings → Rules → "New branch ruleset":
- **Name:** `Protect staging`
- **Enforcement:** Active
- **Target branches:** Include by pattern → `staging`
- **Branch rules:**
  - ☑ Block force pushes (prevents accidental history rewrite)
  - ☑ Restrict deletions
  - ☐ Require pull request — leave **off** (you want to be able to push directly to staging for fast iteration)

That gives you "can't accidentally nuke staging" without slowing down testing.

---

## Using staging once it's set up

See [WORKFLOW.md](WORKFLOW.md) §4.5 "Using staging" for the on-demand workflow. Quick version:

1. For risky changes: branch off main → push to `staging` → test against the staging URL
2. If staging looks good: open PR from your feature branch into `main` → merge → prod deploys
3. For safe changes (UI tweaks, copy edits): skip staging, go straight to PR-into-main as before

Staging is **on-demand**, not mandatory.

---

## Why no auto-backup workflow on staging?

The `pre-deploy-backup.yml` GitHub Action only triggers on `branches: [main]`. Staging is intentionally excluded because:

- Staging holds only seed data, no real customer info
- If staging gets wiped, `seedIfEmpty()` re-populates on next boot (~10 seconds)
- No backups needed for regenerable data

If you ever want them anyway (maybe to test the backup endpoint itself), extend the workflow's `branches:` to `[main, staging]` and add a `STAGING_ADMIN_KEY` secret. Not required for normal operation.

---

## Common issues

| Symptom | Cause | Fix |
|---|---|---|
| Service crashes on boot with `FATAL: NODE_ENV=production but no persistent volume...` | Volume not attached or DB_PATH not set | Re-check Step 2 volume attach + DB_PATH env var |
| Service boots but DB has no data | `APP_ENV=production` — seeds didn't run | Change `APP_ENV` to `demo` and redeploy |
| Service boots but you can't log in | No user was seeded | Use the admin endpoint we built in T-001: `POST /api/admin/set-user-password` with `X-Admin-Key: <staging admin key>` |
| `/api/admin/backup-db` returns 503 on staging | `ADMIN_KEY` not set | Add it in Variables |

---

## When you're done

Tell the next AI session: *"Staging is up at `<URL>`. Update CLAUDE.md and close T-008."* The next task's first commit will fold both into its housekeeping.
