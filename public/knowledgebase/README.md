# Knowledgebase drop folder

Drop new files in this folder and they'll appear in the **Knowledgebase** page on the dashboard.

## What goes here

Anything that should be indexed in the catalog but doesn't live somewhere else already:

| Extension | Becomes | Notes |
|-----------|---------|-------|
| `.pdf`, `.docx`, `.xlsx`, `.zip` | Download | Filename (minus extension) becomes the title |
| `.html` | Infographic / Page | `<title>` tag picked up if present; first `<meta name="description">` becomes the description |
| `.md` | Article | YAML frontmatter (`title`, `date`, `read_time`, `author`, `category`, `series`) is read like blog-sources |
| `.png`, `.jpg`, `.svg` | Image | Filename becomes the title |

## After dropping a file

From `Development/dashboard/`:

```powershell
npm run knowledgebase:rebuild
```

The scanner walks this folder, regenerates `config/knowledgebase-manifest.json`, and the dashboard page reflects it on next load.

## URL

Files dropped here are auto-served by the dashboard's static middleware at `/knowledgebase/<filename>`. The Knowledgebase page links straight to them.

## Visibility

New items default to **non-public** — they show in your admin view (dimmed) but not in the "Public only" filter. Click the ● toggle on a row to promote.

## Topic auto-assignment

Topic is inferred from the filename + title + optional `category` frontmatter, matched against the topic keyword rules in `scripts/rebuild-knowledgebase-manifest.js`. If something lands in **General** by mistake, either rename the file to include a topic keyword (e.g. `compliance`, `readiness`, `cm-ai`, `data`, `governance`) or extend the rule list.
