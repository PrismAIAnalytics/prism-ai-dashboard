---
type: cos-morning-brief
date: 2026-05-13
day_of_week: Wednesday
operator: Chloe
ramp_lens: applied
canonical: true
generated_by: prism-daily-orchestrator (step 7)
---

# Morning Brief — Wednesday, May 13, 2026

## Today looks like
- The week's critical path is the **homepage v2 production push on Friday 2026-05-17** — eight Foundation tickets converge on it. Today's BS-004 voice/visual sign-off is the first domino.
- AI Bridge (assessment framework + scoring rubric) is the longest-running open Foundation drag; 23 and 13 days overdue respectively, blocking the AI Readiness offering.
- Prism Studio account openings (PS-004/5/6/7) are 10 days overdue — zero-cost decisions gating every downstream Studio revenue ticket.

## Top 5 today
1. **BS-004 — Voice/visual sign-off on homepage v2 staging** *(Foundation/Website, due today)* — gates tomorrow's PM-001 prod-push approval; slipping this slips the May 17 launch.
2. **Prepare AI Readiness Assessment framework** *(Foundation/AI Bridge, In progress, 23d overdue)* — longest-running open item; AI Bridge product can't ship without it.
3. **Decide Prism Studio account openings — PS-004/005/006/007** *(Easy-wins, 10d overdue)* — Etsy/KDP/Gumroad/DNS are zero-cost gates; nothing in the Studio queue publishes without them.
4. **Build automated AI-Readiness scoring rubric** *(Foundation/AI Bridge, 13d overdue)* — pair with #2; solving the framework without the rubric leaves the deliverable incomplete.
5. **Stripe + QuickBooks integration (PRISM-3)** *(Foundation/CRM, In progress, 11d overdue)* — financial surface is foundational infra; required before first paying engagement.

## 🟡 Needs Michele
- **PM-001 — Approve homepage v2 staging for Prod push** *(due 2026-05-14)* — external go-live decision, founder gate.
- **PM-002 — Approve workspace-edit batch for tiered positioning** *(8d overdue)* — positioning/brand sign-off with downstream contract-shape implications.
- **Client contract template** *(In progress, due 2026-05-22)* — needs founder review before reuse with any paying client.

## Foundation — overdue (11)
| Ticket | Due | Status | Days |
|---|---|---|---|
| Prepare AI Readiness Assessment framework | 2026-04-20 | In progress | 23 |
| Build automated scoring rubric | 2026-04-30 | Not started | 13 |
| Stripe + QuickBooks → CRM Dashboard | 2026-05-02 | In progress | 11 |
| BS-001 Add productized offerings to brand-foundation.md | 2026-05-04 | Not started | 9 |
| BS-003 Add Decision 09 to homepage-redesign decisions.md | 2026-05-04 | Not started | 9 |
| AN-003 Run marketing:seo-audit on current site | 2026-05-06 | Not started | 7 |
| T-020 Dev Insights review surface (monthly loop) | 2026-05-10 | Not started | 3 |
| IM-001 Drop homepage-v2.html into staging URL | 2026-05-10 | Not started | 3 |
| DS-004 Open Graph 1200×630 social card, homepage v2 | 2026-05-10 | Not started | 3 |
| CW-005 Charlotte SMB AI Readiness Report waitlist copy | 2026-05-12 | Not started | 1 |
| CW-003 AI Readiness Self-Assessment opt-in copy | 2026-05-12 | Not started | 1 |

## Foundation — due this week (8, convergent on May 17 prod push)
- BS-004 — Voice/visual sign-off on homepage v2 staging — **today**
- PM-001 — Approve homepage v2 staging build for Prod push — 2026-05-14
- CW-008 — Cornerstone page outlines for 3 SEO pillars — 2026-05-14
- Design branded PDF report template (AI Bridge) — 2026-05-15
- BS-007 — Voice review on SEO cornerstone outlines — 2026-05-15
- DA-003 — Social row + newsletter capture on homepage v2 footer — 2026-05-15
- BS-006 — Voice review on lead-capture stack copy — 2026-05-15
- IM-004 — Push homepage v2 to production — 2026-05-17

## Easy-wins (Prism Studio) — milestones this week
- PS-057 Amazon Merch artwork output adapter — 2026-05-14
- PS-054 Cross-platform listing copy generator — 2026-05-14
- PS-013 trendspyg rate-limit/proxy fallback — 2026-05-15
- PS-008c Publish ToS at /terms — 2026-05-17
- PS-016 Long-list to 60 candidates with composite scoring — 2026-05-17
- PS-017 studio.prismaianalytics.com landing page draft — 2026-05-17

**Drag note:** 17 additional PS-xxx tickets are overdue, clustered on 2026-05-03/04/07 — account openings, DNS, identity sprint, ingestion cron. Single biggest queue drag. Untangle the PS-004/5/6/7 cluster first; the rest cascades.

## Launch-prep (held, no urgency)
- 3 open Launch-prep tickets — held per ramp framework until ~2026-09-01. **Not** flagged as overdue.

## Active client delivery — Cafe Uvee
- **0** Cafe Uvee tickets surfaced in the first 100-page Notion view (view has `has_more=true`). Cafe Uvee tickets may sit beyond page 1 or under a different label. **Verify before assuming on-track.** Logged as an open question for Chloe.

## Cross-area pattern (Step 5 audit)
- Foundation overdue and Easy-wins overdue both cluster on the May 1–10 window. The convergence on the May 17 prod push suggests homepage v2 absorbed capacity for two weeks. The actual critical path this week is **the May 17 launch**, not the AI Bridge backlog — but the AI Bridge backlog is the longest-running gap and won't move on its own.

## Bucket counts
- Foundation: 22 open · 11 overdue · 8 due this week
- Easy-wins (Prism Studio): 37 open · ~17 overdue · 6 milestones this week
- Launch-prep: 3 open · 0 surfaced as urgent (correct, per ramp framework)
- Active delivery: 0 surfaced in view (verify — `has_more=true`)

## Open question
- Why are no Cafe Uvee tickets in the first page of the Notion view? Either tagged differently, sitting beyond page 1, or queue is empty. Worth a 5-minute check.

## Source
- Notion DB query (db `b3b42787-e56b-4807-afcc-ee172df50cb9`), first 100 records, `has_more=true`.
- No dashboard API cross-check this run (action PATCH calls were sandbox-denied earlier in the orchestrator).
- No duplicate clusters detected — notion-dedup-guardian retirement still clean (now 11+ days).

— Chloe
