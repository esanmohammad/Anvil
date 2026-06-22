# @esankhan3/code-search-mcp

**Your whole codebase, in any MCP client.**

A Model Context Protocol server that wraps `@anvil/knowledge-core`
behind an MCP-compliant tool surface. Point Claude Code, Claude
Desktop, or Cursor at it and your agent gains hybrid search,
caller tracing, and impact analysis across every repo you've
indexed — local or remote.

---

## Why "code search" needs more than grep

MCP gave us a clean way to expose tools to LLM agents. What's
missing is a *good* tool to expose. `grep` over your repo answers
"where is this string." Vector search over your repo answers
"what's semantically near this." Neither answers "who calls this
function and which other repos depend on it."

**code-search-mcp gives agents the answer.** Same hybrid retriever
that powers Anvil's pipelines, exposed through MCP. Agents get
AST-aware chunks, cross-repo graph traversal, and a whole-project
view — without you writing a single tool.

```jsonc
// claude_desktop_config.json
{
  "mcpServers": {
    "code-search": {
      "command": "code-search-mcp",
      "args": ["--local", "/path/to/your/projects"]
    }
  }
}
```

That's the whole setup. Claude Desktop now knows your codebase.

---

## Three bin entries (one install)

The npm package ships three binaries. Pick the one that matches the
job — none of them need a separate install.

| Bin | Use case |
|---|---|
| `code-search-mcp` | The MCP-server entry. Three operating modes below. |
| `code-search` | Standalone CLI: `index` / `query` / `status` / `reset` / `daemon` / `serve` / `mcp`. |
| `code-search-daemon` | Long-running indexer with file-watcher and JSON-RPC socket. |

### Standalone CLI
```sh
code-search index .                                  # index current dir
code-search query "where do we verify JWTs"          # hybrid by default
code-search query "createPet" --mode bm25 --top-k 5  # exact-identifier mode
code-search status --project petshop                 # JSON report
code-search reset --project petshop                  # drop the index
code-search --print-config                           # resolved config (redacted)
```
Every `CodeSearchConfig` leaf is settable as `--<dotted-path>` —
e.g. `--embedding.provider codestral`, `--retrieval.max-chunks 12`,
`--no-indexing.auto-index`.

### Daemon mode (long-running indexer)
```sh
code-search-daemon --workspace /path/to/repos
```
Builds the index once, then watches the workspace and debounce-
reindexes on file events. Listens on a UDS socket at
`<dataDir>/daemon/<project>.sock` (named pipe on Windows). The CLI
and MCP server automatically prefer the daemon when it's alive,
falling back to in-process when it isn't.

### MCP — three modes (`code-search-mcp` argv)

**Remote proxy (default)**
```sh
code-search-mcp                  # default — proxies to remote
code-search-mcp --remote URL
```
Spawns a stdio MCP server that forwards to a remote HTTP server.
Zero local setup, zero local index — perfect for hosted
deployments where the index lives in the cloud and dev machines
stay light. Auth via `CODE_SEARCH_API_KEY`.

**Local**
```sh
code-search-mcp --local /path/to/repos
code-search-mcp --local github:my-org/my-pattern
```
Discovers every repo under a path (or clones a GitHub org), builds
the knowledge base, and serves over stdio. Works fully offline if
your embedder + reranker are local (Ollama).

**Serve**
```sh
code-search-mcp --serve --port 4000 --auth api-key
```
Boots an HTTP server (Streamable HTTP transport, SSE optional)
with `/mcp`, `/health`, `/ready`, `/version`, `/status`,
`/metrics` (Prometheus), `/admin/api/status`, and an admin
`POST /index`. Use this to host one index for a whole team — every
dev points their client at the same URL.

---

## Tool surface

Eleven tools across four categories. Every one of them maps to a
function in `@anvil/knowledge-core` — you're getting the same
retrieval pipeline that powers the Anvil dashboard.

### Search
| Tool | What it does |
|---|---|
| `search_code` | Hybrid retrieval — vector + BM25 + graph + rerank |
| `search_semantic` | Vector-only (paraphrases, intent) |
| `search_exact` | BM25-only (identifiers, error codes) |
| `get_code_snippet` | Fetch the source for one entity by qualified name (cheaper than reading the file) |

### Graph
| Tool | What it does |
|---|---|
| `get_repo_graph` | Single-repo AST graph |
| `get_cross_repo_edges` | Inter-repo edges (Kafka, HTTP, gRPC, shared types, …) |
| `find_callers` | Who calls this function (exact by default; `fuzzy:true` for substring) |
| `find_dependencies` | What this function calls |
| `impact_analysis` | What breaks if this changes |
| `trace_path` | Multi-hop call chain — shortest path between two functions, or the reachable call tree |
| `search_graph` | Structural query — filter entities by name/type/file, ranked by connectivity |
| `find_dead_code` | Entities with no callers (heuristic) |
| `detect_changes` | Map a git diff to affected entities + their dependents |
| `get_architecture` | Project overview — repo roles, key flows, connections |

### Profiles
| Tool | What it does |
|---|---|
| `list_repos` | All indexed repos with profiles |
| `get_repo_profile` | Single repo's tech stack, structure, key entry points |

### Index
| Tool | What it does |
|---|---|
| `index_status` | Last indexed SHA, chunk count, embedding provider |

Plus four MCP resources via `code-search://`:
`repos`, `system-graph`, `repo/{name}/profile`, `repo/{name}/graph`.

---

## What makes the search good

This isn't a thin wrapper. The retrieval pipeline runs:

1. **Vector ⫽ BM25 in parallel** — semantic + lexical recall.
2. **Reciprocal Rank Fusion** — combine without one dominating.
3. **AST tripartite expansion** — pull in callers, callees, type
   refs via the project graph.
4. **Cross-encoder rerank** — Qwen3-Reranker by default; Cohere /
   Voyage / OpenAI-compatible swappable.

A query classifier picks adaptive weights — identifier queries
lean BM25, natural-language leans vector, error codes lean both.
You don't tune anything; the retriever does it per query.

---

## Multi-repo by design

Unlike single-repo code-search MCPs, this one is built for the
real world: a team has *many* repos, and the interesting
questions cross them. Where does this Kafka topic get consumed?
Which services depend on this proto? What service-mesh edges
exist between web and api?

Fourteen cross-repo edge strategies cover shared types, Kafka,
HTTP, gRPC, databases, env vars, npm/workspace deps, k8s,
docker-compose, proto, Redis, S3, and shared constants. Plus an
LLM-inferred semantic edge layer. `find_callers` works *across
repos*. So does `impact_analysis`.

---

## Observability

`code-search-mcp --serve` exposes these endpoints out of the box —
no scrape config or APM agent required.

| Endpoint | Returns |
|---|---|
| `GET /health` | Liveness ping with project + uptime |
| `GET /ready` | `200` only after first index completes |
| `GET /version` | Package + Node + platform |
| `GET /status` | Current indexing phase + last-success history |
| `GET /metrics` | Prometheus text format (queries, latency histogram, chunks, embedding/LLM calls, errors) |
| `GET /admin/api/status` | JSON status dashboard for the admin UI |

Set `CODE_SEARCH_STRUCTURED_LOGS=1` for one-JSON-line-per-event
stderr logs, and `CODE_SEARCH_TELEMETRY_RECORD_QUERIES=1` to opt
into recording query text in spans (off by default — queries are
PII-shaped).

---

## Multi-project / multi-tenant

Drop project entries under `<dataDir>/projects/<name>/project.yaml`:

```yaml
workspace: /Users/me/repos/petshop
scopes: [team-shop]
quotas:
  max_queries_per_minute: 60
  max_embedding_cost_usd: 5
```

`ProjectRegistry` reads them at boot. `projectAccessAllowed`
gates by scope (`*` is admin). `checkProjectQuota` enforces a
sliding 1-minute window per `(identity, project)`.

---

## Server features

### Auth, three flavors
`none` (local-only, default 127.0.0.1 binding), `api-key`
(`Authorization: Bearer ...`, timing-safe compare), `jwt` (HS256,
signature + `exp` + `iss` validated). Public binding without auth
logs a warning, because that's what should happen.

### Rate limiting
In-memory sliding 1-minute window keyed by identity subject. Tune
per-deployment.

### Auto-reindex
`CODE_SEARCH_REINDEX_INTERVAL=30m` (or `1h`, `6h`, `0` to disable)
runs an incremental re-index in the background. Skips itself if a
manual index is already running. The timer is `unref`'d so it
doesn't keep the process alive.

### Status tracking
Every index call lands in a 50-entry FIFO history with start
timestamp, success / error, last duration. Available at
`GET /status`.

### Streamable HTTP sessions
Per-session `StreamableHTTPServerTransport`, max 100 concurrent
sessions, 30 min TTL. The remote proxy captures `mcp-session-id`
for continuity. SSE transport available as a fallback.

### Admin index endpoint
`POST /index` with `{ project, dirPath?, opts? }` triggers a
fresh index. Gated against concurrent runs. Auth-required when
auth is on.

---

## How it fits with the rest of Anvil

```
                    ┌─────────────────────────┐
                    │   MCP client            │
                    │   (Claude Code,         │
                    │    Claude Desktop,      │
                    │    Cursor, …)           │
                    └────────────┬────────────┘
                                 │ stdio / HTTP
                                 ▼
                    ┌─────────────────────────┐
                    │   code-search-mcp       │
                    │   (this package)        │
                    │   tools + resources     │
                    └────────────┬────────────┘
                                 │ wraps
                                 ▼
                    ┌─────────────────────────┐
                    │   @anvil/knowledge-core │
                    │   AST chunks +          │
                    │   project graph +       │
                    │   hybrid retriever      │
                    └────────────┬────────────┘
                                 │ on disk
                                 ▼
                    ~/.anvil/knowledge-base/<project>/
```

Three different fronts, one knowledge stack:

- **The CLI** indexes via `anvil index` and retrieves during
  pipelines.
- **The dashboard** browses the project graph and surfaces
  retrieval results in pipeline UI.
- **code-search-mcp** exposes the same retriever to any MCP
  client.

If you've already indexed a project with `anvil index`, this
server picks it up — same `~/.anvil/knowledge-base/` path, same
LanceDB store, same graph files.

---

## Configuration — defaults → file → env → CLI flags

Single resolver in `src/core/config.ts`. Five precedence layers
(lowest → highest):

1. compiled-in `DEFAULTS`
2. `~/.code-search/config.yaml` (user-global)
3. `<workspaceDir>/.code-search.yaml` (per-workspace overlay)
4. `CODE_SEARCH_*` env vars
5. CLI flags via `--<dotted-path>` (e.g. `--embedding.provider codestral`)

Run `code-search --print-config` or `code-search-mcp --print-config`
any time to see the resolved struct (secrets redacted).

| Var (`CODE_SEARCH_*`) | Effect |
|---|---|
| `SERVER` | Remote URL (proxy mode) |
| `API_KEY` | API key for proxy or serve modes |
| `DATA_DIR` | Override the index storage root |
| `PORT` / `HOST` / `TRANSPORT` | HTTP server bind |
| `AUTH_MODE` / `AUTH_API_KEYS` / `AUTH_JWT_SECRET` | Server auth |
| `REINDEX_INTERVAL` | `30m` / `1h` / `6h` / `0` |
| `EMBEDDING_PROVIDER` | `auto` / `codestral` / `voyage` / `openai` / `ollama` / `openai-compatible` / `custom` / `gemini-oauth` |
| `EMBEDDING_MODEL` / `EMBEDDING_DIMENSIONS` | Model + dims |
| `EMBEDDING_API_KEY` / `EMBEDDING_BASE_URL` | Credentials |
| `OLLAMA_HOST` | Default `http://localhost:11434` |
| `RERANKER_PROVIDER` | `ollama` (default) / `cohere` / `voyage` / `openai-compatible` / `custom` / `none` |
| `RERANKER_MODEL` / `RERANKER_API_KEY` / `RERANKER_BASE_URL` | Reranker config |
| `RETRIEVAL_MAX_CHUNKS` / `RETRIEVAL_MAX_TOKENS` | Retrieval tuning |
| `AUTO_INDEX` | `false` to disable startup auto-index |
| `DAEMON_DISABLED` / `DAEMON_AUTO_SPAWN` | Daemon backend control |
| `LLM_MODE` / `LLM_PROVIDER` / `LLM_MODEL` / `LLM_API_KEY` / `LLM_BASE_URL` | Profiling + service-mesh LLM. Pre-promoted to `ANVIL_LLM_*` so the agent-core integration is silent. |
| `INDEXING_DEBOUNCE_MS` / `CHUNKING_MAX_TOKENS` | Indexer knobs |
| `METRICS_ENABLED` / `STRUCTURED_LOGS` / `TELEMETRY_RECORD_QUERIES` | Observability |

### Per-workspace config

Drop a `.code-search.yaml` at the root of your workspace:

```yaml
embedding:
  provider: codestral
  model: codestral-embed-2505
  dimensions: 1024
reranker:
  provider: ollama
  model: qwen2.5-coder:7b           # the default that actually answers
retrieval:
  max_chunks: 12
  hybrid_weights: { vector: 0.55, bm25: 0.3, graph: 0.15 }
indexing:
  auto_index: true
  debounce_ms: 500
```

CLI flags override env, env overrides this file, this file overrides
the user-global `~/.code-search/config.yaml`, that overrides
`DEFAULTS`.

---

## Philosophy

**Multi-repo or nothing.** Real codebases span repos. Code search
that doesn't is a toy.

**No vendor LLM SDK.** Anything LLM-driven (repo profiling,
semantic edges) routes through `@anvil/agent-core`'s single-shot —
the same router, retries, and cost ledger as the rest of Anvil.

**Three modes, one binary.** Remote proxy for hosted, local for
solo, serve for teams. The dispatcher is `src/index.ts:argv`.

**Stateless sessions.** HTTP sessions are in-memory by design.
Restart drops them; clients re-init on first request. No persistent
session store to maintain.

**Security defaults that don't bite.** Default bind is `127.0.0.1`
when auth is `none`. API keys compared timing-safe. JWT
signature + exp + iss validated. Public binding without auth
logs a warning instead of pretending it's fine.

---

## End-to-end smoke test (T1–T8)

The eight-case smoke that pins the standalone product contract lives
at `scripts/smoke/run-smoke.sh`. It spins up a tiny `pet-shop` git
fixture under `/tmp/cs-smoke/`, then runs:

| # | Verifies |
|---|---|
| **T1** | `--print-config` env + CLI flag layering, redaction |
| **T2** | `code-search index` produces a real Ollama-backed index; no stale legacy-env warning |
| **T3** | `code-search query --mode vector` and `--mode bm25` both return the right file |
| **T4** | `code-search status` reports provider + chunk count |
| **T5** | Issue-#6 reproduction: `CODE_SEARCH_EMBEDDING_PROVIDER=openai` actually constructs the OpenAI embedder (skipped when `OPENAI_API_KEY` is unset) |
| **T6** | Vector-space mismatch guard hard-errors on cross-provider query |
| **T7** | Daemon round-trip: spawn, UDS socket, query through RPC, file-watcher debounce-reindex |
| **T8** | HTTP serve: `/health` `/ready` `/version` `/metrics` `/admin/api/status` all 200; Prom text format |

Run it locally:

```sh
npm -w @esankhan3/code-search-mcp run build      # required first
npm -w @esankhan3/code-search-mcp run smoke      # T1–T8
```

Requirements: Ollama on `$OLLAMA_HOST` (default `localhost:11434`)
with `bge-m3` pulled. Pass `OPENAI_API_KEY=...` to exercise the T5
provider-switch path against the real OpenAI endpoint.

The smoke runs **outside CI** — it requires Ollama + real models —
so it's a hand-rolled local check, not a release gate. The release
workflow does enforce a static guard that every bin entry
(`code-search-mcp` / `code-search` / `code-search-daemon`) is in the
built tarball before publishing.

---

## Status

Stable. The retrieval and graph layers move with
`@anvil/knowledge-core`; the MCP surface is locked. New tools
land additively. P0–P8 of the standalone-product plan
(`docs/CODE-SEARCH-MCP-STANDALONE-PLAN.md`) have landed; F1–F4
follow-up fixes verified by `scripts/smoke/run-smoke.sh`.

---

## Part of [Anvil](../../) — the AI development pipeline.
