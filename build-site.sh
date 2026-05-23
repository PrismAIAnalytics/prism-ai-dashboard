#!/bin/bash
# Build combined site: public website + dashboard portal
# Output goes to dist/ for Netlify deploy

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WEBSITE_DIR="$SCRIPT_DIR/../../prism_website_project"
DASHBOARD_DIR="$SCRIPT_DIR/public"
DIST_DIR="$SCRIPT_DIR/dist"

echo "Building combined site..."

# Clean
rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

# Copy public website to root
cp "$WEBSITE_DIR/index.html" "$DIST_DIR/"
cp "$WEBSITE_DIR/PRISM_Logo.png" "$DIST_DIR/" 2>/dev/null || true
cp "$WEBSITE_DIR/Michele Website Photo.png" "$DIST_DIR/" 2>/dev/null || true
cp "$WEBSITE_DIR/iStock-2153051604.mp4" "$DIST_DIR/" 2>/dev/null || true
cp "$WEBSITE_DIR/prism-ai-analytics.html" "$DIST_DIR/" 2>/dev/null || true

# Copy blog
if [ -d "$WEBSITE_DIR/blog" ]; then
  mkdir -p "$DIST_DIR/blog"
  cp -r "$WEBSITE_DIR/blog/"* "$DIST_DIR/blog/" 2>/dev/null || true
  # Remove desktop.ini files
  find "$DIST_DIR/blog" -name "desktop.ini" -delete 2>/dev/null || true
fi

# Copy login page
if [ -d "$WEBSITE_DIR/login" ]; then
  mkdir -p "$DIST_DIR/login"
  cp "$WEBSITE_DIR/login/index.html" "$DIST_DIR/login/"
fi

# Copy dashboard to /portal
mkdir -p "$DIST_DIR/portal"
cp -r "$DASHBOARD_DIR/"* "$DIST_DIR/portal/" 2>/dev/null || true
# Remove desktop.ini from portal
find "$DIST_DIR/portal" -name "desktop.ini" -delete 2>/dev/null || true

# Create _redirects at root (overwrite any from dashboard)
cat > "$DIST_DIR/_redirects" << 'EOF'
/api/* https://dashboard-api-production-dabe.up.railway.app/api/:splat 200!
/health https://dashboard-api-production-dabe.up.railway.app/health 200!
EOF

echo "Build complete: $DIST_DIR"
echo "  / -> public website"
echo "  /portal -> dashboard"
echo "  /blog -> blog"
echo "  /login -> login page"
echo "  /api/* -> Railway backend"
