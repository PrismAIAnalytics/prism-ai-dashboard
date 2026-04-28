# HANDOFF — AI Readiness Assessment Framework Integration

**Owner:** Michele Fisher · Prism AI Analytics
**Executor:** Claude Code (agentic)
**Created:** 2026-04-20
**Target env:** Local dashboard only (`Development/dashboard/`, port 3000). Do **not** deploy to Railway in this pass.
**Related tasks (in dashboard DB):**
- `Prepare AI Readiness Assessment framework` — in_progress, due 2026-04-20 (this handoff)
- `Build automated scoring rubric` — backlog, due 2026-04-30 (covered by Deliverable 3 here)
- `Design branded PDF report template` — backlog, due 2026-05-15 (NOT in scope of this handoff)

---

## 1. Goal

Reconcile the AI Readiness Assessment framework across three places that currently disagree (form, DB, marketing), expand Form2 from ~13 to 24 questions across 6 dimensions, wire the form into the live dashboard so submissions persist to SQLite, and update marketing copy to match.

## 2. Canonical Taxonomy — lock this first

Every file touched in this handoff must use these exact dimension names, order, and short codes. No synonyms.

| # | Dimension | Short code | What it measures |
|---|-----------|------------|------------------|
| 1 | Data Infrastructure | `data_infra` | Quality, accessibility, structure, and accuracy of business data |
| 2 | Technology Stack | `tech_stack` | Modernness, integration, and AI-compatibility of current tools |
| 3 | Process Maturity | `process_maturity` | Documentation, repeatability, and automation-readiness of workflows |
| 4 | Team Readiness | `team_readiness` | Literacy, training, and cultural appetite for AI adoption |
| 5 | Governance & Compliance | `governance` | Policies for data security, privacy, ethical AI use, and risk |
| 6 | Strategic Alignment | `strategic_alignment` | Connection between AI adoption and business goals / leadership commitment |

**Rename map (old → new):**
- Form2 `Data Quality` → `Data Infrastructure`
- Form2 `Tech Stack` → `Technology Stack`
- Form2 `Team Literacy` → `Team Readiness`
- Form2 `Process Docs` → `Process Maturity`
- Form2 `Strategy` → `Strategic Alignment`
- **NEW:** `Governance & Compliance` (did not previously exist in form; referenced in marketing only)

**DB column rename map:**
- `data_quality` → `data_infra`
- `data_accessibility` → DROP (fold into `data_infra`)
- `process_documentation` → `process_maturity`
- `technology_stack` → `tech_stack`
- `team_ai_readiness` → `team_readiness`
- `leadership_commitment` → `strategic_alignment`
- **NEW column:** `governance`

---

## 3. Deliverables (execute in this order)

### D1. DB Schema Migration — `Development/dashboard/server.js`

**Current table** (line ~384):
```sql
CREATE TABLE IF NOT EXISTS ai_readiness_assessments (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id),
  project_id TEXT REFERENCES projects(id),
  assessed_by TEXT REFERENCES team_members(id),
  assessment_date TEXT NOT NULL,
  data_quality INTEGER, data_accessibility INTEGER,
  process_documentation INTEGER, technology_stack INTEGER,
  team_ai_readiness INTEGER, leadership_commitment INTEGER,
  summary TEXT, recommendations TEXT
);
```

**Target table:**
```sql
CREATE TABLE IF NOT EXISTS ai_readiness_assessments (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id),
  project_id TEXT REFERENCES projects(id),
  assessed_by TEXT REFERENCES team_members(id),
  assessment_date TEXT NOT NULL,
  -- 6 canonical dimension scores (1-5 scale, averaged from sub-questions)
  data_infra REAL,
  tech_stack REAL,
  process_maturity REAL,
  team_readiness REAL,
  governance REAL,
  strategic_alignment REAL,
  overall_score REAL,          -- computed average of the 6 above
  readiness_band TEXT,         -- 'Emerging' | 'Developing' | 'Ready' | 'Advanced'
  -- raw sub-question answers as JSON for full audit trail
  responses_json TEXT,
  -- narrative
  primary_outcome TEXT,        -- from Q "single most important outcome"
  timeline_driver TEXT,        -- from Q "specific deadline or event"
  summary TEXT,
  recommendations TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
```

**Migration strategy** (because the seed data re-runs on boot, just update the seed block — no ALTER TABLE needed if DB is dev-local):
1. Update the `CREATE TABLE` statement at line ~384.
2. Update the seed `INSERT` at line ~959 to use new column names. Map existing Magnolia Financial values:
   - `data_quality` and `data_accessibility` values → average → `data_infra`
   - `process_documentation` → `process_maturity`
   - `technology_stack` → `tech_stack`
   - `team_ai_readiness` → `team_readiness`
   - `leadership_commitment` → `strategic_alignment`
   - `governance` → new value, set to `3` (neutral baseline for seed)
3. Because `prism.db` is gitignored and WAL-mode, the safe path is: stop server, delete `prism.db`, restart (schema + seed auto-recreate). Document this in the test steps.

### D2. Expanded Question Bank — 24 questions, 4 per dimension

Replace the ~13 current questions in `Services/Forms/Form2_AI_Readiness_Assessment.html` with the bank below. Same styling/colors/scoring logic, updated markup. Also copy the updated HTML to:
- `Clients/_Client_Template/02_Assessment/Form2_AI_Readiness_Assessment.html`
- Dashboard live form (see D4).

**Question types:**
- `scale` = 1–5 Likert with anchors
- `single` = dropdown, each option scored 1–5
- `multi` = multi-select checkboxes, scored 1–5 based on count/weight
- `text` = free-text (narrative only, not scored)

#### Dimension 1 — Data Infrastructure
1.1 `scale` — How would you rate the overall quality and accuracy of your business data? (anchors: messy & unreliable → clean & consistent)
1.2 `scale` — How accessible is your data when you need to make a decision? (anchors: hunted down manually → instantly available)
1.3 `single` — Where does most of your business data live? (Paper/manual=1, People's heads=1, Excel only=2, Mix of tools=3, Central cloud DB=4, Integrated warehouse=5)
1.4 `scale` — How often do you use data (not gut) to make decisions? (rarely → always)

#### Dimension 2 — Technology Stack
2.1 `scale` — How modern and integrated are your current tools? (outdated/manual → modern/cloud/integrated)
2.2 `multi` — Which of the following does your business use? (Cloud storage, BI/dashboard tool, Automation tools, AI tools, E-commerce w/ analytics, Integrated CRM+marketing, None). Score: 0=1, 1–2=2, 3=3, 4=4, 5+=5
2.3 `single` — How well do your tools share data? (Not at all=1, A little=2, Somewhat=3, Well=4, Fully integrated=5)
2.4 `scale` — How confident are you that your tech stack can support AI integration without major rework? (not at all → fully ready)

#### Dimension 3 — Process Maturity
3.1 `scale` — How well-documented are your key business processes? (in people's heads → fully documented & followed)
3.2 `multi` — Which describe your current processes? (Written SOPs for most tasks=+1, Some but outdated=0, Rely on 1–2 people=−1, Manual weekly tasks=0, Identified automation candidates=+1, No documentation=−2). Compute net, then map to 1–5.
3.3 `single` — What % of weekly tasks are repetitive & manual? (>75%=1, 51–75%=2, 26–50%=3, 10–25%=4, <10%=5)
3.4 `scale` — How consistently are processes followed across your team? (varies by person → strictly followed)

#### Dimension 4 — Team Readiness
4.1 `scale` — How comfortable is your team with AI and data tools? (feels foreign → actively experiments)
4.2 `single` — Has your team received AI/data training in the last 12 months? (None=1, Self-taught=2, 1–2 workshops=3, Formal for some=4, Ongoing program=5)
4.3 `single` — Biggest barrier to team AI adoption? (Don't know where to start=2, Fear of job loss=1, Lack of time=2, Too technical=2, Budget=3, No ROI case=2, Already adopting=5)
4.4 `scale` — How open is leadership + team to changing how work gets done? (resistant → eager)

#### Dimension 5 — Governance & Compliance *(NEW dimension)*
5.1 `single` — Do you have a written policy governing who can use which AI tools? (No & not considering=1, No but discussing=2, Informal only=3, Written policy=4, Written & enforced=5)
5.2 `multi` — Which of these data protections do you have in place? (Access controls/least privilege, Encryption at rest, Encryption in transit, Backup & recovery tested, Data retention policy, Vendor security reviews, None). Score: 0=1, 1=2, 2–3=3, 4–5=4, 6+=5
5.3 `scale` — How confident are you that sensitive data (customer, financial, health) won't leak into public AI tools? (not at all → fully confident)
5.4 `single` — Which compliance regimes apply to your business? (None=N/A scored 3, GDPR=, HIPAA=, PCI-DSS=, SOC 2=, ISO 27001=, Other=). Scoring: if any apply, ask 5.4b "Are your AI/data practices aligned with them?" scale 1–5; if none apply, score 3 (neutral).

#### Dimension 6 — Strategic Alignment
6.1 `scale` — How clearly is AI connected to your overall business strategy? (not part of thinking → central to growth)
6.2 `single` — Leadership's attitude toward AI? (Skeptical=1, Cautious=2, Interested=3, Committed=4, Fully invested=5)
6.3 `text` — **not scored** — What's the single most important business outcome you want AI to help achieve? (stored as `primary_outcome`)
6.4 `text` — **not scored** — Is there a specific deadline or business event driving your AI timeline? (stored as `timeline_driver`)

**Dimension score** = average of the 4 sub-scores (text questions excluded).
**Overall score** = average of the 6 dimension scores, rounded to 1 decimal.

### D3. Scoring Rubric & Banded Interpretation

Place this scoring module in a new file: `Development/dashboard/lib/readiness-scoring.js`.

```js
// readiness-scoring.js
// Input: { responses: { "1.1": 4, "1.2": 3, "1.3": "Central cloud DB", ... } }
// Output: { dimensions: {data_infra: 3.5, ...}, overall: 3.4, band: 'Developing' }

const SCALE_OPTIONS = {
  "1.3": { "Paper / manual records": 1, "People's heads / not documented": 1,
           "Excel / Google Sheets": 2, "Mix of tools": 3,
           "Central cloud database": 4, "Integrated warehouse": 5 },
  // ... one entry per `single`-type question
};

const MULTI_SCORING = {
  "2.2": (selected) => {
    if (selected.includes("None of the above")) return 1;
    const c = selected.length;
    return c >= 5 ? 5 : c >= 4 ? 4 : c === 3 ? 3 : c >= 1 ? 2 : 1;
  },
  // ... one per `multi`-type question
};

const DIMENSION_QUESTIONS = {
  data_infra:         ["1.1", "1.2", "1.3", "1.4"],
  tech_stack:         ["2.1", "2.2", "2.3", "2.4"],
  process_maturity:   ["3.1", "3.2", "3.3", "3.4"],
  team_readiness:     ["4.1", "4.2", "4.3", "4.4"],
  governance:         ["5.1", "5.2", "5.3", "5.4"],
  strategic_alignment:["6.1", "6.2"]  // 6.3 & 6.4 are narrative
};

function bandFor(overall) {
  if (overall >= 4.3) return "Advanced";    // Ready to scale AI across the business
  if (overall >= 3.3) return "Ready";       // Ready for a focused AI pilot
  if (overall >= 2.3) return "Developing";  // Foundation gaps to close first
  return "Emerging";                         // Pre-AI work needed before tools
}

function score(responses) { /* ... */ }
module.exports = { score, bandFor, DIMENSION_QUESTIONS };
```

**Band definitions** (use these verbatim in the debrief doc too):
- **Emerging (1.0–2.2):** Foundational data and process work needed before AI delivers ROI. Focus on getting data out of spreadsheets and heads, documenting top 3 workflows.
- **Developing (2.3–3.2):** Clear pockets of readiness, but integration + governance gaps will limit AI impact. Best fit: one targeted pilot in the strongest dimension.
- **Ready (3.3–4.2):** Infrastructure and team can support a meaningful AI initiative. Prioritize governance/guardrails and pick a high-leverage use case.
- **Advanced (4.3–5.0):** Organization can scale AI across multiple functions. Focus on measurement, competitive differentiation, and ethical AI practices.

### D4. API Endpoints — add to `Development/dashboard/server.js`

Add after existing `/api/services` route block (~line 2690). All routes require the standard auth middleware already applied at line 174.

```js
// POST /api/assessments — submit a new assessment
// Body: { client_id, project_id?, assessed_by?, responses: {...} }
app.post('/api/assessments', express.json(), (req, res) => {
  const { client_id, project_id, assessed_by, responses } = req.body;
  if (!client_id || !responses) return res.status(400).json({ ok: false, error: 'client_id and responses required' });
  const { dimensions, overall, band } = require('./lib/readiness-scoring').score(responses);
  const id = crypto.randomUUID();
  const now = new Date().toISOString().slice(0,10);
  db.prepare(`INSERT INTO ai_readiness_assessments
    (id, client_id, project_id, assessed_by, assessment_date,
     data_infra, tech_stack, process_maturity, team_readiness, governance, strategic_alignment,
     overall_score, readiness_band, responses_json,
     primary_outcome, timeline_driver)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, client_id, project_id || null, assessed_by || null, now,
      dimensions.data_infra, dimensions.tech_stack, dimensions.process_maturity,
      dimensions.team_readiness, dimensions.governance, dimensions.strategic_alignment,
      overall, band, JSON.stringify(responses),
      responses["6.3"] || null, responses["6.4"] || null
  );
  res.json({ ok: true, id, dimensions, overall, band });
});

// GET /api/assessments/:clientId — latest assessment for a client
app.get('/api/assessments/:clientId', (req, res) => {
  const row = db.prepare(`SELECT * FROM ai_readiness_assessments
    WHERE client_id = ? ORDER BY assessment_date DESC LIMIT 1`).get(req.params.clientId);
  if (!row) return res.status(404).json({ ok: false, error: 'No assessment found' });
  res.json({ ok: true, assessment: row });
});

// GET /api/assessments — all assessments (admin view)
app.get('/api/assessments', (req, res) => {
  const rows = db.prepare(`SELECT a.*, c.name AS client_name
    FROM ai_readiness_assessments a
    LEFT JOIN clients c ON a.client_id = c.id
    ORDER BY a.assessment_date DESC`).all();
  res.json({ ok: true, assessments: rows });
});
```

### D5. Live Web Form — wire Form2 into the dashboard

Current state: `Development/dashboard/public/prism-ai-readiness-assessment.html` is the **animated infographic**, not a submission surface. Rename it and put the live form in its place.

**Steps:**
1. Rename existing file: `prism-ai-readiness-assessment.html` → `prism-ai-readiness-infographic.html`. Update any references in `index.html` and blog.
2. Create new `Development/dashboard/public/prism-ai-readiness-assessment.html` based on the updated `Services/Forms/Form2_AI_Readiness_Assessment.html`, with these changes:
   - Adds a hidden `client_id` field populated via URL query param (e.g., `?client=<uuid>`).
   - On submit, POSTs JSON to `/api/assessments` instead of the current no-op.
   - On success, fades out the form and renders a results card: 6 dimension bars, overall score, band name, and band narrative (from D3).
   - On fail, shows inline error with email fallback to `michele@prismaianalytics.com`.
3. Add a "Take the Assessment" button to the dashboard nav (`index.html`) that opens the form in a new tab.

**Acceptance:** a submission from the live form creates a row in `ai_readiness_assessments`, and `GET /api/assessments/:clientId` returns it with the correct dimension scores and band.

### D6. Debrief + 90-Day Roadmap Templates

Create two new files in `Clients/_Client_Template/02_Assessment/`:

#### `Debrief_Template.docx`
Structure:
1. Cover page — client name, date, assessor, overall band
2. Executive summary (1 page) — overall score, band, 3 headline findings
3. Radar chart of the 6 dimensions
4. Dimension-by-dimension detail (2 pages) — score, interpretation, 2 strengths, 2 gaps
5. Primary outcome + timeline (from narrative questions)
6. Top 3 recommended next steps, ordered by leverage
7. Appendix — raw responses

Use `docx` skill when building this template.

#### `90_Day_Roadmap_Template.docx`
Structure:
1. Starting band + target band (what "good" looks like in 90 days)
2. Month 1 — foundation work (data hygiene, doc top 3 processes, governance policy draft)
3. Month 2 — pilot selection + kickoff
4. Month 3 — pilot measurement + scale-or-kill decision
5. RACI table for pilot
6. Success metrics per dimension
7. Risk register (draw from Governance dimension answers)

Use `docx` skill when building this template.

### D7. Marketing Copy Reconciliation

**Files to update — swap old dim names for canonical taxonomy, and add Strategic Alignment where missing:**

| File | Action |
|---|---|
| `Marketing/PrismAI_LinkedInPost_01_AIReadiness_20260411.md` | Already uses 5 marketing dims. Add 6th (Strategic Alignment). Update "5 dimensions" → "6 dimensions". |
| `Marketing/PrismAI_Infographic_01_AIReadiness_20260411.png` | Flag for redesign — PNG needs new art with 6 dims. Do NOT auto-generate; list in open tasks. |
| `Marketing/PrismAI_Infographic_01_AIReadiness_animated.html` | Update dimension labels + colors to match. |
| `Marketing/Infographics/prism-ai-readiness-assessment.html` | Same as animated infographic. |
| `prism_website_project/blog/what-is-an-ai-readiness-assessment/index.html` | Update body copy: swap dimension names, add Strategic Alignment, update band labels to Emerging/Developing/Ready/Advanced. |
| `Development/dashboard/dist/blog/what-is-an-ai-readiness-assessment/` | Same changes as website blog. |

**Do not touch:** the filled-out `Clients/Cafe Uvee/02_Assessment/Form2_AI_Readiness_Assessment.docx` — that's a client artifact.

---

## 4. Execution Order for Claude Code

1. Read `Development/dashboard/CLAUDE.md` and `Development/dashboard/server.js` fully before editing.
2. D1 — schema migration in `server.js` + update Magnolia seed row. Verify with `npm run dev` and check server starts clean.
3. D3 — create `lib/readiness-scoring.js` with the full scoring logic.
4. D4 — add three API routes to `server.js`.
5. D2 — update `Services/Forms/Form2_AI_Readiness_Assessment.html` with 24-question bank.
6. D5 — rename existing infographic, create live form at `public/prism-ai-readiness-assessment.html`, add nav link in `index.html`.
7. D6 — generate debrief + roadmap templates (invoke `docx` skill).
8. D7 — string-replace marketing copy updates.
9. Run the testing checklist in §5.
10. Write a summary to `HANDOFF_AI_Readiness_Framework_RESULTS.md` with files changed, line counts, and any open items.

## 5. Testing Checklist

- [ ] `npm run dev` boots without errors.
- [ ] `sqlite3 prism.db '.schema ai_readiness_assessments'` shows the new columns.
- [ ] `sqlite3 prism.db 'SELECT * FROM ai_readiness_assessments'` shows the backfilled Magnolia row with non-null `governance` and `overall_score`.
- [ ] `curl -X POST http://localhost:3000/api/assessments -H 'Content-Type: application/json' -d @test-payload.json` returns 200 with `{ ok: true, dimensions, overall, band }`.
- [ ] `curl http://localhost:3000/api/assessments/<client_id>` returns the latest submission.
- [ ] Open `http://localhost:3000/prism-ai-readiness-assessment.html?client=<client_id>`. Fill out, submit. Verify results card renders and `sqlite3` shows the new row.
- [ ] Open `http://localhost:3000/prism-ai-readiness-infographic.html` — old infographic still works.
- [ ] All six dimension labels in the live form, the LinkedIn post, the animated infographic, and the blog match the canonical taxonomy exactly (string diff).
- [ ] `Clients/_Client_Template/02_Assessment/` contains `Debrief_Template.docx` and `90_Day_Roadmap_Template.docx`.

## 6. Explicitly out of scope

- Railway deploy. (Will do manually later.)
- Branded PDF report auto-generation (that's a separate backlog task, 2026-05-15).
- Updating already-filled client assessments (e.g., Cafe Uvee's .docx). Retroactive migration is manual.
- A client-facing progress-save feature. Single-session submission only for this pass.
- SSO / external sharing of the form. Stays behind the dashboard auth.

## 7. Risks / decisions to surface back

- **PNG infographic** (`PrismAI_Infographic_01_AIReadiness_20260411.png`) can't be programmatically updated — needs human/Canva redesign. Flag in results doc.
- **Cafe Uvee's existing assessment** was scored on the 5-dim rubric. If Michele wants to show them the new 6-dim view, a conversion pass is needed (governance score will be null/estimated).
- **Question 5.4** (compliance regimes) has conditional branching — if current HTML form logic can't handle conditionals cleanly, fall back to a single dropdown ("How confident are you that you meet your regulatory obligations?" scale 1–5) and capture which regimes apply in a separate multi-select that isn't scored.

---

*End of handoff.*
