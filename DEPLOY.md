# Deploying Prism AI Dashboard to Railway

This guide walks you through deploying the dashboard so both team members can access it from anywhere.

**Time required:** ~15 minutes
**Cost:** Railway's Hobby plan is $5/month with $5 of free usage included. For two users with light traffic, you'll likely stay within the free tier.

---

## Prerequisites

1. A [GitHub account](https://github.com) (free)
2. A [Railway account](https://railway.app) — sign up with GitHub for easiest setup
3. Git installed on your computer ([download](https://git-scm.com/downloads))

---

## Step 1: Create a GitHub Repository

Open a terminal in your `dashboard/` folder and run:

```bash
git init
git add -A
git commit -m "Initial commit — Prism AI Dashboard v2.0"
```

Then create the repo on GitHub:

```bash
# Option A: Using GitHub CLI (if installed)
gh repo create prism-ai-dashboard --private --source=. --push

# Option B: Manual
# 1. Go to https://github.com/new
# 2. Name it "prism-ai-dashboard", set to Private
# 3. Do NOT initialize with README (you already have code)
# 4. Copy the remote URL and run:
git remote add origin https://github.com/YOUR-USERNAME/prism-ai-dashboard.git
git branch -M main
git push -u origin main
```

---

## Step 2: Deploy on Railway

1. Go to [railway.app](https://railway.app) and log in with GitHub
2. Click **"New Project"**
3. Select **"Deploy from GitHub Repo"**
4. Find and select your `prism-ai-dashboard` repo
5. Railway will detect the `Dockerfile` and start building automatically

---

## Step 3: Set Environment Variables

In your Railway project dashboard:

1. Click on your service
2. Go to the **"Variables"** tab
3. Add these variables:

| Variable | Value | Notes |
|----------|-------|-------|
| `API_KEY` | *(generate a strong key — see below)* | Required for production security |
| `CORS_ORIGIN` | `https://your-app.up.railway.app` | Update after you get your URL |
| `NODE_ENV` | `production` | Already set in Dockerfile, but explicit is better |

**To generate a secure API key**, run this in your terminal:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**Do NOT set `PORT`** — Railway assigns this automatically.

---

## Step 4: Add a Persistent Volume (Important!)

SQLite stores data in a file. Without a volume, your data is lost on every deploy.

1. In your Railway service, go to **"Settings"**
2. Scroll to **"Volumes"**
3. Click **"Add Volume"**
4. Set the mount path to: `/app/data`
5. Click **"Save"**

Then update the database path in `server.js` (line ~87) to use the volume:

```javascript
// Change this:
const db = new Database(path.join(__dirname, 'prism.db'));

// To this:
const DB_PATH = process.env.NODE_ENV === 'production'
  ? '/app/data/prism.db'
  : path.join(__dirname, 'prism.db');
const db = new Database(DB_PATH);
```

Commit and push — Railway will auto-redeploy.

---

## Step 5: Get Your Public URL

1. In Railway, go to your service **"Settings"**
2. Under **"Networking"**, click **"Generate Domain"**
3. You'll get a URL like: `https://prism-ai-dashboard-production.up.railway.app`
4. Go back to **"Variables"** and update `CORS_ORIGIN` to this URL

**Bookmark this URL** — it's your live dashboard!

---

## Step 6: Using the API Key

Once `API_KEY` is set, all `/api/*` endpoints require an `Authorization: Bearer YOUR_KEY` header.

The browser dashboard at the root URL (`/`) still loads normally because it serves static files. However, if you want the frontend to send the API key with requests, you'll need to update the `api()` function in `index.html`:

```javascript
// In index.html, update the api() function:
const API_TOKEN = 'your-key-here'; // Or prompt for it on page load

async function api(path) {
  const r = await fetch(`/api/${path}`, {
    headers: API_TOKEN ? { 'Authorization': `Bearer ${API_TOKEN}` } : {}
  });
  return r.json();
}
```

**For now**, you can leave `API_KEY` empty to keep the dashboard open while you're getting set up. Add it once you're ready to lock things down.

---

## Ongoing: Deploying Updates

Every time you push to `main`, Railway auto-deploys:

```bash
git add -A
git commit -m "Description of changes"
git push
```

Railway will build and deploy in ~60 seconds. You can watch the build logs in the Railway dashboard.

---

## Troubleshooting

**Build fails with "better-sqlite3" error:**
The Dockerfile handles this. If you see native compilation errors, make sure the Dockerfile is being used (check `railway.toml` has `builder = "dockerfile"`).

**Data disappears after deploy:**
You need a persistent volume. See Step 4.

**"Too many requests" error:**
The rate limiter is set to 200 requests per 15 minutes. For two users this is plenty. If you hit it during development, restart the service.

**Can't connect:**
Check that Railway generated a public domain (Step 5) and that the health check passes (visit `https://your-url.up.railway.app/health`).

---

## Local Development

For local development, nothing changes:

```bash
cp .env.example .env    # First time only
npm install             # First time only
npm run dev             # Start at http://localhost:3000
```
