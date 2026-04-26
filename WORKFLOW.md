# WORKFLOW.md

> **Audience:** Michele + every AI session that touches this repo (Cowork, Claude Code, future agents).
> **Read this before any work begins.**

---

## If you remember nothing else

1. **One task in flight. One AI per branch. Never push to main.**
2. **`git fetch && git status` before every session — announce your branch in chat.**
3. **TASKS.md "In Progress" has exactly one row. That row is the lock.**
4. **Every change goes through a PR-to-self with a 5-item checklist.**
5. **Merging to main = deploying to prod. Slow down at the merge button.**

---

## Why this doc exists

Prod has been wiped twice. Both times the cause was the same shape of mistake: a half-finished change shipped on top of (or underneath) another half-finished change, and Railway auto-deployed the broken combo. SQLite means any bad deploy can take data with it.

Michele works with two AIs in parallel — the Cowork session (file edits + planning) and Claude Code in her terminal — plus her own hands. Three actors, one repo, no human reviewer. This is the protocol that keeps the three from racing each other.

---

## 1. WIP = 1

**One task in flight, ever.** "In flight" means: a branch exists, a TASKS.md row says "In Progress", and code on disk is dirty or unmerged.

A task is **done** when ALL of these are true:

- Branch is merged to main (or explicitly abandoned and deleted)
- TASKS.md row moved out of "In Progress"
- Local working tree is clean: `git status` shows nothing
- Railway deploy from that merge has finished and you've smoke-tested prod

Only after all four can you start the next task. If you feel the urge to "just quickly fix one more thing" — that's the urge that wiped prod. Make it the next task.

---

## 2. Branch-per-task

Main is protected in spirit. **Never `git push origin main` directly.** Every change — even a typo — gets a branch.

**Naming:** `task/<short-slug>` for features, `fix/<short-slug>` for bugs, `chore/<short-slug>` for housekeeping.

```bash
git checkout main
git pull --ff-only
git checkout -b task/add-export-button
```

Slugs are kebab-case, max ~5 words, and should match the TASKS.md row title closely enough that you can eyeball which branch belongs to which task.

Delete branches after merge:

```bash
git branch -d task/add-export-button
git push origin --delete task/add-export-button
```

---

## 3. AI coordination protocol (the key section)

**Mechanism: TASKS.md "In Progress" is the lock.** It's already part of your workflow, it's visible in any editor, and it doesn't require a special file or tool.

### The In Progress row

TASKS.md has a section that looks like this. **It contains zero or one row. Never two.**

```markdown
## In Progress
| Task ID | Title | Branch | Owner | Started |
|---------|-------|--------|-------|---------|
| T-042 | Add CSV export button | task/csv-export | Cowork | 2026-04-24 14:10 |
```

**Owner** is one of: `Michele`, `Cowork`, `Claude Code`. That field is the lock — it tells the other two actors "hands off this branch and this area of the code until I'm done."

### Required pre-flight for every AI session

Before either AI touches a single file, it MUST run and report:

```bash
git fetch
git status
git branch --show-current
```

Then announce in chat, verbatim:

> **"I'm on branch `<name>`, working tree is `<clean|dirty>`, TASKS.md In Progress is `<task or empty>`."**

No work begins until that announcement.

### The hard rules for AIs (Cowork and Claude Code both)

- **Never push to main.** Not directly, not via `--force`, not "just this once."
- **Never start work if In Progress is non-empty and the owner isn't you.** Stop and tell Michele.
- **Never switch branches without committing or stashing first** — and announce the switch.
- **Never run `git pull` on main while a feature branch has unmerged commits** — fetch instead.
- **If `git status` shows files you didn't touch, STOP.** That's the other AI's work. Tell Michele.

### When Michele hands a task to an AI

Say it in this shape: *"Take T-042. Branch `task/csv-export`. You own In Progress."* Then update the In Progress row to that AI's name yourself, before they start. You are the dispatcher; the AIs don't claim tasks, you assign them.

---

## 4. PR-to-self workflow

Even solo, every branch goes through GitHub's PR UI. The PR is your speed bump before prod.

```bash
git push -u origin task/csv-export
gh pr create --fill --base main
```

### Self-review checklist (in the PR description, check all 5 before merging)

- [ ] I read the full diff in the GitHub PR view, not just my editor
- [ ] No secrets, no `.env`, no local DB files (`*.db`, `*.db-wal`, `*.db-shm`) in the diff
- [ ] App runs locally on this branch (`npm run dev`) without errors
- [ ] If schema changed: migration is reversible OR I have a fresh DB backup
- [ ] [DEPLOY_RUNBOOK.md](DEPLOY_RUNBOOK.md) pre-deploy checklist completed (see Section 5)

Merge using **"Squash and merge"** so main history stays one-commit-per-task. After merge:

```bash
git checkout main
git pull --ff-only
git branch -d task/csv-export
```

Also click **"Delete branch"** on the merged PR's GitHub page so the remote branch isn't left dangling.

### Closing a task — bundle into the next task's first commit

The merge SHA only exists *after* merge, which makes a clean close-out edit to TASKS.md impossible to bundle into the same PR that did the work. Instead of opening a tiny follow-up PR for every closure, **the close-out edit is bundled into the next task's first commit.** Lifecycle:

1. Michele dispatches T-NEXT to an AI: *"Take T-NEXT. Branch `task/whatever`. You own In Progress."*
2. AI runs `git fetch && git status` and announces (per Section 3).
3. **First commit on the new branch** is housekeeping: `chore: close T-PREV (merged as <SHA>), claim T-NEXT`. Updates TASKS.md to (a) move T-PREV from In Progress to Done This Week with the merge SHA, and (b) move T-NEXT into the In Progress row.
4. Subsequent commits on the same branch do the actual work for T-NEXT.
5. PR ships everything together.

If Michele stops between tasks (no T-NEXT dispatched yet), the In Progress row will continue to show the just-merged task as still In Progress until the next dispatch picks it up. Treat that as "the lock is being held by the AI that just merged" — semantically still correct (no one else should start work). Any AI session that lands during that gap should ask Michele to confirm before claiming.

---

## 5. The auto-deploy danger zone

Until Railway auto-deploy is replaced with manual deploy or a staging gate, **every merge to main is a production deploy.** There is no dry run. There is no rollback button that brings SQLite data back (until the persistent-volume fix lands — see [INCIDENT_FINDINGS.md](INCIDENT_FINDINGS.md)).

Before you click "Squash and merge":

1. Open [DEPLOY_RUNBOOK.md](DEPLOY_RUNBOOK.md) and run the pre-deploy checklist
2. Confirm the SQLite backup is fresh (within the last hour)
3. Have the Railway logs tab open in another window — you watch the deploy
4. Do not merge if you're tired, distracted, or about to step away

**Near-term fix to plan:** Either turn off Railway auto-deploy and make `railway up` a manual command, or move SQLite to a Railway volume that survives redeploys. Until then, treat the merge button like a deploy button — because it is.

---

## 6. Recovery moves

The protocol will get violated. Here's what to do without making it worse.

### "Both AIs touched the same files"

```bash
git status                 # see what's local
git stash push -u -m "rescue-$(date +%s)"
git fetch
git log --oneline origin/main..HEAD
```

Don't merge or rebase yet. Read both sets of changes. Decide which version wins, then re-apply by hand on a fresh branch off latest `main`. The stash is your safety net — `git stash list` keeps it.

### "I pushed to main by accident"

If the deploy hasn't finished: **immediately revert in GitHub UI** (Revert button on the commit). That creates a new commit that undoes it and triggers a clean redeploy.

If the deploy finished and prod is broken:

```bash
git revert <bad-sha>
git push origin main
```

This deploys the revert. Then check the SQLite backup. Then breathe.

### "Merge conflict I don't understand"

Stop. Do not resolve under pressure. Run:

```bash
git merge --abort      # or: git rebase --abort
```

You're back to safe ground. Bring the conflict to **one** AI (not both) with the full output of `git status` and `git diff`. Resolve together, then continue.

### "I don't know what state the repo is in"

```bash
git fetch --all
git status
git log --oneline --all --graph -20
```

That graph tells you the truth. If it still doesn't make sense, do not commit anything. Ask for help.

---

## Companion files

- [TASKS.md](TASKS.md) — the lock; single source of truth for what's in flight
- [DEPLOY_RUNBOOK.md](DEPLOY_RUNBOOK.md) — pre-deploy + rollback procedures for Railway
- [INCIDENT_FINDINGS.md](INCIDENT_FINDINGS.md) — root cause of the two prod wipes
- [CLAUDE.md](CLAUDE.md) — dashboard-specific notes
- [PR_JOB_AID.md](PR_JOB_AID.md) — operator walkthrough for opening PRs and squash-merging

**Pin this file.** When a session starts, the first thing the AI should read after `CLAUDE.md` is `WORKFLOW.md`.
