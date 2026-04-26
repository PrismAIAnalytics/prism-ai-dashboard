# INCIDENT_FINDINGS.md

> **Incidents:** Prism AI Dashboard production data wiped (×2)
> **Investigated:** 2026-04-24 by the council
> **App:** Prism AI Dashboard (this repository) deployed at https://dashboard-api-production-dabe.up.railway.app

---

## TL;DR

The wipes are caused by **Railway's ephemeral filesystem + a fall-through in the DB-path selection logic**. Every Railway redeploy spins up a fresh container with no persistent storage. The dashboard's `getDBPath()` *attempts* to use a `/app/data` volume but **silently falls back to writing `prism.db` into the ephemeral application directory** when no volume is mounted. The result: every deploy = empty DB = data gone.

This is a one-day fix. Until it lands, **every deploy is a Russian-roulette wipe.**

---

## Root cause (confirmed)

### Evidence #1 — `Development/dashboard/server.js`, lines 517–525

```javascript
// Legacy behavior for envs that haven't set DB_PATH yet.
if (process.env.NODE_ENV === 'production') {
  const volumeDir = '/app/data';
  if (waitForVolume(volumeDir)) {
    return path.join(volumeDir, 'prism.db');
  }
  console.warn('Volume not available — falling back to local directory');  // ← THE TRAP
}
return path.join(__dirname, 'prism.db');  // ← writes to ephemeral /app/prism.db
```

The function tries the volume, and if the volume isn't mounted it **prints a warning and continues** writing the DB to the ephemeral application directory. A warning in the logs is not a guardrail — it's the noise right before the explosion.

### Evidence #2 — `Development/dashboard/railway.toml`

```toml
[build]
builder = "dockerfile"
# No [volumes] section — container has no persistent storage attached
```

No volume is declared.

### Evidence #3 — `Dockerfile`

```dockerfile
RUN mkdir -p /app/data        # creates the directory but it's ephemeral
# NOTE: Running as root so Railway-mounted volumes are writable.
```

Someone *intended* a volume — the comment proves it — but the Railway project never had one attached.

### Evidence #4 — Boot sequence on a fresh container

1. Container starts on a clean ephemeral filesystem
2. `getDBPath()` is called → `DB_PATH` env var is unset → falls through to the legacy block
3. `waitForVolume('/app/data')` returns `false` (no volume mounted)
4. Falls back to `__dirname/prism.db`, an ephemeral path
5. `initDB()` runs (`server.js:1277`) — `CREATE TABLE IF NOT EXISTS` builds an empty schema
6. App boots happy. Customer-facing dashboard is empty. **Data is gone.**

`seedIfEmpty()` at `server.js:1808` is gated on `APP_ENV !== 'production'`, so prod doesn't even repopulate with fake data — it just shows an empty UI.

---

## Contributing factors

- **Silent fallback in DB-path logic.** Should be `process.exit(1)` if the volume is missing in production.
- **No `DB_PATH` env var set in Railway.** The explicit override exists in code but isn't used.
- **No pre-deploy backup mechanism.** No `npm run backup`, no admin dump endpoint, no scheduled snapshot. There is currently no way to pull `prism.db` off the running container without `railway shell` access (and even then, the file vanishes on next deploy).
- **No staging environment.** Every code change goes straight to prod via auto-deploy.
- **Two AI sessions + auto-deploy.** Half-finished commits from one session can ship while the other is mid-edit. (The workflow protocol — see [WORKFLOW.md](WORKFLOW.md) — addresses this side of the problem.)

---

## Immediate fixes (ranked by leverage)

### P0 — DO THIS BEFORE THE NEXT DEPLOY

1. **Attach a Railway persistent volume.** In Railway dashboard → service → Volumes → add volume, mount path `/app/data`, ~1 GB to start. Set env var `DB_PATH=/app/data/prism.db`. **This single change fixes the root cause.**
2. **Make `getDBPath()` fail hard.** Replace the silent fallback with:

   ```javascript
   if (process.env.NODE_ENV === 'production' && !waitForVolume('/app/data')) {
     console.error('FATAL: production requires persistent volume at /app/data. ' +
       'Attach a volume in Railway dashboard or set DB_PATH to a mounted path.');
     process.exit(1);
   }
   ```

   A crashed boot is recoverable. A silent wipe is not.
3. **Add an admin DB-dump endpoint** (auth-gated by `API_KEY`) so the deploy runbook actually has a backup mechanism. Without this, you cannot snapshot prod before a deploy. See [DEPLOY_RUNBOOK.md](DEPLOY_RUNBOOK.md) "Backup procedure."

### P1 — within the week

4. Run the first real backup once #1 + #3 land. Store in OneDrive.
5. Add branch protection on `main` in GitHub (require PR, no direct pushes, no force-pushes).
6. Decide: keep auto-deploy with the new guardrails, or switch to manual `railway up`. (Recommend manual until the team trusts the protocol — auto-deploy is a footgun for solo + AI work.)

### P2 — within the month

7. GitHub Action that runs the backup endpoint on every PR-merge before Railway redeploys.
8. Staging environment — separate Railway service, separate DB, deploys from a `staging` branch.
9. Migration script for moving SQLite → Postgres / Turso when scale or reliability demands it.

---

## What we still don't know

- **How many wipes have actually occurred?** With no backups, every deploy on the broken config probably triggered the same loss — the count of two is just what was *noticed*.
- **Is there any recoverable data?** Possibly via Stripe (re-import customers/invoices), QuickBooks (re-sync), and the Obsidian Daily Logs that `sync_daily_reviews.py` (lives at workspace root, two levels up from this repo) was pushing into prod. Worth scoping a recovery pass after #1 lands.
- **Was `npm run import:crm` ever run against prod?** That script is mentioned in [CLAUDE.md](CLAUDE.md) — needs a quick read to confirm it doesn't truncate before importing.

---

## Recommendation

Treat fixes #1 and #2 as a **single PR** — `fix/railway-persistent-db` — landing before any other change. That PR should:

1. Add the Railway volume (in dashboard, not code)
2. Set `DB_PATH=/app/data/prism.db` in Railway env
3. Modify `getDBPath()` to fail-hard
4. Add the admin dump endpoint
5. Include the first backup file in the PR description as proof the new flow works

Until that PR is merged and verified, **no other deploys.** The TASKS.md In Progress lock should be set to that task and nothing else.
