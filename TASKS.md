# TASKS.md

> **Single source of truth for what's in flight.** This file is the AI-coordination lock — see [WORKFLOW.md](WORKFLOW.md) Section 3.
> **The "In Progress" table contains zero or one row. Never two.**

---

## In Progress

| Task ID | Title | Branch | Owner | Started |
|---------|-------|--------|-------|---------|
| T-007 | GitHub Action: snapshot prod via `/api/admin/backup-db` on every push to main, uploaded as Actions artifact (90-day retention) | `task/auto-backup-on-deploy` | Claude Code | 2026-04-26 13:30 |

---

## Up Next (priority order)

| ID | Title | Why it matters | Owner candidate |
|----|-------|----------------|-----------------|
| T-008 | Spin up a staging Railway service from a `staging` branch | Gives a non-prod target to test risky changes against | Claude Code |

---

## Blocked

_(none yet)_

| ID | Title | Blocked by | Notes |
|----|-------|------------|-------|

---

## Done This Week

| ID | Title | Closed | Notes |
|----|-------|--------|-------|
| T-000 | Stand up the council, produce WORKFLOW + RUNBOOK + INCIDENT FINDINGS + TASKS | 2026-04-24 | Cowork session output. Files live at repo root. |
| T-001 | Close silent fallback in `getDBPath()` — crash-loud on missing volume in production | 2026-04-24 | Merged via PR #1 as `110dc3c`. Squash commit on top of `e8ac718`. Prod `/health` returned 200 post-deploy; DB accessible. Also added `backups/` to `.gitignore`. |
| T-009 | Restore selected tables from `prism-7058a-*.db` into dabe | 2026-04-26 | Merged via PR #2 as `d29f58e` (squash). 263 of 339 planned rows restored to dabe: industries (8), lead_sources (5), team_members (2), services (5), tools (133), business_assets (54), action_items (34), users (2), tickets (13). 76 rows intentionally NOT restored: projects/invoices/time_entries/payments — all FK-bound to clients (NOT NULL constraint), and policy is "no seed clients in prod / 0 real clients yet ⇒ 0 invoices/etc." Post-restore backup at `backups/prism-dabe-post-restore-20260426-104937.db` (516 KB). |
| T-002 | Take first real backup of prod `prism.db` and store off-disk | 2026-04-26 | 5 .db backups copied from `Development/dashboard/backups/` to `Admin/DB-Backups/` (workspace-root, in Obsidian vault — auto-syncs to cloud if vault sync is on). Files: prism-7058a × 2 (legacy source), prism-dabe × 2 (pre-T-001 + pre-T-009), prism-dabe-post-restore (current dabe state, 516 KB). |
| T-003 | Move AI-coordination protocol docs into dashboard repo (single source of truth) | 2026-04-26 | Merged via PR #3 as `d585608` (squash). Moved WORKFLOW + INCIDENT_FINDINGS + TASKS + DEPLOY_RUNBOOK + PR_JOB_AID into `Development/dashboard/`. All cross-references fixed for sibling layout. Workspace-root CLAUDE.md gained a redirect pointer. |
| T-006 | Update dashboard CLAUDE.md to point at WORKFLOW.md | 2026-04-26 | Rolled into T-003. CLAUDE.md gained a "Read these before any work" section pointing at the 5 protocol docs in priority order. |
| T-004 | Enable GitHub branch protection on `main` | 2026-04-26 | Configured via GitHub Rulesets at `PrismAIAnalytics/prism-ai-dashboard/settings/rules`. Enforces: PR required (0 approvals), block force pushes, restrict deletions, linear history. Bypass list empty (applies to admins too). Verified — direct `git push origin main` rejected with `GH013: Changes must be made through a pull request`. No merge SHA — pure GitHub UI configuration. |
| T-005 | Decide: keep Railway auto-deploy vs switch to manual | 2026-04-26 | **Decision: keep auto-deploy.** With T-001 (volume + fail-hard) and T-004 (branch-protected main, PR-only) in place, the failure modes that wiped prod twice are closed. Remaining risk is "merge a bad PR" — addressed by self-review checklist. No implementation work; decision-only. |

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
