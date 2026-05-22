---
type: cos-morning-brief
date: 2026-05-12
weekday: Tuesday
operator: Chloe
mode: morning-brief
ramp_target: 2026-10-01
sources:
  - Notion Prism AI Tickets DB (b3b42787-e56b-4807-afcc-ee172df50cb9)
  - Dashboard API (Railway) — PRISM_API_KEY not present, skipped
tags: [cos, chloe, morning-brief, ramp-foundation]
---

# Chief of Staff — Morning Brief — Tuesday 2026-05-12

## Today looks like

- **Homepage v2 prod-push week is live.** Five days to the 2026-05-17 push. The four CW-### lead-capture copy drafts are due today and feed the homepage forms going to staging Wednesday. BS-004 voice sign-off Wednesday, PM-001 prod approval Thursday. Anything that slips today pushes the launch into next week.
- **CMforAI primer publishes Thursday 5-14.** Eight posts staged and review-passed; the only open question is the publish-path call (sequential PRs vs batch with future dates) and whether Primer or Post 1 anchors Day 1. Mechanical writing is done.
- **Prism Studio launch cluster is cold.** 17 PS-* tickets overdue, oldest 14 days. Decision Gate 1 is six days out (2026-05-18). This is a direction call, not a sequencing problem — Michele needs to recommit, defer, or scope down before more tickets get worked.

## Top 5 for today

1. **CW-003 / CW-004 / CW-005 — Lead-capture copy drafts** (Marketing, High, due 2026-05-12) — Foundation. Four marketing tickets due today wire AI Readiness Self-Assessment opt-in, Charlotte SMB Report waitlist, and Field Notes newsletter signup + welcome flow. These are the copy inputs for the homepage v2 forms being implemented Wednesday (IM-008). Bottleneck for the prod push.
2. **CMforAI Primer publish path decision** — Foundation. Primer (`what-is-ai-agent-governance`) ships Thursday 5-14. Yesterday's resume note left two decisions open: sequential vs batch PR, and Primer vs Post 1 as Day-1 entry. Reversible either way, but the call shapes today's work. Recommend: WIP=1 sequential PRs, Primer leads (it's the entry doc the rest references).
3. **BS-004 voice/visual sign-off + PM-001 prod approval** (Marketing/Web, Urgent, due 5-13/5-14) — Foundation. Two Michele blocks of ~30 minutes each. BS-004 reviews the homepage v2 staging build against the voice and visual brief; PM-001 approves the build for production push on 5-17. Both gate Sunday's launch.
4. **PS-004 / PS-005 / PS-006 / PS-007 — Account openings + DNS** (Easy-wins, High, 9d overdue) — Etsy, Gumroad, Amazon KDP, and studio.prismaianalytics.com subdomain. Mechanical work. Only Michele can sit down with credentials and ID. Gates PS-019 Decision Gate 1 on 5-18 — but only worth doing if Studio is still in for May (see escalation #2).
5. **NTN-0124 — AI Readiness Assessment framework** (Foundation, High, In Progress, 22d overdue) — oldest open Foundation item. Already started. Finish enough to unblock NTN-0125 scoring rubric (12d overdue, dependent on this). Or formally re-baseline and accept the slip — the worst state is "half-done indefinitely."

## Needs Michele (3 escalations)

1. **🟡 CMforAI publish path** (Foundation). Open decisions: (a) PR each post sequentially or push all 8 with future dates; (b) lead with Primer or Post 1 on 5-14. Recommend: WIP=1 sequential, Primer leads. *What I'd do without input:* publish Primer on 5-14, then one post every 2–3 days through end of month. *Stakes:* low — either path is reversible inside one PR cycle. Want the call before the publish window opens Thursday.

2. **🟡 Prism Studio direction call** (Easy-wins). 17 PS-* tickets overdue since the 2026-05-01 ramp realignment, none executed. Decision Gate 1 (PS-019) is 2026-05-18, six days out. Three paths: (a) re-commit and clear the queue this week — needs ~4 hours of Michele time on account opens and identity sign-off, (b) defer Studio to post-launch (~Q4 2026), (c) scope down to identity + accounts + DNS this week, defer the trend-pipeline tickets (PS-008g, PS-012, PS-052) until after homepage v2 ships. *Recommend:* (c). *Stakes:* without a call, the queue keeps aging and PS-019 Gate 1 slips by default.

3. **🟡 PRISM-3 / NTN-0002 — Stripe + QuickBooks first invoice** (Foundation). Stripe live, QB OAuth wired, but $0 has flowed through. *Recommend:* draft a $1 test invoice to a Michele-controlled email; validate the end-to-end loop; close action #33. *What I'd do without input:* draft and stage it, hand to Michele to send. *Stakes:* contained — drafting is reversible. Sending requires Michele's hand on the button.

## Sweep

- **Source:** Notion `Prism AI Tickets` view, first page of 100. `has_more=true` — Cafe Uvee scoping ticket sits on page 2 and is not in this sweep. Second-page pull is queued for tomorrow's run.
- **Dashboard API:** PRISM_API_KEY not in session env — Railway endpoints skipped this run. CRM-004 (token rotation) still open, 8 days overdue. Eighth consecutive Notion-only brief.
- **Status mix (first 100):** 96 Not started · 4 In progress · 0 closed shown.
- **Priority mix:** 7 Urgent · 54 High · 34 Medium · 5 Low.
- **Overdue:** 40 of 100 (40%). Fourteen ≥7 days overdue.
- **Oldest still open:** NTN-0124 "Prepare AI Readiness Assessment framework" — 22 days overdue, In Progress.

## Regression signal — duplicate Dashboard Ticket ID

The `Dashboard Ticket ID` key `NTN-0002` is in use by two unrelated tickets:

- **NTN-0002** — "Add Stripe & QuickBooks Integration to CRM Dashboard" (High, In Progress, due 2026-05-02)
- **NTN-0002** — "PS-055: Build IP pre-publish screen utility (tooling for PS-033)" (High, Not started, due 2026-05-07)

The notion-dedup-guardian was retired 2026-05-02 after an 18-day clean streak. This is the first ID collision since retirement. Cluster size is 2 (the spec flags clusters >2), so this is a single-instance regression, not a pattern yet — but it's the first signal worth watching. A second collision this week → reinstate the guardian. Same regression pattern: `PS-013` is also used by two tickets (NTN-0082 "Build niche long-list" and NTN-0008 "trendspyg rate-limit / proxy fallback for PS-012 cron"). PS-### key reuse is structural and worth a 60-second re-key of the trendspyg one to PS-058 or similar.

## Done in last 24h (orchestrator chain)

- gdrive→Obsidian sync: 44 docx → md, 0 errors.
- Action queue cleanup: 17 stale auto-friction tickets archived (>14 days old). Pending action queue 39 → 22 (44% reduction).
- Operations maturity score: 62 → 65 (noise-floor reduction, not throughput).
- 8 new session notes mirrored into Obsidian vault (`Sessions/Session 2026-05-03` through `2026-05-12`).
- Daily-reviews vault: source `Daily_Log_*.md` generation has not produced 5-3 through 5-11. Sync chain is fine; upstream script worth checking next week.

## Not yet handled

- The 22 Foundation-overdue marketing / AI-bridge tickets not in today's top 5. Most are in the homepage v2 cluster and fall in line once PM-001 approves the Prod push on Thursday.
- 17 PS-* overdue — held pending escalation #2.
- Cafe Uvee scoping — on Notion page 2, second-page pull queued for tomorrow.
- CRM-004 / Railway token rotation — eighth consecutive day. Needs Michele's hand on the Railway console.

## Bucket counts

- **Foundation overdue:** 23
- **Foundation due this week (through 2026-05-18):** 24
- **Easy-wins (Prism Studio) overdue:** 17 · **milestones this week:** 8 (PS-018 long-list packet + PS-019 Decision Gate 1 both 5-18 are the headline)
- **Launch prep held:** 0 (Apollo prospecting parked at 2026-09-01, demo dashboard at 2026-09-15 per the ramp realignment — off the urgent radar by design)
- **Active delivery in flight:** 0 (Cafe Uvee scoping continues; pagination needed for visibility)

## Cross-area maturity note

Three maturity-dashboard areas are correlated, not independent: Sales & Pipeline (25), Client Delivery Ops (20), and Financial Operations (30) all score low for the same reason — no revenue motion has actually fired. These move together once PRISM-3's invoicing loop closes and the first paid engagement lands. Don't double-penalize.

## Sources

- Notion Prism AI Tickets: `https://www.notion.so/b3b42787e56b4807afccee172df50cb9?v=338236b6b03a8135bbcb000c347df559`
- Dashboard API: `https://dashboard-api-production-dabe.up.railway.app/` — auth-blocked this session (CRM-004 open)
- Vault context: `C:\Users\miche\Obsidian\Obsidian Vault\CLAUDE.md`, `Chloe\Operating Notes.md`
- Triage rubric: `chief-of-staff/references/triage-rubric.md`
- Escalation policy: `chief-of-staff/references/escalation-policy.md`

— Chloe
