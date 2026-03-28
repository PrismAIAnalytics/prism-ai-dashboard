# ─────────────────────────────────────────────────────────────────────────────
# PRISM AI Analytics Dashboard — Production Dockerfile
# ─────────────────────────────────────────────────────────────────────────────
# Uses multi-stage build to keep the final image small.
# Stage 1 compiles better-sqlite3 native bindings.
# Stage 2 copies only production artifacts.
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: Build ──────────────────────────────────────────────────────────
FROM node:20-slim AS builder

# Install build tools for better-sqlite3 native compilation
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files first (Docker layer caching)
COPY package.json package-lock.json ./

# Install all dependencies (including devDependencies for native builds)
RUN npm ci --ignore-scripts && npm rebuild better-sqlite3

# ── Stage 2: Production ────────────────────────────────────────────────────
FROM node:20-slim

# Create non-root user for security
RUN groupadd -r prism && useradd -r -g prism -m prism

WORKDIR /app

# Copy built node_modules from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy application code
COPY package.json ./
COPY server.js ./
COPY import-excel-crm.js ./
COPY Procfile ./
COPY public/ ./public/

# Create data directory for SQLite with correct permissions
RUN mkdir -p /app/data && chown -R prism:prism /app

# Switch to non-root user
USER prism

# Railway sets PORT automatically; default to 3000 for local Docker use
ENV PORT=3000
ENV NODE_ENV=production

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://localhost:${PORT}/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

EXPOSE ${PORT}

CMD ["node", "server.js"]
