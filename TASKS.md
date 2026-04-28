# TASKS.md

> **Single source of truth for what's in flight.** This file is the AI-coordination lock — see [WORKFLOW.md](WORKFLOW.md) Section 3.
> **The "In Progress" table contains zero or one row. Never two.**

---

## In Progress

| Task ID | Title | Branch | Owner | Started |
|---------|-------|--------|-------|---------|
| T-015 | Build TASKS.md ↔ Dashboard ↔ Notion sync (one-way, idempotent) | `task/sync-tasks-notion-mirror` | Claude Code | 2026-04-28 13:00 |

---

## Up Next (priority order)

| ID | Title | Why it matters | Owner candidate |
|----|-------|----------------|-----------------|
| T-013 | Rotate remaining 5 prod secrets (API_KEY, STRIPE_SECRET_KEY, QBO_CLIENT_ID, QBO_CLIENT_SECRET, ANTHROPIC_API_KEY) | Carryover from 2026-04-26 session. ADMIN_KEY rotated under T-012. Each of the 5 needs an external rotation in its own console (Stripe, Intuit Developer, Anthropic), then Railway env update. QBO pair also requires re-running OAuth flow. Worth deferring to a dedicated fresh session — not urgent, just hygiene. The previous "ticket 9ea1da15-..." reference does not point to a real ticket in any tracker (Notion 404, no match in dashboard tickets/action_items). | Claude Code |
| T-014 | Fix missing Sign Out button when logged in | Discovered 2026-04-28 during post-rotation smoke-test on prod. Logged in as `michele` on the dashboard root URL — sidebar shows all nav links (Overview through Finance) but the `.nav-user` div (`index.html:683`) with the username + Sign Out button never renders, leaving the user with no UI path to log out. Workaround documented today: `localStorage.removeItem('prism_token'); location.reload()` in DevTools. **Likely causes to investigate (in order):** (1) `hideLoginScreen()` at `index.html:4864` sets `#nav-user.style.display = 'flex'` — verify this fires after login and that the element is in the DOM at that point. (2) The `<nav>` may have `overflow:hidden` or a fixed height that clips the user block when the menu is long; check the nav CSS rules and the cascade. (3) `.nav-user` CSS may default-hide via media query or be missing layout rules. Repro: log in as any user at https://dashboard-api-production-dabe.up.railway.app/ (root, not /login.html), inspect the sidebar bottom. Expected: username + Sign Out button visible below "Invoices". | Claude Code |
| T-016 | Add pre-commit hook that runs `node scripts/sync-tasks.js` when TASKS.md is staged | Followup to T-015. Today the sync is manual and easy to forget — protocol updates in WORKFLOW.md §4 step 4 help, but a pre-commit hook makes it automatic and fail-loud. Hook should: detect TASKS.md in staged files; run sync; abort the commit if sync fails. Use husky or a plain `.git/hooks/pre-commit` script (latter is repo-portable). | Claude Code |
| T-017 | GitHub Action: run `node scripts/sync-tasks.js` on push to main (drift detector) | Followup to T-015. After PR merges, run sync from CI to catch drift between TASKS.md and the mirrors (e.g., if someone edits TASKS.md without running the script locally). Action should fail the workflow if it produces any creates/updates after the merge — that means the local sync was skipped, which is itself a workflow violation worth flagging. Needs `NOTION_API_KEY` and `DABE_API_KEY` GitHub secrets. | Claude Code |

---

## Blocked

_(none yet)_

| ID | Title | Blocked by | Notes |
|----|-------|------------|-------|

---

## Done This Week

| ID | Title | Closed | Notes |
|----|-------|--------|-------|
| T-012 | Re-run T-009 restore against volume-backed dabe DB | 2026-04-28 | **Closed by verification (no implementation merge for T-012's goal).** Branch `task/restore-dabe-from-snapshot` was merged as PR #8 / squash `41b90d1` on 2026-04-27 — but that PR contained only housekeeping (closing T-011a + filing T-013), no restore code. T-012's actual goal (T-009 restore data living on the volume-backed dabe DB) was verified independently on 2026-04-28: prod row counts show `tools=133`, `services=5` — exact matches for the T-009 backup baseline (see T-009 row, T-010 row "Wipe #3"). Conclusion: T-011a's volume attach (`9638aa3`) plus subsequent re-population (likely a sync from the legacy 7058a source after the volume came online) implicitly satisfied this task. No further code change required. |
| T-011a | Attach prod volume + harden `isVolumeReady()` against ephemeral writable dirs | 2026-04-27 | Merged via PR #7 as `9638aa3` (squash). Closes wipe #3 root cause from T-010. **Volume attached:** `dashboard-api-volume` (5 GB) at `/app/data` on `dashboard-api` in production env. **Env vars set:** `DB_PATH=/app/data/prism.db`, `RAILWAY_VOLUME_MOUNT_PATH=/app/data` (Railway auto-injects), `RAILWAY_VOLUME_NAME=dashboard-api-volume`. **Code change:** `isVolumeReady()` now requires `RAILWAY_VOLUME_MOUNT_PATH` to be set AND match expected mount path on Railway; write-test stays as secondary check. **Post-merge verification:** `/health` 200 with new uptime; boot log shows `Mounting volume on: /var/lib/containers/railwayapp/bind-mounts/.../vol_8krewdcg4uie08fi` (real mount, not ephemeral); GitHub Action `Pre-deploy backup` run id `25002998605` succeeded in 13s, uploaded artifact `pre-deploy-backup-9638aa3c09b4b027abbbdbd4399a7cc18e7ab3bd` (34,918 bytes, 90-day retention) — round-trip read+write against the volume-backed DB confirmed. INCIDENT_FINDINGS.md updated with "Wipe #3" section documenting the actual root cause (write-test heuristic could not distinguish ephemeral writable dir from mounted volume; the original "8/8 done" punch list was incorrect — should have been 7/8 with the volume mount step still open). |
| T-010 | Diagnose dabe storage state (read-only) | 2026-04-27 | **No merge SHA — pure investigation.** Confirmed wipe #3 root cause: T-001's fail-hard guard relies on `isVolumeReady()` which only does a write-test, but the Dockerfile's `RUN mkdir -p /app/data` (build log line "stage-1 16/16") creates a writable directory at build time running as root, so the guard passes silently against ephemeral storage. Production has **no volume attached** (`railway volume list` in env=production: empty). NODE_ENV=production ✓, DB_PATH unset, ADMIN_KEY+API_KEY set. Boot log on current container: `Volume /app/data is ready (attempt 1)` then `Opening database at: /app/data/prism.db` — that path is ephemeral. Container uptime ~20h, build image timestamp `2026-04-26T18:03:56Z` confirms wipe-causing redeploy was the T-007 GitHub Action merge. Backup file `Admin/DB-Backups/prism-dabe-post-restore-20260426-104937.db` (516 KB) verified intact: 256 rows total (industries 8, lead_sources 5, team_members 2, services 5, tools 133, business_assets 54, action_items 34, users 2, tickets 13). See INCIDENT_FINDINGS.md "Wipe #3" section. |
| T-008 | Spin up a staging Railway service from a `staging` branch | 2026-04-26 | Merged via PR #6 as `3736338` (squash). Created `dabe-staging` Railway service with own volume `dabe-staging-volume` mounted at `/app/data` (5 GB), deploys from `staging` branch. Used to validate T-009 restore script before prod run. |
| T-000 | Stand up the council, produce WORKFLOW + RUNBOOK + INCIDENT FINDINGS + TASKS | 2026-04-24 | Cowork session output. Files live at repo root. |
| T-001 | Close silent fallback in `getDBPath()` — crash-loud on missing volume in production | 2026-04-24 | Merged via PR #1 as `110dc3c`. Squash commit on top of `e8ac718`. Prod `/health` returned 200 post-deploy; DB accessible. Also added `backups/` to `.gitignore`. |
| T-009 | Restore selected tables from `prism-7058a-*.db` into dabe | 2026-04-26 | Merged via PR #2 as `d29f58e` (squash). 263 of 339 planned rows restored to dabe: industries (8), lead_sources (5), team_members (2), services (5), tools (133), business_assets (54), action_items (34), users (2), tickets (13). 76 rows intentionally NOT restored: projects/invoices/time_entries/payments — all FK-bound to clients (NOT NULL constraint), and policy is "no seed clients in prod / 0 real clients yet ⇒ 0 invoices/etc." Post-restore backup at `backups/prism-dabe-post-restore-20260426-104937.db` (516 KB). |
| T-002 | Take first real backup of prod `prism.db` and store off-disk | 2026-04-26 | 5 .db backups copied from `Development/dashboard/backups/` to `Admin/DB-Backups/` (workspace-root, in Obsidian vault — auto-syncs to cloud if vault sync is on). Files: prism-7058a × 2 (legacy source), prism-dabe × 2 (pre-T-001 + pre-T-009), prism-dabe-post-restore (current dabe state, 516 KB). |
| T-003 | Move AI-coordination protocol docs into dashboard repo (single source of truth) | 2026-04-26 | Merged via PR #3 as `d585608` (squash). Moved WORKFLOW + INCIDENT_FINDINGS + TASKS + DEPLOY_RUNBOOK + PR_JOB_AID into `Development/dashboard/`. All cross-references fixed for sibling layout. Workspace-root CLAUDE.md gained a redirect pointer. |
| T-006 | Update dashboard CLAUDE.md to point at WORKFLOW.md | 2026-04-26 | Rolled into T-003. CLAUDE.md gained a "Read these before any work" section pointing at the 5 protocol docs in priority order. |
| T-004 | Enable GitHub branch protection on `main` | 2026-04-26 | Configured via GitHub Rulesets at `PrismAIAnalytics/prism-ai-dashboard/settings/rules`. Enforces: PR required (0 approvals), block force pushes, restrict deletions, linear history. Bypass list empty (applies to admins too). Verified — direct `git push origin main` rejected with `GH013: Changes must be made through a pull request`. No merge SHA — pure GitHub UI configuration. |
| T-005 | Decide: keep Railway auto-deploy vs switch to manual | 2026-04-26 | **Decision: keep auto-deploy.** With T-001 (volume + fail-hard) and T-004 (branch-protected main, PR-only) in place, the failure modes that wiped prod twice are closed. Remaining risk is "merge a bad PR" — addressed by self-review checklist. No implementation work; decision-only. |
| T-007 | GitHub Action: snapshot prod via `/api/admin/backup-db` on every push to main | 2026-04-26 | Merged via PR #5 as `15b3e57` (squash). After merging, added `DABE_ADMIN_KEY` repo secret + enabled Railway "Wait for CI" toggle on dabe Source settings. First successful run uploaded `prism-dabe-pre-deploy-20260426-174559.db` as an Actions artifact (90-day retention). All future merges to main now auto-snapshot prod before Railway deploys. |

---

## How to use this file

1. **Starting a task:** the AI claims it on its feature branch's **first commit**, which simultaneously (a) closes the previously-merged task with its SHA and (b) moves the new task into In Progress. See [WORKFLOW.md](WORKFLOW.md) §4 "Closing a task — bundle into the next task's first commit."
2. **Finishing a task:** verify the four "done" criteria from [WORKFLOW.md](WORKFLOW.md) §1. The TASKS.md edit (move the row to Done This Week with a `Closed` date and 1-line note including the merge SHA) is bundled into the *next* task's branch — see #1.
3. **Blocked:** move to "Blocked" with a clear blocker. Don't leave it in In Progress — that holds the lock.
4. **Adding new tasks:** append to "Up Next" with a new T-### ID. Keep titles short; one-line "why it matters" forces clarity.
5. **AI sessions:** before doing anything, read this file. If In Progress is non-empty and the owner isn't you, **stop and ask Michele.** (Note: an "In Progress" row may briefly reflect a just-merged task whose close-out is pending — that's the lock being held until the next dispatch picks it up.)

---

## Conventions

- **Task IDs** are sequential `T-###`. Don't reuse numbers.
- **Branches** match the task: `task/short-slug`, `fix/short-slug`, or `chore/short-slug`.
- **One owner per row.** No "Michele + Cowork" — split the task or pick one.
- **Dates** are `YYYY-MM-DD HH:MM` in your local timezone.
- **WIP = 1.** If you find yourself wanting two rows in In Progress, the second one becomes a new top entry in Up Next.
