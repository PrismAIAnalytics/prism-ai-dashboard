# Morning brief — 2026-04-29

Today is **Wednesday**. Here's the shape:
- Today is a **dashboard-plumbing day**: CIS integration, Notion → CRM sync, and PS-053 (Prism Studio dashboard section) — the three highest-scoring tickets — all live in the dashboard repo and unblock visibility for everything else.
- Most urgent: **CIS Compliance Assistant — Claude Code Integration** (High, 24 days old, 12 days overdue) — resume first.
- If skipped, the 7-day-overdue Autonomous Revenue Streams Phase-1 and the 49-item Prism Studio plan stay invisible to the dashboard, so tomorrow's brief has nothing new to triage.

**Top 5 for today:**
1. **CIS Compliance Assistant — Claude Code Integration** — longest-stuck item (24d), 12d overdue, gates the CIS dashboard build.
2. **Build Notion → CRM Ticket Sync** — fixes the very pipe this morning brief runs on. Removes the "skip dashboard API" gap noted below.
3. **Autonomous Revenue Streams — Phase 1 Foundation Setup** — High priority, 7d overdue, blocks the whole revenue-streams program.
4. **PS-053: Add Prism Studio section to CRM Prism Dashboard** — due **today**, unblocks 48 downstream PS-* milestones for May–July.
5. **Create client contract template** — Urgent flag, 18d stale, ESCALATE: governing-law / Net terms / IP default decisions needed before drafting.

---

# Chief of Staff — 2026-04-29 (morning brief)

**Sweep:** 100 tickets pulled · 0 executed · 14 escalated · 0 skipped · 32 deduped to canonical
**Unique tickets after dedupe:** 68
**Oldest still open:** "CIS Compliance Assistant — Claude Code Integration" — 24 days

> Mode note: morning-brief is summary + surfacing. Tickets with executable code/strategy work were inventoried, not run autonomously — most require Michele's eyes on the dashboard repo. The two zero-risk drafts (weekly status cadence, Auto-Eval dedupe spec) are queued as ready-to-run for the next interactive session rather than written blindly today.

## Needs you (14 escalations)

1. **Create client contract template** (Notion · Urgent · 18d) — governing-law state, Net 15 vs 30, IP default, NDA inline or separate.
   What I'd do: draft against industry-standard SaaS consulting MSA with Net 30 + Delaware governing law + work-product-assigned-on-payment.
   Question: Confirm those four defaults so I can draft.
   Stakes: Every new SOW stays bespoke until this lands. Slowing client signings.
   Link: https://app.notion.com/p/33e236b6b03a815389e8dc69c8cbcc65

2. **Add Stripe & QuickBooks Integration to CRM Dashboard** (Notion · High · due 2026-05-02) — read-only first or also writes? QB sandbox vs prod for v1?
   What I'd do: ship read-only payouts + invoice list against QB sandbox for v1; defer write paths to v2.
   Question: Confirm scope, or expand to writes now.
   Stakes: Wrong scope = rework + a security review on writes.
   Link: dashboard ticket — see Notion page

3. **T-013: Rotate 5 prod secrets** (Notion · Medium) — approve rotation window tonight; confirm STRIPE_SECRET_KEY is live not test.
   What I'd do: rotate during 9–10pm window, swap live key in Railway, redeploy.
   Question: Confirm window + that the key is live.
   Stakes: Stale secrets = audit finding. Wrong key = outage on dashboard payments view.

4. **PS-003: Midjourney subscription ($30/mo)** — approve recurring vendor add. Blocks PS-010 + PS-030.

5. **PS-022: eRank trial (~$10/mo)** — pre-authorize the trial or approve per-instance? Delaying PS-016.

6. **PS-004: Open Amazon KDP account** — needs legal name, tax ID, payout bank, confirm prismaianalytics.com email. Blocks PS-027/028.

7. **PS-005: Open Etsy Digital Products account** — same identity/banking inputs as #6. Blocks PS-034/035.

8. **PS-006: Open Gumroad account** — same identity/banking inputs. Blocks PS-036.

9. **Decision Gate 1 (PS-019)** — reserve calendar slot **2026-05-18**. Cascades 30+ days if missed.

10. **Decision Gate 2 (PS-026)** — reserve calendar slot **2026-06-01**.

11. **Decision Gate 3 (PS-038)** — reserve calendar slot **2026-06-22**.

12. **Decision Gate 4 (PS-049)** — reserve calendar slot **2026-07-20**.

13. **PS-045: First email-list send** — approve copy before send; not reversible.
   Stakes: Unsubs / brand damage if wrong tone or list segment.

14. **Create a client contract template (near-dupe of #1)** — same questions; pick one canonical, archive the other.

## Done

No tickets executed in autonomous morning-brief mode. Queue inventoried and triaged only.

## Not yet handled (executable on next interactive session)

Tickets with clear execute paths but reserved for Michele's session:

### internal-admin-ops (queued)
- **CIS Compliance Assistant — Claude Code Integration** — resume the build paused after initial PR. Needs hands on Development/dashboard.
- **Build Notion → CRM Ticket Sync** — code change to ingest the same Notion DB this brief queries; will close the dashboard-API gap.
- **Set up weekly status report cadence** — draft template ready to write; deferred until format confirmed (PRD-style? Newsletter style? — non-blocking for today).
- **Consolidate duplicate files** — root cause is Business Health Auto-Eval generating duplicates; draft the dedupe-by-title-or-DashboardTicketID rule next session.
- **T-014 / T-016 / T-017 / T-018** dashboard housekeeping — small repo edits.

### research-analytics-ops (queued)
- **Autonomous Revenue Streams — Phase 1 Foundation Setup** — scope kept expanding; needs a 30-min scoping pass, then execute.

### sales-bd-ops (queued)
- **Build client proposal template** — DRAFT, blocked on rate-card finalization.
- **Build first case study** — DRAFT, blocked on client publish approval.
- **Create demo dashboard from sandbox data** — needs dataset spec (which sandbox? which metrics?).

### marketing-ops (queued)
- **Pre-build June content library** — DRAFT, blocked on May theme being locked.

### client-delivery-ops (queued)
- **Create client onboarding runbook** — DRAFT, no canonical client flow yet.

### pod-strategy-ops (49 tickets, mostly future-dated)
- Today: **PS-053** (due today, unblocks the rest)
- May milestones: PS-005, PS-006, PS-004, PS-009, PS-007, PS-008, PS-052, PS-011 → PS-025 (20 tickets)
- June milestones: PS-027 → PS-040 (13 tickets)
- July milestones: PS-041 → PS-048 (8 tickets)
- 4 Decision Gates (PS-019, PS-026, PS-038, PS-049) — already escalated above for calendar holds.

## Stuck items (>5 days)

- **CIS Compliance Assistant — Claude Code Integration** — 24d · created 2026-04-04 · build paused after initial PR · longest-stuck
- **Build Notion → CRM Ticket Sync** — 24d · 2026-04-04 · waiting on the sync we're running today
- **Add Stripe & QuickBooks Integration** — 19d · 2026-04-09 · scope question unanswered
- **Build client proposal template** — 18d · rate-card not finalized
- **Build first case study** — 18d · waiting on client publish approval
- **Consolidate duplicate files** — 18d · keeps deferring
- **Create client onboarding runbook** — 18d · no canonical flow yet
- **Create client contract template** — 18d · blocked on terms decisions (escalation #1)
- **Build a client proposal template** — 18d · near-dupe of above
- **Create a client contract template** — 18d · near-dupe (escalation #14)
- **Set up weekly status report cadence** — 14d · format not agreed
- **Pre-build June content library** — 14d · blocked on May theme
- **Create demo dashboard from sandbox data** — 14d · needs dataset spec
- **Autonomous Revenue Streams Phase-1** — 13d · scope kept expanding

## Patterns observed

- **Prism Studio dominates** at 49 tickets, all created 2026-04-28 from the POD Strategy Cowork session. Only PS-053 is due now; the rest are May–July milestones. Plan is real, just heavy in the queue view.
- **Business Health Auto-Eval is the dedupe culprit.** It produced 32 of 100 rows as 5–6× duplicates of 7 evergreen items. Recommend: (a) upsert by `Dashboard Ticket ID` or normalized title, (b) suppress regeneration if a same-title ticket is open. Tracked as the "Consolidate duplicate files" ticket — root-cause fix, not file deletion.
- **Top of the stuck list is all dashboard plumbing** — CIS (24d), Stripe/QB (19d), Notion→CRM (24d). Infra is the long pole, not strategy.
- **Two near-dupes slipped past dedupe** because of an article ("a contract template" vs "contract template"). Fix: normalize to lowercase + strip leading articles before grouping in the Auto-Eval prompt.

## Sources

- **Dashboard API:** ❌ NOT QUERIED — `PRISM_API_KEY` env var not set in this scheduled run. Open dashboard tickets and action items absent from this sweep. Wire the key into the scheduler or the dashboard-side service, then re-run for full coverage.
- **Notion:** ✅ Prism AI Tickets database (`b3b42787-e56b-4807-afcc-ee172df50cb9`) queried via `notion-query-database-view`. 100 rows returned, `has_more: true` — likely more open tickets beyond this dump (server cap). Worth a paginated re-pull next run.
- **Unreachable:** Dashboard API (key missing).

## Run stats

- Total tickets handled: 100 raw / 68 unique
- Executed: 0 (morning-brief inventory mode)
- Escalated: 14
- Stuck-longest: CIS Compliance Assistant — Claude Code Integration (24 days)
