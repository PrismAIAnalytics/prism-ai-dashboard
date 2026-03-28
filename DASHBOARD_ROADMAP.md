# Prism AI Analytics — Dashboard Frontend Roadmap

**Last updated:** March 28, 2026
**Team:** Michele Fisher (business lead), Jr. Engineer (development)
**Stack:** Express.js + better-sqlite3 + Vanilla HTML/CSS/JS (no framework, no bundler)

---

## Current State Summary

The dashboard is a single-page app (`public/index.html`) with 8 nav pages, all backed by a mature Express API (`server.js`, ~1,145 lines, 30+ endpoints). A separate `training.html` page handles the training tracker.

### Page Status

| Page | Nav Link | Data Loading | Create/Edit | Notes |
|------|----------|-------------|-------------|-------|
| Dashboard | ✅ | ✅ KPIs, projects, activity | — | Read-only overview |
| Clients | ✅ | ✅ Table view | ❌ | No add/edit/deactivate |
| Pipeline | ✅ | ✅ Kanban board | ❌ | No drag-and-drop or lead creation |
| Projects | ✅ | ✅ Cards + milestones | ❌ | No project creation or milestone updates |
| Invoices | ✅ | ✅ Table view | ❌ | No invoice creation or payment recording |
| Expenses | ✅ | ✅ Table view | ❌ | No expense entry |
| Time | ✅ | ✅ Table + total | ❌ | No time entry logging |
| Services | ✅ | ✅ Table view | ❌ | No service editing |
| **CRM** | ❌ | — | — | Full CRUD API exists but no frontend page |
| **Training** | ❌ | ✅ (separate file) | ✅ | Lives in `training.html`, not integrated into SPA |

### Backend API Endpoints (already built)

These endpoints are ready and waiting for frontend UI:

**CRM (full CRUD — no frontend yet):**
- `GET /api/crm` — list all CRM customers with filters
- `GET /api/crm/triggers` — pipeline stage definitions + SLAs
- `POST /api/crm/customers` — create new lead/customer
- `PATCH /api/crm/customers/:id` — update fields
- `PATCH /api/crm/customers/:id/status` — move through pipeline
- `DELETE /api/crm/customers/:id` — soft delete
- `GET /api/crm/activity/:id` — activity log per customer
- `POST /api/crm/activity/:id` — log manual activity

**Training (has separate page, not integrated):**
- `GET /api/training/programs` — list programs
- `GET /api/training/programs/:id` — full program with domains/topics
- `GET /api/training/progress/:programId/:memberId` — member progress
- `POST /api/training/progress` — update topic completion
- `GET/POST/DELETE /api/training/notes` — session notes

**Other (read-only endpoints, no write forms):**
- `GET /api/certifications` — certification data (no frontend page)

---

## Phase 1: CRM Page (Priority — Week 1–2)

The CRM module is the most mature backend feature with no frontend. This is the single biggest gap.

### Tasks

1. **Add CRM nav link** in `index.html` under the "Business" section
2. **Build CRM list view** — table showing all customers with columns: Company, Contact, Status, Service, Budget, Lead Source, Last Updated
3. **Add status filter bar** — filter by CRM stage (New Lead, Discovery, Assessment, Proposal, Active Client, etc.)
4. **Build "Add Lead" modal/form** — fields: company name, contact name, email, phone, industry, service interest, budget, lead source, notes
5. **Build customer detail panel** — click a row to expand/slide-in with full details + activity timeline
6. **Add inline status change** — dropdown or button to advance a customer through the 12-stage pipeline
7. **Add activity logging** — form to log calls, emails, meetings, notes against a customer
8. **Add edit capability** — inline editing or edit modal for customer fields

### API endpoints to use
```
GET    /api/crm                      → list + filters
POST   /api/crm/customers            → create
PATCH  /api/crm/customers/:id        → update fields
PATCH  /api/crm/customers/:id/status → change stage
DELETE /api/crm/customers/:id        → deactivate
GET    /api/crm/activity/:id         → load activity log
POST   /api/crm/activity/:id         → log new activity
GET    /api/crm/triggers             → stage definitions for UI labels/colors
```

---

## Phase 2: CRUD Forms for Existing Pages (Week 3–4)

Every page currently displays data but has no way to create or edit records. Add forms page by page.

### 2A. Invoices
- "New Invoice" form: client (dropdown), project (optional), line items, dates, tax rate
- Status update buttons: Draft → Sent → Paid / Overdue
- "Record Payment" action on unpaid invoices
- API: will need new `POST /api/invoices` and `PATCH /api/invoices/:id` endpoints on the backend

### 2B. Expenses
- "Log Expense" form: date, category, vendor, description, amount, recurring toggle
- Edit/delete actions
- API: will need new `POST /api/expenses` and `PATCH /api/expenses/:id` endpoints

### 2C. Time Tracking
- "Log Time" form: date, client (dropdown), project (dropdown), hours, description
- Weekly view or calendar view (stretch goal)
- API: will need new `POST /api/time` endpoint

### 2D. Projects
- "New Project" form: client, service, name, budget, dates, assigned team member
- Milestone management: add/complete/reorder milestones
- Status transitions: Scoping → Active → Completed
- API: will need new `POST /api/projects` and `PATCH /api/projects/:id` endpoints

### 2E. Clients
- "Add Client" form: company name, industry, size, location, notes
- Edit and deactivate actions
- API: Clients are created via CRM, but may need a standalone create endpoint

---

## Phase 3: Charts and Visualizations (Week 5–6)

Add Chart.js (load from CDN — no build step needed) to bring the dashboard to life.

### Dashboard Page Enhancements
- **Revenue trend** — line chart showing monthly invoiced revenue (last 6–12 months)
- **Pipeline funnel** — horizontal bar or funnel showing lead count + value by stage
- **Expense breakdown** — donut chart by category
- **Hours by client** — bar chart showing billable hours distribution

### CRM Page Enhancements
- **Pipeline summary bar** — visual count of leads per stage at the top of CRM page
- **Conversion metrics** — win rate, average deal size, average time in each stage

### How to add Chart.js
```html
<!-- Add to <head> in index.html -->
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js"></script>
```

---

## Phase 4: Integration and Polish (Week 7–8)

### 4A. Integrate Training Page
- Move `training.html` content into the SPA as a new nav section
- Add "Training" link under an "Operations" or "Team" nav section
- Reuse the existing training API endpoints

### 4B. Certifications Page
- `GET /api/certifications` exists but has no frontend
- Simple table or card view showing certification status

### 4C. User Experience Polish
- Loading spinners while fetching data
- Empty states with helpful messages ("No invoices yet — create your first one")
- Toast notifications for successful create/update/delete actions
- Confirm dialogs for destructive actions (delete, deactivate)
- Responsive mobile layout improvements

### 4D. Search and Filtering
- Global search across clients, projects, invoices
- Date range filters on invoices, expenses, time entries
- Sort columns in all tables

---

## Future: Client-Facing Features (Phase 5+)

When ready to build the client-facing side:

- **Client portal** — separate route or subdomain where clients can view their project status, invoices, and documents
- **Authentication** — add user accounts with roles (admin, team member, client) using sessions or JWT
- **Multi-user support** — activity attribution ("Michele created this invoice" vs. "Alex logged this time entry")
- **Email notifications** — invoice reminders, status change alerts
- **File attachments** — attach proposals, contracts, deliverables to projects

---

## Developer Guide: How This Codebase Works

This section is for the jr. engineer joining the project.

### Architecture at a Glance

```
dashboard/
├── server.js              ← ALL backend logic (routes, DB schema, seeds, migrations)
├── public/
│   ├── index.html         ← The entire SPA (HTML + CSS + JS in one file)
│   └── training.html      ← Standalone training tracker page
├── import-excel-crm.js    ← Script to import CRM data from Excel
├── prism.db               ← SQLite database (auto-created on first run)
├── package.json           ← Dependencies (Express, better-sqlite3, etc.)
├── .env.example           ← Environment variable template
├── test.http              ← REST Client test file for VS Code
└── Procfile               ← Railway/Heroku deployment config
```

### How to Run Locally

```bash
# 1. Install dependencies (requires Node 18+)
npm install

# 2. Copy environment file
cp .env.example .env

# 3. Start the server (DB auto-creates and seeds on first run)
npm run dev

# 4. Open http://localhost:3000
```

### How to Add a New Page

Follow this pattern — it's the same for every page:

**Step 1:** Add a nav link in `index.html`:
```html
<a href="#" data-page="mypage" onclick="showPage('mypage', this)">&#9733; My Page</a>
```

**Step 2:** Add the page container:
```html
<div id="page-mypage" class="page">
  <div class="page-header"><h2>My Page</h2><p>Description</p></div>
  <div class="card"><div id="mypage-content"></div></div>
</div>
```

**Step 3:** Add a loader function:
```javascript
loaders.mypage = async () => {
  const data = await api('my-endpoint');
  $('#mypage-content').innerHTML = `...render HTML from data...`;
};
```

That's it. The `showPage()` function handles nav highlighting and calls the loader automatically.

### How to Add a Form (Create/Edit)

```javascript
// 1. Add a button in your page HTML
`<button onclick="showAddForm()">+ Add New</button>`

// 2. Create a modal or inline form
function showAddForm() {
  $('#mypage-content').insertAdjacentHTML('afterbegin', `
    <div id="add-form" class="card" style="border-color:var(--royal)">
      <h3>Add New Item</h3>
      <input id="field1" placeholder="Name" style="...">
      <button onclick="submitForm()">Save</button>
      <button onclick="document.getElementById('add-form').remove()">Cancel</button>
    </div>
  `);
}

// 3. Submit via POST
async function submitForm() {
  const res = await fetch('/api/my-endpoint', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ field1: $('#field1').value })
  });
  const data = await res.json();
  if (data.ok) {
    document.getElementById('add-form').remove();
    loaders.mypage(); // Refresh the page
  }
}
```

### Code Conventions

- **No frameworks** — vanilla JS only. Use `$()` and `$$()` helpers defined at the top of the script.
- **No build step** — everything runs directly in the browser. Load libraries from CDN.
- **`api()` helper** — use `await api('endpoint')` for GET requests. For POST/PATCH/DELETE, use `fetch()` directly.
- **`fmt()` and `fmtDate()`** — use these for currency and date formatting. Don't roll your own.
- **`badge()`** — use this for status pills. CSS classes are auto-generated from the status string.
- **All routes in `server.js`** — don't create new files yet. When it gets unwieldy (1,500+ lines), we'll refactor into route modules.
- **Input validation** — all write endpoints use `express-validator`. Follow the pattern in existing POST/PATCH routes.

### Styling

The CSS uses custom properties (CSS variables) defined in `:root`. Key ones:
- `--bg`, `--card`, `--border` — dark theme backgrounds
- `--green`, `--red`, `--amber`, `--purple` — status colors
- `--navy`, `--royal`, `--blue`, `--sky` — brand colors (Prism AI palette)

Use the existing `.kpi`, `.card`, `.badge-status`, `.scroll-y`, `.grid-2`, and table styles. Don't add new CSS unless you need something genuinely new.

### Testing

There's no test framework set up. For now:
- Use `test.http` in VS Code with the REST Client extension to test API endpoints
- Test the UI manually in the browser
- Check the browser console for errors after making changes

---

## Backend Endpoints Still Needed

These don't exist yet and will need to be added to `server.js` as you build out the CRUD forms:

| Endpoint | Purpose | Phase |
|----------|---------|-------|
| `POST /api/invoices` | Create invoice | 2A |
| `PATCH /api/invoices/:id` | Update invoice status | 2A |
| `POST /api/payments` | Record payment against invoice | 2A |
| `POST /api/expenses` | Log new expense | 2B |
| `PATCH /api/expenses/:id` | Edit expense | 2B |
| `DELETE /api/expenses/:id` | Remove expense | 2B |
| `POST /api/time` | Log time entry | 2C |
| `POST /api/projects` | Create project | 2D |
| `PATCH /api/projects/:id` | Update project | 2D |
| `POST /api/projects/:id/milestones` | Add milestone | 2D |
| `PATCH /api/milestones/:id` | Update milestone status | 2D |

---

*This roadmap is a living document. Update it as phases are completed and priorities shift.*
