# INCIDENT_FINDINGS.md

> **Incidents:** Prism AI Dashboard production data wiped (×3 as of 2026-04-27)
> **Original investigation:** 2026-04-24 by the council
> **Wipe #3 investigation:** 2026-04-27 by Claude Code (T-010)
> **App:** Prism AI Dashboard (this repository) deployed at https://dashboard-api-production-dabe.up.railway.app

---

## Wipe #3 — 2026-04-26 ~18:04 UTC

**TL;DR:** T-001 added a fail-hard guard but the heuristic it depends on cannot detect a missing volume on Railway. The guard passed silently against ephemeral storage, exactly like the original silent fallback it was meant to replace. Wipe #3 erased the 256 rows that T-009 had restored ~7 hours earlier.

### How we found it (T-010)

Read-only diagnosis on `dashboard-api` service in `production` environment of `prism-dashboard` Railway project, on 2026-04-27 morning:

| Check | Value | Source |
|---|---|---|
| `NODE_ENV` | `production` | `railway variables` |
| `DB_PATH` | unset | `railway variables` |
| Volume attached to `dashboard-api` | **none** | `railway volume list` in env=production returns "No volumes found" |
| Volume attached to `dabe-staging` | `dabe-staging-volume` at `/app/data` (5 GB) | same command in env=staging |
| Container uptime when checked | ~20 h | `/health` endpoint |
| Last build image timestamp | `2026-04-26T18:03:56Z` | `railway logs --build` |
| Boot log on current container | `Volume /app/data is ready (attempt 1)` then `Opening database at: /app/data/prism.db` | `railway logs` |
| Backup file `prism-dabe-post-restore-20260426-104937.db` | 516 KB, 256 rows, intact | `better-sqlite3` row-count read |

### Actual root cause

The `isVolumeReady()` function ([server.js:659-670](server.js)) determines whether `/app/data` is a real mounted volume or ephemeral storage by **doing a write-test**:

```javascript
function isVolumeReady(dir) {
  // Check if the directory is actually writable (volume mounted), not just existing
  // (the Dockerfile creates /app/data but it's read-only until the volume mounts)
  try {
    const testFile = path.join(dir, '.write-test');
    fs.writeFileSync(testFile, 'ok');
    fs.unlinkSync(testFile);
    return true;
  } catch {
    return false;
  }
}
```

The comment claims the Dockerfile-created `/app/data` is "read-only until the volume mounts." That claim is **wrong**. The Dockerfile contains `RUN mkdir -p /app/data` running as root (build log line "stage-1 16/16"), which creates a normal writable directory at image build time. With no Railway volume attached:

1. Container starts on ephemeral filesystem
2. `/app/data` exists from the Dockerfile and is writable (root, default permissions)
3. `isVolumeReady('/app/data')` writes `.write-test`, unlinks it, returns `true`
4. `getDBPath()` ([server.js:704-708](server.js)) returns `/app/data/prism.db` — an ephemeral path
5. App boots happy. **Every redeploy = fresh container = empty `/app/data/prism.db` = wipe.**

The fail-hard guard from T-001 still works correctly *if it gets a chance to fire* — but `isVolumeReady` returns true before `getDBPath` ever has the opportunity to crash. The guard is gated on the wrong signal.

### Why this is the same shape of bug as wipes #1 and #2

| Wipe | Mechanism | Why "fix" was incomplete |
|---|---|---|
| #1, #2 | `console.warn('Volume not available — falling back to local directory')` then continued anyway | A warning is not a guardrail. |
| #3 | `isVolumeReady()` write-test passes against ephemeral writable dir | A write-test is not a volume detector. |

In both cases the code "checked" something that looks like volume health but is actually a free pass on ephemeral storage. T-001 closed the silent-fallback in the *control flow* but left the *signal* unchanged.

### Why the original "Immediate fixes" punch list missed this

INCIDENT_FINDINGS.md (this file, before this update) listed two P0 items:

1. Attach a Railway persistent volume.
2. Make `getDBPath()` fail hard.

T-001 implemented #2 but **#1 was infrastructure work that needed to happen in the Railway dashboard**, not in code. The PR description for T-001 said "Add the Railway volume (in dashboard, not code)" but the dashboard step was never done. There was no automated check for it. TASKS.md did not list it as a separate task because the original recommendation bundled #1 and #2 as a single PR — but only #2 lived inside the repo.

The punch list at the bottom of TASKS.md (before this update) implied the post-wipe work was complete. It was not. **8/8 was incorrect — it should have been 7/8 with the volume mount still open.**

### Fix plan (T-011a + follow-ups)

**T-011a (in flight):**

1. Attach Railway volume to `dashboard-api` service at `/app/data`, ~1 GB. (Michele, dashboard UI.)
2. Set `DB_PATH=/app/data/prism.db` on the same service. (Michele, dashboard UI — recommended for clarity even though the legacy `/app/data` fallback would work too.)
3. Wait for Railway redeploy with current main code. Volume now mounts, ephemeral writes turn into volume writes. Verify `/health` is 200 and `Volume /app/data is ready` still appears in boot log.
4. Harden `isVolumeReady()` to require `RAILWAY_VOLUME_MOUNT_PATH` to be set when running on Railway. The write-test stays as a secondary check. This makes the heuristic match the actual signal Railway exposes when a volume is attached.
5. Land the code change via PR. New deploy boots with hardened guard against the now-attached volume — succeeds. If anyone ever detaches the volume in the future, the boot now crashes instead of silently wiping.

**T-012 (next):**

Re-run the T-009 restore against the now-persistent volume DB. Source: `Admin/DB-Backups/prism-dabe-post-restore-20260426-104937.db` (256 rows). Push a no-op trigger commit afterward and confirm the row counts survive a redeploy — the only proof that closes the wipe vector.

### What we still don't know

- **Why was `dabe-staging` set up with a volume but `dashboard-api` was not?** Both services are in the same Railway project. Either the staging setup happened after T-001 with awareness of the volume requirement and the prod fix never got bundled in, or the prod volume was attempted and silently dropped at some earlier point.
- **Did wipe #3 destroy any data that wasn't in the post-restore backup?** Probably not — the backup was taken minutes after T-009's restore and there were no `client`-creating writes in the ~7 hours before the wipe (the prod CRM had 0 clients by policy). But QuickBooks/Stripe-driven writes (auto-pulled financials, etc.) could have been lost. Worth a quick reconcile against Stripe + QB after T-012 lands.

---

## Original investigation (wipes #1 and #2) — 2026-04-24

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
