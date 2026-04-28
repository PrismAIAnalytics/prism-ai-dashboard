# HANDOFF — Add Prism Studio operating page to the CRM Dashboard

**Session date:** 2026-04-28
**Author:** Claude (Cowork session)
**Handoff target:** Claude Code (on Michele's machine, with shell + git + Railway access to dashboard repo)
**Companion plan:** `../../Revenue_Workstreams/Prism_Studio_Integration_Plan_2026-04-28.md` (phases A, B, C)
**This handoff covers Phase A only.** Phases B (orchestrator routine SKILL.md files) and C (closure) are executed back in Cowork.

---

## Status: Specced. Ready for implementation.

The Prism Studio workstream (POD + digital-product side line under the Prism AI parent brand) was charter-approved this session. The strategy team produced 49 tickets in Notion under the new "Prism Studio" category, a sub-brand identity, and a 13-week timeline to a Mon Jun 22, 2026 go-live.

**What's needed:** an operating page inside this dashboard so Michele can see at a glance whether the autonomous strategy team is working — the "single pane of glass" pattern. The Cowork sidebar artifact is a quick reference but is **not** the dashboard.

---

## Context — read these first (per CLAUDE.md protocol)

1. `WORKFLOW.md` — WIP=1, branch-per-task, never push to main, squash-merge only
2. `TASKS.md` — confirm In Progress is empty before claiming this work
3. `INCIDENT_FINDINGS.md` — root cause of the two prod wipes; why the protocol matters
4. `DEPLOY_RUNBOOK.md` — pre-deploy checklist
5. `PR_JOB_AID.md` — operator walkthrough for opening PRs and squash-merging
6. `server.js` (~860 lines) — confirm patterns for routes, middleware, DB queries, Notion sync wiring
7. `public/index.html` — match HTML/CSS/JS conventions (vanilla, no bundler, no framework)
8. The companion plan at `../../Revenue_Workstreams/Prism_Studio_Integration_Plan_2026-04-28.md`

If `TASKS.md` In Progress is non-empty and the owner isn't you, **stop and ask Michele.**

---

## What to build (Phase A)

**Branch:** `feat/prism-studio-page`

### A1. Backend — three new routes in `server.js` (~120 lines added)

| Route | Method | Returns |
|---|---|---|
| `/api/studio/today` | GET | Counts (urgent due ≤ today, in-progress, awaiting decision-gate, done this week) plus the urgent ticket list. |
| `/api/studio/tickets` | GET | Full Prism Studio ticket list. Query params: `status`, `role`, `phase`, `limit`, `offset`. |
| `/api/studio/activity` | GET | Latest entries from the Prism Studio Activity Log Notion page, parsed into structured rows. Query param: `limit` (default 20). |

**Conventions to match (do not break existing patterns):**
- Auth-gate behind `API_KEY` env var when set (matches existing `/api/*` pattern; `/health` stays open)
- `express-validator` on all query params
- Error handling matches the existing 4xx/5xx response shape
- Cache responses ~60s server-side to be polite to the Notion API

**Data source decision (open question — see below):** Either pull from local SQLite (if the existing Notion → CRM ticket sync is already populating local rows — see the "Build Notion → CRM Ticket Sync" Notion page), or call the Notion API directly server-side.

### A2. Frontend — new file `public/studio.html` (~250 lines)

Single-page vanilla HTML/CSS/JS. No bundler, no framework, no TypeScript. Match the existing dashboard pages.

**Sections (top-down):**
1. **Today** — date stamp, current phase, 4 KPI cards: Urgent / In Progress / Awaiting Decision / Done This Week
2. **Tickets needing attention right now** — clickable list, links to Notion ticket pages
3. **Daily 5-Minute Routine** — morning ritual card (open dashboard → scan activity → address decisions → close completed → done)
4. **Live Activity Feed** — last 20 entries from the Notion Activity Log
5. **This week's critical path** — the Phase 0 W0 checklist (Apr 28–May 3)
6. **13-week Phase Gantt** — to-go-live view
7. **Decision Gates** — 5 gates with dates (Gate 0 today through Gate 4 Jul 20)
8. **Team Roster** — 9 roles with ticket counts
9. **Channel unit economics** — reference table

**Behavior:**
- `fetch()` calls to the three `/api/studio/*` endpoints on load
- Refresh button + 5-minute auto-refresh (`setInterval`)
- Loading states with the existing dashboard's spinner pattern
- Mobile-responsive (CSS grid → single column under 720px)

**Brand compliance (from `prismai-company-profile`):**
- Prism Navy `#17135C` for primary headings
- Prism Royal `#3A5998` for accents/links
- Prism Sky `#BDC9DD` elevated as Prism Studio accent (signals the consumer line)
- Inter for headings, Arial fallback
- Deep Charcoal `#1A1A2E` body text, never pure black

### A3. Navigation

Add a "Prism Studio" link to the existing dashboard nav. Match the existing pattern in `public/index.html` (top bar, side nav, or whatever pattern is already there).

### A4. Local test → PR → squash-merge → Railway deploy

1. `npm run dev` — confirm port 3000 boots
2. Hit all 3 endpoints with `curl` (with `Authorization: Bearer $API_KEY` if set); verify valid JSON
3. Visit `/studio` in the browser; verify renders without console errors
4. Resize to ≤720px; verify mobile layout
5. Run the pre-deploy checklist in `DEPLOY_RUNBOOK.md`
6. Open PR with the `PR_JOB_AID.md` template; squash-merge to `main`
7. Railway auto-deploys to https://dashboard-api-production-dabe.up.railway.app
8. Smoke test the production `/studio` URL; verify live data renders

---

## Notion data — what your endpoints will read

**Database:** "Prism AI Tickets" (https://www.notion.so/b3b42787e56b4807afccee172df50cb9)
**Data source ID:** `e11bc493-39a0-4252-8c8c-68219ecc324c`
**Filter for Prism Studio tickets:** `Category = "Prism Studio"` (49 tickets currently, IDs PS-001 through PS-053; PS-050–PS-053 are infrastructure tickets including this work)

**Schema fields you'll consume:**
- `Ticket` (title) — format: `PS-XXX: <description>`
- `Status` — "Not started" / "In progress" / "Done"
- `Priority` — "Urgent" / "High" / "Medium" / "Low"
- `Team Role` — Michele / Chief Strategist / Trend Scout / Niche Analyst / Compliance & IP Officer / Monetization Architect / Content Production Lead / Performance Analyst / Brand Steward
- `Due Date` — date
- `Source` — text (always starts with `Cowork 2026-04-28 / POD Strategy / Owner: <Role>`)

**Activity Log page:** "Prism Studio — Activity Log"
**Page ID:** `350236b6-b03a-816f-8d5c-e9f9d423f32a`
**URL:** https://www.notion.so/350236b6b03a816f8d5ce9f9d423f32a
**Format:** Markdown date headings (`### YYYY-MM-DD`) followed by lines like `- HH:MM ET — Role — Outcome`

The orchestrator routine (Phase B, executed in Cowork) will populate this page daily once charter is signed and PS-051 is complete.

---

## Open questions to confirm with Michele before code lands

1. **Existing Notion → CRM Ticket Sync.** Is the sync described in the Notion page "Build Notion → CRM Ticket Sync" currently active and populating local SQLite? If yes, `/api/studio/*` reads from SQLite (fast). If no, those endpoints call the Notion API directly each request (still fine, just slower).
2. **Auth posture.** Default plan: `/api/studio/*` gated behind `API_KEY` if set, matching most other `/api/*` routes.
3. **Page route.** Default `/studio`. Acceptable alternatives: `/prism-studio`, `/pod`. Lock the name before linking from emails or external pages.
4. **Navigation pattern.** Read `public/index.html` first; match whatever's there (top bar, side nav, etc.).

---

## Success criteria

- [ ] Branch `feat/prism-studio-page` exists; PR opened
- [ ] All three `/api/studio/*` endpoints return valid JSON; auth works as expected
- [ ] `public/studio.html` renders in dev and on production with no console errors
- [ ] Page loads in <2s; auto-refreshes every 5 min
- [ ] Mobile layout works at ≤720px
- [ ] Nav link to "Prism Studio" added; navigation flows in both directions
- [ ] PR squash-merged; Railway deploy succeeded; production `/studio` live
- [ ] PS-053 ticket in Notion updated to Done with completion notes (link to deployed URL, line counts, deploy timestamp) — or hand back to Cowork to close

---

## After Phase A merges and deploys

Phase B (orchestrator routine SKILL.md files in `C:\Users\miche\.claude\scheduled-tasks\`) and Phase C (Notion ticket closures, Cowork artifact refresh, first verification) are executed back in **Cowork**, not here. Stop after Phase A is in production. Ping Michele or hand back the session.

---

## Risk notes

- Production has been wiped twice (see `INCIDENT_FINDINGS.md`). The protocol is mandatory, not optional. Do not skip the WIP=1 / branch-per-task / squash-merge / no force push discipline.
- The `xlsx` package in this repo has unpatched vulnerabilities; this work doesn't touch it but if any added code path needs spreadsheet parsing, do not use `xlsx`.
- `better-sqlite3` requires native compilation on Windows (VS Build Tools "Desktop development with C++" workload). Should already be installed; if a fresh `npm install` is needed, that prereq applies.

---

## Why this handoff exists

Michele asked whether this work should run in Cowork or Claude Code. The honest answer is split: Phase A (real codebase work in a repo with a strict AI-coordination protocol born from two prior production wipes) is Claude Code's home turf. Phase B (config files for the Cowork Routines feature) and Phase C (Notion + Cowork artifact updates) belong in Cowork. This file is the bridge — everything Claude Code needs to execute Phase A without reloading the full project context.

— end handoff —
