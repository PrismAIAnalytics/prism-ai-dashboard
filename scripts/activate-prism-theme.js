/**
 * T-032: activate the Prism Dark theme on every dashboard page by adding
 * class="prism-themed" to <body>, and migrate PNG logo refs to the
 * new SVG. Additive + targeted — never touches unrelated markup.
 * Idempotent: re-running detects existing prism-themed class and skips.
 *
 * Run from repo root:
 *   node scripts/activate-prism-theme.js
 *
 * Safe to delete after T-032 merges. Kept committed for diff auditability.
 */
const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const BODY_RE = /<body(\s[^>]*)?>/;

function activateBody(content) {
  if (/<body[^>]*class="[^"]*\bprism-themed\b/.test(content)) {
    return { content, changed: false, reason: 'already themed' };
  }
  const match = content.match(BODY_RE);
  if (!match) return { content, changed: false, reason: 'no <body> tag' };

  let replacement;
  const existingAttrs = match[1] || '';
  if (!existingAttrs.trim()) {
    replacement = `<body class="prism-themed">`;
  } else if (/class="([^"]*)"/.test(existingAttrs)) {
    replacement = `<body${existingAttrs.replace(
      /class="([^"]*)"/,
      (_, cls) => `class="${cls} prism-themed"`,
    )}>`;
  } else {
    replacement = `<body${existingAttrs} class="prism-themed">`;
  }
  return {
    content: content.replace(BODY_RE, replacement),
    changed: true,
    reason: 'activated',
  };
}

function migrateLogo(content) {
  // Favicon: prism-mark.png stays as-is (it's a 6KB sized favicon — keep
  // until we have an SVG mark variant). Inline <img src="/prism-logo.png">
  // and similar -> /prism-logo.svg. Only replaces references that are
  // clearly the dashboard logo, not arbitrary images.
  let next = content;
  let replaced = 0;
  next = next.replace(/(["'])\/?prism-logo\.png\1/g, (m, q) => {
    replaced += 1;
    return `${q}/prism-logo.svg${q}`;
  });
  return { content: next, replaced };
}

function processFile(filePath) {
  const original = fs.readFileSync(filePath, 'utf8');
  const themed = activateBody(original);
  const withLogo = migrateLogo(themed.content);
  const final = withLogo.content;
  if (final === original) {
    return {
      file: path.basename(filePath),
      themed: themed.reason,
      logo: `${withLogo.replaced} png→svg`,
      changed: false,
    };
  }
  fs.writeFileSync(filePath, final, 'utf8');
  return {
    file: path.basename(filePath),
    themed: themed.reason,
    logo: `${withLogo.replaced} png→svg`,
    changed: true,
  };
}

function main() {
  const files = fs
    .readdirSync(PUBLIC_DIR)
    .filter(f => f.toLowerCase().endsWith('.html'))
    .map(f => path.join(PUBLIC_DIR, f));

  const results = files.map(processFile);
  for (const r of results) {
    const marker = r.changed ? '✓' : ' ';
    console.log(
      `  ${marker} ${r.file.padEnd(45)} body:${r.themed.padEnd(16)} logo:${r.logo}`,
    );
  }
  const activated = results.filter(r => r.themed === 'activated').length;
  const totalLogo = results.reduce(
    (acc, r) => acc + parseInt(r.logo, 10),
    0,
  );
  console.log(
    `\nSummary: ${activated} pages activated, ${totalLogo} logo refs migrated`,
  );
}

main();
