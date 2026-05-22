# Content Calendar — Notion Database Schema

**Database:** Content Calendar (Notion)
**Database ID:** `249b5785-476a-4e60-9a58-36827cd52111`
**Data source ID:** `eeedb6b5-e525-4715-8139-652706babefa`
**URL:** https://www.notion.so/249b5785476a4e609a5836827cd52111
**Parent:** Prism AI Analytics workspace page (`332236b6-b03a-81ea-9860-f082061ada15`)
**Created:** 2026-05-22 (T-043)
**Schema spec:** [PRISM-Vault/Admin/Leverage-Briefs/T-043.md](../../../PRISM-Vault/Admin/Leverage-Briefs/T-043.md)

## What this DB is for

Single source of truth for Prism AI Analytics content publishing — blog posts, social, podcasts, newsletter, and any other channel-bound piece. Replaces the May–June 2026 Excel content calendar (`Marketing/Prism_Marketing_Content_Calendar_May-June_2026.xlsx`) once T-044 migration cuts over. The dashboard's Calendar page (T-047 + T-048, Phase 4) reads from this DB. After T-044 cutover, Excel becomes read-only history; all content edits happen in Notion.

## Properties

Ten properties, ordered as designed:

| # | Property | Type | Notes |
|---|----------|------|-------|
| 1 | **Title** | TITLE | Content piece name. Required. |
| 2 | **Type** | SELECT | Content type per content-engine taxonomy. Options: `Blog` (blue), `Social` (purple), `Podcast` (pink), `Newsletter` (green), `Other` (gray). |
| 3 | **Platform** | MULTI_SELECT | Destination platforms. Multi-select per [open-questions.md resolution 2026-05-21](../../../PRISM-Vault/Admin/CoS/decisions-log.md) — supports cross-posts like `Personal TikTok + IG` as a single row. Options: `LinkedIn` (blue), `X` (default), `TikTok` (pink), `Instagram` (purple), `Threads` (default), `Bluesky` (blue), `Website` (gray), `Email` (yellow), `Spotify` (green), `YouTube` (red), `N/A` (default — kept for Excel rows that literally said "N/A"). |
| 4 | **Publish Date** | DATE | Scheduled or actual publish date. Required (T-044 migration skips rows without a date). |
| 5 | **Status** | SELECT | Lifecycle state. Options: `Draft` (gray), `Scheduled` (yellow), `Published` (green), `Cancelled` (red). |
| 6 | **Owner** | PEOPLE | Primary owner. Usually Michele. |
| 7 | **Series** | RICH_TEXT | Series tag preserving Excel-style codes (`SOC-005`, `AMC-01`, `FJQ-12`). Free-text, not multi-select — preserves whatever the Excel cell carried verbatim. |
| 8 | **Staging Path** | RICH_TEXT | Repo path while drafting (e.g. `Marketing/Founder_Journey_Queue/series-amc-01-the-problem.md`). One of the two replacement fields for the original "Linked Asset" property per [resolution 2026-05-21](../../../PRISM-Vault/Admin/CoS/decisions-log.md). |
| 9 | **Published URL** | URL | Live post URL after publish (e.g. `https://www.tiktok.com/@prismaianalytics/video/...`). Pairs with `Staging Path` for retrospective traceability — staging stays populated even after publish. |
| 10 | **Source row** | RICH_TEXT | Excel original row ID for T-044 migration audit. Format: `<filename>:<sheet>:<row_number>`. Idempotency key — T-044 re-runs skip rows where this value already exists. |

## Pre-build decisions applied

Per [decisions-log.md 2026-05-21 (afternoon)](../../../PRISM-Vault/Admin/CoS/decisions-log.md):

- **Platform → MULTI_SELECT** (not SELECT). Five SOC-005 rows use `Personal TikTok + IG`. Brand rows routinely have `YT Shorts / IG / TikTok` and `IG / TikTok`. SELECT would have forced duplicate rows per platform or a "Cross-post group" join field — multi-select keeps one row per post regardless of platform count.
- **Linked Asset → paired `Staging Path` + `Published URL`** (not single URL). Pre-publish the asset is a repo path; post-publish it's a live URL. A single field would have forced overwriting the staging reference at publish, breaking retrospective traceability from a live post back to its draft.

## Non-data row handling (T-044 migration)

Per [decisions-log.md 2026-05-21](../../../PRISM-Vault/Admin/CoS/decisions-log.md): T-044 skips any Excel row where column A spans all 8 columns (section header) OR where columns B–H are all NULL (blank spacer). These are formatting artifacts, not content rows.

## Environment

The DB ID is read from `NOTION_CONTENT_CALENDAR_DB_ID` in `.env`. Local: copy from `.env.example`. Railway: set in the service Variables tab (operational follow-up; see T-043's PR description).

## Consumers (downstream)

- **T-044** — migration script reads Excel, writes here. Idempotent via `Source row`.
- **T-047** — `services/calendarMerger.js` reads here as the Content source for the Calendar page.
- **T-048** — Calendar page UI renders content events by Type/Platform color.

## Manual access

Notion: https://www.notion.so/249b5785476a4e609a5836827cd52111
