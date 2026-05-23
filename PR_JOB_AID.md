# Job Aid — Opening a Pull Request and Squash-Merging

> **Audience:** Michele, working solo with AI assistants on the Prism AI Dashboard repo.
> **Companion to:** [WORKFLOW.md](WORKFLOW.md) §4 (the protocol) and [TASKS.md](TASKS.md) (the lock).
> **When to use this:** every time an AI session pushes a feature branch and asks you to merge it.

---

## What you're doing and why

A pull request (PR) is GitHub's "speed bump before prod." Even though you're solo, every code change goes through a PR so:

- You see the full diff in a clean view before it ships
- You have a chance to spot secrets, bad SQL, or surprise file changes
- The merge produces a single clean commit on `main`
- Railway auto-deploys *only* after you click the merge button — never before

If you skip the PR step, you're shipping straight to prod with no review window. That's the failure mode that wiped prod twice — see [INCIDENT_FINDINGS.md](INCIDENT_FINDINGS.md).

---

## Prerequisites

Before you start, the AI session has already:

1. Created a feature branch (e.g. `task/csv-export`, `fix/railway-persistent-db`)
2. Committed changes to that branch
3. **Pushed the branch to GitHub** (you'll see a URL like `https://github.com/.../pull/new/task/csv-export` in the chat)
4. Given you a **PR title** and **PR body** to copy-paste

If any of those four are missing, ask the AI to finish before you start this job aid.

---

## Step 1 — Open the PR on GitHub

1. **Click the URL the AI gave you** (or go to `https://github.com/prismai-dotcom/prism-ai-dashboard` and click the yellow "Compare & pull request" banner).

2. You land on the **"Comparing changes"** page. At the top:

   | Field | Should say | If wrong |
   |---|---|---|
   | `base` | `main` | Click and change to `main` |
   | `compare` | the feature branch name | Click and pick the right branch |

3. **Title field** (single line at top): paste the title the AI gave you. Always starts with the task ID, e.g.:

   ```
   T-001: fix(db) — crash-loud on missing volume in production
   ```

4. **Description field** (the big text box, supports Markdown): paste the entire PR body block from the AI. It usually includes:
   - `## Summary` — what this PR does
   - `## What changed` — file-by-file
   - `## Self-review checklist` — the 5 boxes you tick before merging
   - `## Deploy plan` — what to watch on Railway after merge

5. Click the green **"Create pull request"** button (bottom right).

You're now on the PR page. URL looks like `.../pull/2`.

---

## Step 2 — Review the diff (the part that prevents disasters)

1. Click the **"Files changed"** tab (third tab from the left, next to "Conversation" and "Commits").

2. **Skim every changed file.** For each one, ask:

   | Check | What it looks like in the diff |
   |---|---|
   | Files I expected? | Compare against the AI's "What changed" section. If the AI says 2 files but you see 5, stop and ask. |
   | Any new secrets? | Scan for `sk-`, `ntn_`, `pO0`, `Bearer`, `password`, `key=`, anything that looks like a token |
   | Any `.env` or `.db` files? | These should NEVER be in a PR. If they are, stop. |
   | Any DROP / DELETE / TRUNCATE SQL? | Destructive SQL needs explicit discussion before merge |
   | Any reference to tables we agreed to skip? | E.g. for T-009 we agreed `clients` was off-limits; if it appeared in a diff, that's a red flag |

3. **Scroll through the entire diff.** GitHub shows added lines in green, removed lines in red. Don't trust the AI's summary blindly — confirm by reading.

4. Tick the boxes in the **Self-review checklist** in the PR description as you go (GitHub renders `- [ ]` as clickable checkboxes).

If anything looks wrong, **don't merge.** Comment on the PR or message the AI: "I see X in the diff that wasn't in the summary — explain?"

---

## Step 3 — The squash-merge button (the part Michele got wrong the first time)

Scroll back to the **"Conversation"** tab. At the bottom of the page there's a green button.

### The trap

The button's default text is **"Merge pull request"**. **Do not click it directly.** That option creates a regular merge commit and leaves two commits on `main` per PR (yours + a merge commit), which clutters history.

### What to do instead

1. Click the **little dropdown arrow ▾** to the right of the green button.

2. You see three options:

   | Option | When to use |
   |---|---|
   | Create a merge commit | Don't use. Leaves messy history. |
   | **Squash and merge** | **Always use this for our workflow.** Combines all branch commits into one clean commit on `main`. |
   | Rebase and merge | OK alternative but stick with squash. |

3. Click **"Squash and merge"**. The big green button text changes to **"Squash and merge"**.

4. Click the now-green **"Squash and merge"** button.

5. A confirmation panel slides down:

   - **Commit title:** auto-filled with the PR title and PR number (e.g. `T-001: fix(db) ... (#1)`). Leave it.
   - **Commit message:** auto-filled with the body of your branch's commits. Leave it.

6. Click **"Confirm squash and merge"** (green button, bottom of the panel).

You see a purple banner: **"Pull request successfully merged and closed."**

---

## Step 4 — Delete the branch (housekeeping)

GitHub shows a **"Delete branch"** button right where the merge button used to be. **Click it.** This removes the remote (GitHub-side) copy of the branch. Doesn't delete your local copy yet.

Then in PowerShell on your machine:

```powershell
cd "C:\Users\miche\Prism AI\PRISM AI Analytics\Development\dashboard"
git checkout main
git pull --ff-only
git branch -d <branch-name>
```

Replace `<branch-name>` with the feature branch (e.g. `task/csv-export`). The `-d` (lowercase) refuses if you have unmerged commits — which is the safety check you want.

### Common pitfall: `desktop.ini` ghost ref

If `git pull --ff-only` errors with something like `fatal: bad object refs/remotes/origin/desktop.ini`, run this once:

```powershell
Get-ChildItem -Recurse -Force .\.git\refs -Filter "desktop.ini" | Remove-Item -Force
git pull --ff-only
```

Then retry. (Windows Explorer creates these and git mistakes them for branch refs.)

---

## Step 5 — Watch Railway redeploy

Open Railway dashboard → service `dashboard-api-production-dabe` → **Deployments** tab. The new deploy starts within ~30 seconds of your merge.

Watch the build logs scroll. The deploy succeeds when you see:

```
Volume /app/data is ready
Opening database at: /app/data/prism.db
PRISM AI Analytics Dashboard (v2.0 — Hardened)
http://localhost:3000
Environment: production
```

**Smoke-test prod immediately:**

```powershell
curl https://dashboard-api-production-dabe.up.railway.app/health
```

Expect `{"status":"healthy",...}`. If you get anything else, ping the AI before doing anything else.

### What to do if FATAL fires

If Railway logs show:

```
FATAL: NODE_ENV=production but no persistent volume is available at /app/data...
```

**Don't revert the PR.** That message is the T-001 guardrail working — it means the `DB_PATH` env var or the volume mount got lost. Fix the config in Railway → Variables, then trigger a redeploy. If you're stuck, ask the AI.

---

## Step 6 — Close out the task in TASKS.md (bundled into the next task)

Per [WORKFLOW.md](WORKFLOW.md) §1, a task is **done** only when all four are true:

- ✅ Branch is merged to main
- ✅ TASKS.md row moved out of "In Progress" (with merge SHA logged in Done This Week)
- ✅ Local working tree is clean (`git status` shows no tracked-file changes)
- ✅ Railway deploy from that merge has finished and you've smoke-tested prod

**The TASKS.md edit happens on the *next* task's first commit, not as a separate PR.** See [WORKFLOW.md](WORKFLOW.md) §4 "Closing a task — bundle into the next task's first commit." So right after merge:

- **If you have a next task in mind:** dispatch it. The AI's first commit on the new branch will close out the previous task and claim the new one in a single TASKS.md edit. No follow-up PR needed.
- **If you're stopping:** the In Progress row will continue to show the just-merged task until the next dispatch. That's intentional — the lock is being held until you decide what's next. No action needed from you.

What you DO want to verify right now:

1. Branch is deleted on remote (the "Delete branch" button on the merged PR's page) — also delete locally with `git branch -d <branch>`
2. Railway deploy succeeded and `/health` returns 200
3. If anything looks wrong, ping the AI before dispatching the next task

---

## Step 7 — Move to the next task (or stop)

You can now:

- **Pick the next task** from "Up Next" in TASKS.md and dispatch it: *"Take T-XXX. Branch `<name>`. You own In Progress."*
- **Or stop.** WIP=1 means the next task starts only when you say so. Closing your laptop with In Progress empty is a clean state.

---

## Quick cheat sheet (laminate this)

```
1. Click PR URL from AI
2. Paste title + body, click "Create pull request"
3. Files changed tab → eyeball every diff for surprises
4. Click ▾ next to green button → "Squash and merge" → confirm
5. Click "Delete branch" on the PR page
6. PowerShell: git checkout main; git pull --ff-only; git branch -d <branch>
7. Railway → Deployments tab → watch logs until "Opening database at..."
8. curl /health → expect "healthy"
9. TASKS.md: confirm In Progress is empty, task is in Done This Week
```

---

## Common pitfalls (what to NOT do)

| Don't | Because |
|---|---|
| ❌ Click the green button without expanding the dropdown | You'll create a merge commit instead of squash-merging — messy history |
| ❌ Skip the "Files changed" review | This is your only chance to catch a leaked secret before it ships |
| ❌ Force-push to main | This rewrites history and is genuinely dangerous; never do this |
| ❌ Merge a PR with the FATAL guard misconfigured | If you didn't watch Railway logs after merge, you don't know if your DB is on a volume or about to be wiped |
| ❌ Leave In Progress non-empty after a merge | The next AI session won't know whether to start work; the lock is broken |

---

## When something goes wrong

- **PR says "Merging is blocked":** GitHub branch protection (T-004 once enabled) is doing its job — read the failed checks, fix, push again.
- **Squash-merge button is greyed out:** there are merge conflicts. Stop. Ask the AI: "Resolve conflicts on `<branch-name>` against latest main."
- **You merged the wrong PR:** click "Revert" on the PR page. GitHub creates a clean commit that undoes the merge.
- **You can't tell what state the repo is in:** `git fetch --all && git log --oneline --all --graph -20` — that picture tells the truth.

---

## Updating this job aid

If a step in this doc led you wrong or you discovered a new gotcha, add a note inline. The whole point of writing it down is so the next round (yours or someone else's) doesn't relearn the same lesson.
