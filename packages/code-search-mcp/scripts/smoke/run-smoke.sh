#!/usr/bin/env bash
# code-search-mcp end-to-end smoke (T1–T8 from the standalone product plan).
#
# Runs the same eight checks we used while landing the P0–P8 work. Requires:
#   - Ollama running on $OLLAMA_HOST (default http://localhost:11434) with
#     `bge-m3` and `qwen2.5-coder:7b` pulled (re-rank step).
#   - The bundle built (`npm -w @esankhan3/code-search-mcp run build`).
#
# Optional envs picked up by individual cases:
#   - OPENAI_API_KEY → T5 OpenAI embedding path
#   - GEMINI_OAUTH_CREDS=~/.gemini/oauth_creds.json → T5b Gemini path
#
# Exit non-zero on the first failure. The script is idempotent: every case
# writes under $TMP/ and cleans up its own state at the start.

set -u
cd "$(dirname "$0")/../.."   # → packages/code-search-mcp

TMP="${TMP:-/tmp/cs-smoke}"
DIST_CLI="$PWD/dist/cli/index.js"
DIST_MCP="$PWD/dist/index.js"
DIST_DAEMON="$PWD/dist/daemon/index.js"

if [[ ! -f "$DIST_CLI" || ! -f "$DIST_MCP" || ! -f "$DIST_DAEMON" ]]; then
  echo "FATAL: dist/ missing — run \`npm -w @esankhan3/code-search-mcp run build\` first" >&2
  exit 64
fi

PASS=0
FAIL=0
SKIP=0

pass() { echo "  ✓ $*"; PASS=$((PASS+1)); }
fail() { echo "  ✗ $*" >&2; FAIL=$((FAIL+1)); }
skip() { echo "  - $* (skipped)";       SKIP=$((SKIP+1)); }
hdr()  { echo; echo "── $* ──"; }

# ── Setup: minimal pet-shop repo ─────────────────────────────────────────────
hdr "Setup"
rm -rf "$TMP"
mkdir -p "$TMP/pet-shop/src" "$TMP/index"
cat > "$TMP/pet-shop/src/auth.ts" <<'EOF'
export function verifyToken(token: string, secret: string): boolean { return token.length > 0 && secret.length > 0; }
export function requireScope(scope: string, scopes: string[]): void { if (!scopes.includes(scope)) throw new Error('forbidden'); }
EOF
cat > "$TMP/pet-shop/src/pets.ts" <<'EOF'
export interface Pet { id: string; name: string; available: boolean }
const pets = new Map<string, Pet>();
export function listAvailablePets(): Pet[] { return [...pets.values()].filter((p) => p.available); }
export function adoptPet(id: string): Pet { const p = pets.get(id); if (!p) throw new Error('not found'); p.available = false; return p; }
EOF
( cd "$TMP/pet-shop" && git init -q && git config user.email t@t.t && git config user.name t && git add -A && git commit -q -m initial ) || { fail "git init"; exit 1; }
pass "pet-shop fixture committed"

# Common envs for the rest of the smoke.
export CODE_SEARCH_DATA_DIR="$TMP/index"
export CODE_SEARCH_EMBEDDING_PROVIDER=ollama
export CODE_SEARCH_EMBEDDING_MODEL=bge-m3
export CODE_SEARCH_EMBEDDING_DIMENSIONS=1024
export CODE_SEARCH_RERANKER_PROVIDER=none
export CODE_SEARCH_LLM_MODE=none
export CODE_SEARCH_DAEMON_DISABLED=1

# ── T1: --print-config ───────────────────────────────────────────────────────
hdr "T1: --print-config"
OUT="$(CODE_SEARCH_EMBEDDING_PROVIDER=ollama node "$DIST_CLI" --print-config --retrieval.max-chunks 12 2>&1)" || { fail "exited non-zero"; }
echo "$OUT" | grep -q '"provider": "ollama"' && pass "env layer applied" || fail "embedding.provider != ollama"
echo "$OUT" | grep -q '"maxChunks": 12'     && pass "CLI flag applied"  || fail "retrieval.maxChunks != 12 (CLI flag override)"

# ── T2: code-search index against real Ollama ───────────────────────────────
hdr "T2: index pet-shop (Ollama bge-m3)"
OUT="$(node "$DIST_CLI" index "$TMP/pet-shop" --project petshop 2>&1)" || { fail "indexer exited non-zero"; echo "$OUT" >&2; }
echo "$OUT" | grep -q '"chunks":' && pass "indexer printed chunks summary" || fail "indexer summary missing"
echo "$OUT" | grep -q 'DEPRECATED: CODE_SEARCH_LLM_MODE' && fail "F1 regression — stale ANVIL_LLM_MODE warning fired" || pass "F1: no stale legacy-env warning"

# ── T3: query (vector + bm25 baseline; reranker disabled) ───────────────────
hdr "T3: code-search query"
OUT="$(node "$DIST_CLI" query "adopt pet" --project petshop --mode vector --top-k 1 --format json 2>&1)" || { fail "vector query failed"; }
echo "$OUT" | grep -q '"filePath": "src/pets.ts"' && pass "vector query surfaced pets.ts" || fail "vector query did not surface pets.ts"
OUT="$(node "$DIST_CLI" query "adoptPet" --project petshop --mode bm25 --top-k 1 --format json 2>&1)" || { fail "bm25 query failed"; }
echo "$OUT" | grep -q '"filePath": "src/pets.ts"' && pass "bm25 query surfaced pets.ts" || fail "bm25 query did not surface pets.ts"

# ── T4: status reports the index ────────────────────────────────────────────
hdr "T4: status"
OUT="$(node "$DIST_CLI" status --project petshop 2>&1)"
echo "$OUT" | grep -q '"embeddingProvider": "ollama"' && pass "embeddingProvider=ollama" || fail "status embeddingProvider mismatch"
echo "$OUT" | grep -q '"totalChunks":'              && pass "totalChunks reported"     || fail "totalChunks missing"

# ── T5: issue #6 — env vars reach the embedder (provider switch) ────────────
hdr "T5: env-vars-reach-embedder (issue #6 reproduction)"
if [[ -n "${OPENAI_API_KEY:-}" ]]; then
  OUT="$(CODE_SEARCH_DATA_DIR="$TMP/index-openai" CODE_SEARCH_EMBEDDING_PROVIDER=openai CODE_SEARCH_EMBEDDING_MODEL=text-embedding-3-small CODE_SEARCH_EMBEDDING_DIMENSIONS=512 CODE_SEARCH_EMBEDDING_API_KEY="$OPENAI_API_KEY" node "$DIST_CLI" index "$TMP/pet-shop" --project petshop-openai 2>&1)"
  # Either embedding succeeds (real key) OR we get OpenAI's auth error
  # (placeholder key). Both prove the env var reached the embedder.
  if echo "$OUT" | grep -qE '("chunks":|api.openai.com|OpenAI embedding request)'; then
    pass "OpenAI embedder constructed + called (env vars threaded through)"
  else
    fail "OpenAI embedder didn't run"; echo "$OUT" | tail -5 >&2
  fi
else
  skip "T5 OpenAI path — set OPENAI_API_KEY to verify"
fi

# ── T6: vector-space mismatch guard ─────────────────────────────────────────
hdr "T6: vector-space mismatch guard"
OUT="$(CODE_SEARCH_EMBEDDING_PROVIDER=openai CODE_SEARCH_EMBEDDING_API_KEY=stub-key node "$DIST_CLI" query "adopt pet" --project petshop --mode vector --top-k 1 --format json 2>&1)" || true
echo "$OUT" | grep -q 'Vector-space mismatch' && pass "guard refused the cross-provider query" || fail "guard did not fire on provider mismatch"

# ── T7: daemon round-trip ───────────────────────────────────────────────────
hdr "T7: daemon round-trip"
unset CODE_SEARCH_DAEMON_DISABLED
DAEMON_LOG="$TMP/daemon.log"
node "$DIST_DAEMON" --workspace "$TMP/pet-shop" > "$DAEMON_LOG" 2>&1 &
DAEMON_PID=$!
sleep 6
if kill -0 "$DAEMON_PID" 2>/dev/null; then
  pass "daemon process alive (pid $DAEMON_PID)"
  SOCKET="$TMP/index/daemon/pet-shop.sock"
  test -S "$SOCKET" && pass "UDS socket present" || fail "socket missing at $SOCKET"
  OUT="$(node "$DIST_CLI" query "adopt pet" --project pet-shop --mode vector --top-k 1 --format json 2>&1)"
  echo "$OUT" | grep -q '"filePath": "src/pets.ts"' && pass "query through daemon succeeded" || fail "daemon-backed query failed"
  echo "// touched $(date)" >> "$TMP/pet-shop/src/pets.ts"
  sleep 3
  grep -q 'reindex queued' "$DAEMON_LOG" && pass "watcher debounce-reindexed on file touch" || fail "watcher didn't fire"
  kill "$DAEMON_PID" 2>/dev/null
  for _ in 1 2 3 4 5; do
    kill -0 "$DAEMON_PID" 2>/dev/null || break
    sleep 1
  done
  kill -9 "$DAEMON_PID" 2>/dev/null || true
  wait "$DAEMON_PID" 2>/dev/null || true
else
  fail "daemon exited prematurely"; tail -10 "$DAEMON_LOG" >&2
fi
export CODE_SEARCH_DAEMON_DISABLED=1

# ── T8: HTTP server endpoints ───────────────────────────────────────────────
hdr "T8: HTTP serve"
PORT=$(( ( RANDOM % 1000 ) + 4100 ))
HTTP_LOG="$TMP/http.log"
CODE_SEARCH_PORT="$PORT" CODE_SEARCH_HOST=127.0.0.1 CODE_SEARCH_TRANSPORT=streamable-http node "$DIST_MCP" --serve --project petshop > "$HTTP_LOG" 2>&1 &
HTTP_PID=$!
sleep 5
if kill -0 "$HTTP_PID" 2>/dev/null; then
  for ep in health ready version metrics admin/api/status; do
    code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/${ep}")"
    if [[ "$code" == "200" ]]; then pass "GET /$ep → 200"; else fail "GET /$ep → $code"; fi
  done
  curl -s "http://127.0.0.1:${PORT}/metrics" | grep -q '^# HELP code_search_queries_total' \
    && pass "/metrics emits Prom text format" || fail "/metrics missing prelude"
  kill "$HTTP_PID" 2>/dev/null
  for _ in 1 2 3 4 5; do
    kill -0 "$HTTP_PID" 2>/dev/null || break
    sleep 1
  done
  kill -9 "$HTTP_PID" 2>/dev/null || true
  wait "$HTTP_PID" 2>/dev/null || true
else
  fail "HTTP server failed to start"; tail -10 "$HTTP_LOG" >&2
fi

# ── Summary ─────────────────────────────────────────────────────────────────
echo
echo "──────────────────────────────────────────"
echo "PASS: $PASS    FAIL: $FAIL    SKIP: $SKIP"
echo "──────────────────────────────────────────"
exit $(( FAIL == 0 ? 0 : 1 ))
