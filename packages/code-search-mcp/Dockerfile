# ── Stage 1: Build ──────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --production=false 2>/dev/null || npm install

COPY src/ src/
COPY tsconfig.json build.mjs ./
RUN node build.mjs

# ── Stage 2: Runtime ────────────────────────────────────────────────────
FROM node:20-alpine
RUN apk add --no-cache git curl

WORKDIR /app

# Copy built output
COPY --from=builder /app/dist/ dist/

# Copy production dependencies
COPY --from=builder /app/node_modules/ node_modules/
COPY package.json ./

# tree-sitter WASM binaries
COPY --from=builder /app/node_modules/tree-sitter-wasms/ node_modules/tree-sitter-wasms/
COPY --from=builder /app/node_modules/web-tree-sitter/ node_modules/web-tree-sitter/

# LanceDB native bindings
COPY --from=builder /app/node_modules/@lancedb/ node_modules/@lancedb/

# Default: HTTP transport with auth
ENV CODE_SEARCH_TRANSPORT=streamable-http
ENV CODE_SEARCH_PORT=3100
ENV CODE_SEARCH_HOST=0.0.0.0
ENV CODE_SEARCH_AUTH_MODE=api-key
ENV CODE_SEARCH_EMBEDDING_PROVIDER=auto
ENV CODE_SEARCH_DATA_DIR=/data

# Persistent storage
VOLUME /data
VOLUME /repos

EXPOSE 3100

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:3100/health || exit 1

ENTRYPOINT ["node", "dist/index.js"]
