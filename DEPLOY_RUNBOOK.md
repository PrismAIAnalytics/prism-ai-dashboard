# DEPLOY_RUNBOOK.md

**Owner:** Michele Fisher | **App:** Prism AI Dashboard | **Host:** Railway | **DB:** SQLite (`prism.db`)
**Production URL:** https://dashboard-api-production-dabe.up.railway.app

> Production has been wiped twice. This runbook exists to prevent wipe #3. Follow it literally. No steps are optional.

---

## When to use this runbook

Every merge to `main` triggers a Railway auto-deploy from GitHub. **Run this checklist BEFORE merging the PR.** No exceptions, even for "tiny" changes — the last two wipes were both "tiny" changes.

---

## Pre-deploy checklist (DO NOT SKIP)

- [ ] You are on a feature branch, not `main`: `git branch --show-current` (must NOT print `main`)
- [ ] Working tree clean: `git status` shows "nothing to commit, working tree clean"
- [ ] Latest main merged in: `git fetch origin && git merge origin/main` (resolve conflicts now, not post-deploy)
- [ ] **DB backup taken** (see Backup section). File is timestamped, sitting locally AND uploaded to OneDrive.
- [ ] **Railway env vars snapshotted**: `railway variables --json > backups/railway-vars-$(date +%Y%m%d-%H%M).json` then encrypt with `gpg -c` and stash in OneDrive. Tokens (Stripe, QuickBooks OAuth refresh tokens) live here — losing them is a multi-hour re-auth.
- [ ] **Schema changed?** Copy prod `prism.db` locally, run the new `server.js` against the copy, confirm tables/rows are intact: `sqlite3 prism-prod-copy.db ".schema"` and `sqlite3 prism-prod-copy.db "SELECT name, (SELECT COUNT(*) FROM pragma_table_info(name)) FROM sqlite_master WHERE type='table';"`
- [ ] **New env var required?** Set it in Railway dashboard BEFORE merging the code that reads it. Code that crashes on boot for a missing env var = downtime.
- [ ] **Smoke-test plan written** in the PR description: list the 3-5 endpoints + UI flows you will hit within 60s of deploy. Example: `GET /health`, `GET /api/clients`, `GET /api/financials/summary`, load `/dashboard.html`, click "Daily Reviews" tab.
- [ ] **Touched Stripe or QuickBooks?** Re-read the OAuth flow in `server.js`. Confirm refresh-token storage path. Have the re-auth URL bookmarked: QuickBooks Connect button + Stripe dashboard webhook test.

---

## Backup procedure (do this BEFORE every deploy)

> **P0 GAP** — if the dashboard does not currently expose an admin DB-download endpoint AND Railway CLI cannot reach the container's filesystem, you have NO way to pull the prod DB. **Fix this before the next deploy.** See "Long-term fixes" #1.

### Option A — Railway CLI (preferred, if shell access is enabled on your plan)

```powershell
# From Development/dashboard/
mkdir -Force backups
$ts = Get-Date -Format "yyyyMMdd-HHmmss"

# TODO: confirm exact Railway CLI command — should open a shell on the running container
railway shell
# Inside container:
sqlite3 prism.db ".backup '/tmp/prism-$ts.db'"
exit

# TODO: confirm exact Railway CLI command — should copy a file out of the container
railway run cat /tmp/prism-$ts.db > backups/prism-$ts.db
```

### Option B — Admin download endpoint (preferred if Option A is blocked)

If `server.js` exposes something like `GET /api/admin/db-dump` (auth-gated by `API_KEY`):

```powershell
$ts = Get-Date -Format "yyyyMMdd-HHmmss"
mkdir -Force backups
curl.exe -H "Authorization: Bearer $env:PRISM_API_KEY" `
  https://dashboard-api-production-dabe.up.railway.app/api/admin/db-dump `
  -o "backups/prism-$ts.db"
```

If no such endpoint exists, **add one this week** (gated behind `API_KEY`, returns the file via `better-sqlite3`'s `db.backup()` API streamed to the response). This is the single highest-leverage fix.

### Compress, verify, upload

```powershell
# Verify the backup actually opens and has rows
sqlite3 backups/prism-$ts.db "SELECT name FROM sqlite_master WHERE type='table';"
sqlite3 backups/prism-$ts.db "SELECT COUNT(*) FROM clients;"  # adjust table name

# Compress
Compress-Archive -Path "backups/prism-$ts.db" -DestinationPath "backups/prism-$ts.zip"

# Upload to OneDrive (sync folder); confirm it shows the green check
Copy-Item "backups/prism-$ts.zip" "$env:OneDrive\PrismBackups\"
```

**Retention:** keep last 30 daily backups locally, keep all in OneDrive.

---

## Deploy steps

1. Open the PR on GitHub. Paste the smoke-test list into the PR description.
2. Run the self-review checklist from `WORKFLOW.md` (if it exists; if not, eyeball the diff line-by-line).
3. **Confirm the backup file from this morning is sitting in `backups/`.** If not, STOP and back up first.
4. Merge to `main` via the GitHub "Merge pull request" button (squash merge). This triggers Railway.
5. Immediately open Railway dashboard -> your service -> Deployments tab. Watch logs stream in real time.
   ```powershell
   # Or via CLI:
   railway logs --follow
   ```
6. Within 60 seconds of deploy showing "Success", hit:
   ```powershell
   curl.exe https://dashboard-api-production-dabe.up.railway.app/health
   ```
   Then run through the smoke-test list from the PR.

---

## Post-deploy verification (within 5 minutes)

- [ ] `curl /health` returns `200` and expected JSON body
- [ ] Each endpoint on the smoke-test list returns 200 with expected shape
- [ ] Open the dashboard UI in a browser. **Data is visible.** Empty tables = wipe in progress, ROLL BACK NOW.
- [ ] Spot-check one specific record you know existed pre-deploy (e.g., a named client, a known invoice). If it's gone, ROLL BACK.
- [ ] Stripe dashboard -> Developers -> Webhooks -> recent deliveries: most recent attempt is `200`.
- [ ] QuickBooks: hit the financials endpoint that requires the OAuth token. If it 401s, the refresh token survived but the access token may need a refresh — check logs.
- [ ] Leave the Railway logs tab open for 5 more minutes. Watch for `EACCES`, `SQLITE_`, `ECONNREFUSED`, unhandled promise rejections.

---

## Rollback procedure (if anything is wrong)

> **Decision rule:** If `/health` is down OR data is missing OR a critical flow errors, **ROLL BACK FIRST, debug after.** Do not try to hot-fix forward on main.

### 1. Roll back the code (Railway)

```powershell
# Railway UI: Deployments tab -> last green deploy -> "Redeploy" button
# Or via CLI:
# TODO: confirm exact Railway CLI command — should redeploy a prior deployment by ID
railway redeploy <previous-deployment-id>
```

### 2. Restore the DB (if data was wiped)

```powershell
# Decompress the most recent pre-deploy backup
Expand-Archive backups/prism-<ts>.zip -DestinationPath backups/restore/

# Upload it back. Two options:
# A) If admin endpoint accepts uploads:
curl.exe -X POST -H "Authorization: Bearer $env:PRISM_API_KEY" `
  -F "file=@backups/restore/prism-<ts>.db" `
  https://dashboard-api-production-dabe.up.railway.app/api/admin/db-restore

# B) Via Railway shell:
# TODO: confirm Railway file-copy command
railway shell
# Then inside: replace prism.db with the uploaded backup, restart the process
```

### 3. Revert the offending commit in Git

```powershell
git checkout main
git pull origin main
git revert <bad-commit-sha>     # creates a new commit, preserves history
git push origin main             # triggers a clean Railway deploy of the revert
```

**Never** `git reset --hard` on `main`. Never force-push `main`. Reverts only.

---

## Anti-patterns (things that have wiped prod)

- Deploying without a fresh backup in `backups/` from the same day.
- Schema migrations that `DROP TABLE` / `CREATE TABLE` instead of `ALTER TABLE` or additive-only changes.
- Seed scripts that run unconditionally on boot (e.g., `db.exec(seedSql)` with no "is this empty?" guard). Seed logic must check `SELECT COUNT(*) FROM <table>` and bail if non-zero.
- Force-pushing to `main`, or rebasing `main`.
- Letting Railway auto-deploy while you're mid-edit on another branch — if you accidentally push to `main`, it ships. Keep `main` protected; use feature branches always.
- Storing `prism.db` on Railway's ephemeral filesystem (current state). Every container restart is a roll of the dice. **This is the most likely cause of both prior wipes.**
- Running `npm run import:crm` against prod without a backup — it's a write-heavy script.

---

## Long-term fixes to retire this runbook

1. **[P0] Mount a Railway persistent volume at `/data`** and move `prism.db` there. Set `DB_PATH=/data/prism.db` in Railway env. This single fix retires the wipe risk. *Future work — do this week.*
2. **[P1] Add `GET /api/admin/db-dump` and `POST /api/admin/db-restore` endpoints** in `server.js`, gated by `API_KEY`. Enables zero-friction backups and restores. *Future work.*
3. **[P1] GitHub Action: pre-deploy backup.** On `pull_request` targeting `main`, hit the dump endpoint and commit the resulting file to a `backups/` branch (or push to S3). Blocks merge if backup fails. *Future work.*
4. **[P2] Staging environment on Railway** — second service, same code, separate DB. Deploy to staging first, smoke-test, then promote. *Future work.*
5. **[P2] Migrate off SQLite** to Railway Postgres once the app outgrows single-file simplicity. Postgres on Railway is managed and backed up automatically. *Future work — only when concurrency forces it.*
6. **[P3] Branch protection on `main`** in GitHub: require PR, require status checks, disallow force-push. *Do today, takes 2 minutes.*

---

*Last updated: 2026-04-24. Update this file every time the deploy process changes or a new failure mode is discovered.*
