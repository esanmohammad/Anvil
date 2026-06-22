# CLAUDE.md — `@esankhan3/code-search-mcp`

Guidance for Claude Code when working inside `packages/code-search-mcp/`.
The standalone code-search product: standalone CLI + MCP server + indexer
daemon over `@anvil/knowledge-core`. Designed to be useful as a standalone
binary without any Anvil agent stack — see
`docs/CODE-SEARCH-MCP-STANDALONE-PLAN.md` for the layering rules. The
package ships three `bin` entries from one build: `code-search-mcp` (legacy
MCP entry), `code-search` (the CLI router), `code-search-daemon` (long-
running indexer).

## What this package owns

### Three bin entries (one build, three roles)

`package.json:bin`:
- `code-search-mcp` → `dist/index.js` — original MCP entry; modes below.
- `code-search` → `dist/cli/index.js` — standalone CLI router (P5).
- `code-search-daemon` → `dist/daemon/index.js` — long-running indexer (P4).

### Four operating modes (`code-search-mcp` argv)

`src/index.ts` parses argv and dispatches:

- **`--print-config`** — prints the resolved `CodeSearchConfig` as JSON
  to stdout (secrets redacted) and exits. Honors every layer of the
  resolver (defaults → file → env → CLI flags). The single debugging
  surface for "is my env var being read?" questions.
- **Remote proxy mode (default)** — `code-search-mcp` or `--remote URL`.
  Spawns a local stdio MCP server that forwards every `tools/list` /
  `tools/call` / `resources/read` to a remote HTTP server. Uses
  `CODE_SEARCH_SERVER` + `CODE_SEARCH_API_KEY`. No local repos, no
  index, no embeddings needed.
- **Local mode** — `--local <path>` or `--local github:org/pattern`.
  Discovers repos under a path (or clones a GitHub org), builds the
  index, then serves over stdio.
- **Serve mode** — `--serve [--port] [--auth] [--transport]`. Starts an
  HTTP server (Streamable HTTP, default; SSE optional) with `/mcp` +
  `/health` + `/ready` + `/version` + `/status` + `/metrics` +
  `/admin/api/status` + `POST /index` endpoints.

### Tools (4 categories, 17 tools total)

All implemented in `src/tools/`:

- **Search** (`search.ts`) — `search_code` (hybrid),
  `search_semantic` (vector-only), `search_exact` (BM25) all call
  `getRetriever(project).retrieve(query, opts)`. `get_code_snippet`
  fetches one entity's source from `chunks.json` directly (embedder-
  independent — works in BM25-only mode).
- **Graph** (`graph.ts`) — `get_repo_graph`, `get_cross_repo_edges`,
  `find_callers`, `find_dependencies`, `impact_analysis`, `trace_path`
  (multi-hop call-chain BFS), `search_graph` (structural query by
  name/type/file, ranked by degree), `find_dead_code` (zero-caller
  entities), `detect_changes` (git diff → affected entities + dependents),
  `get_architecture` (project overview). Read directly from
  `<KB>/system_graph_v2.json` and `<KB>/<repo>/graph.json`. Symbol
  resolution is exact by default via `resolveEntityNodes` (`fuzzy:true`
  for substring).
- **Profiles** (`profile.ts`) — `list_repos`, `get_repo_profile`. Read
  from `<KB>/<repo>/profile.json` via `loadProfile` /
  `loadAllProfiles`.
- **Index** (`index-tools.ts`) — `index_status`. Reads
  `KnowledgeIndexer.getStats(project)`.

### Resources

`src/resources/resources.ts` exposes:

- `code-search://repos` — JSON of all profiles.
- `code-search://system-graph` — `system_graph_v2.json`.
- `code-search://repo/{name}/profile` — single repo profile (dynamic).
- `code-search://repo/{name}/graph` — single repo graph (dynamic).

### Server core

- `src/server.ts:startServer(projectName, dirPath?)` — wires tools +
  resources, calls `autoIndex` if no index found, picks transport
  (stdio or HTTP), schedules optional reindex via
  `CODE_SEARCH_REINDEX_INTERVAL`.
- `src/transports/http-transport.ts:startHttpTransport(opts)` —
  `node:http` server with per-session `StreamableHTTPServerTransport`
  (max 100 sessions, 30 min TTL). Routes: `/health`, `/status`,
  `/index`, `/mcp` (POST/GET/DELETE).
- `src/middleware/auth.ts:createAuthMiddleware(config)` — `none` /
  `api-key` / `jwt` (HS256). In-memory rate limiter (sliding 1 min
  window) keyed by identity subject.
- `src/transports/remote-proxy.ts:startRemoteProxy(config)` — stdio
  MCP server that proxies to a remote `/mcp` endpoint over HTTP.
  Captures `mcp-session-id` header for session continuity. Parses
  `text/event-stream` responses.

### Sources

- `src/sources/local-path.ts:discoverLocalRepos(dirPath)` — same
  heuristic as knowledge-core's `discoverRepos`, kept here for the
  GitHub-org workflow path.
- `src/sources/github-org.ts:cloneOrUpdateOrg(org, opts)` — `gh` CLI
  with GitHub API fallback. Pattern filter (glob), token auth, default
  workspace at `~/.code-search/<org>/`.

### Unified config (P3)

`src/core/config.ts` is the canonical surface for every code-search
setting. Five-layer resolver (lowest → highest precedence):

1. compiled-in `DEFAULTS`
2. `~/.code-search/config.yaml` (user-global)
3. `<workspaceDir>/.code-search.yaml` (per-workspace overlay)
4. `CODE_SEARCH_*` env vars (`envLayer()`)
5. CLI flags via `parseCliFlags(argv)` — `--<dotted-path> <value>`
   (e.g. `--embedding.provider codestral`, `--retrieval.max-chunks 12`,
   `--no-indexing.auto-index`)

Public functions:
- `resolveCodeSearchConfig(opts?)` → fully-resolved `CodeSearchConfig`.
  Also runs `bridgeLegacyEnvVars(cfg)` which writes `ANVIL_LLM_*` from
  `CODE_SEARCH_LLM_*` so agent-core (loaded lazily inside knowledge-core)
  reads the canonical names and doesn't emit `[anvil-llm] DEPRECATED`
  noise. Only writes when canonical is unset, so explicit `ANVIL_*`
  always wins.
- `parseCliFlags(argv)` → `{ patch: DeepPartial<CodeSearchConfig>, rest }`.
  Reserved-flag set (`--local`, `--remote`, `--serve`, `--workspace`, …)
  is forwarded to the caller via `rest`.
- `toKnowledgeConfig(cfg)` → strict `KnowledgeConfig`. Used by `server.ts`
  + `cli/index.ts` to thread the resolved struct into
  `indexFromPath(..., { config })` and `getRetriever(project, config)`.
- `printConfig(cfg)` + `redactSecrets(value)` — for `--print-config`.

`src/core/env-config.ts:loadServerConfig()` is now a **back-compat shim**
over `resolveCodeSearchConfig()`. Returns the legacy flat `ServerConfig`
shape (for `auth.ts`, `http-transport.ts`, etc.) plus `__unified: CodeSearchConfig`.
Cached; use `resetServerConfig()` in tests. The shim still bridges
`EMBEDDING_API_KEY` → provider-specific env vars (`MISTRAL_API_KEY`,
`OPENAI_API_KEY`, `VOYAGE_API_KEY`) and `RERANKER_API_KEY` →
`COHERE_API_KEY` / `VOYAGE_API_KEY` for one release cycle.

### Backends (P4) — search substrate selection

`src/backends/` exposes the `SearchBackend` interface
(`search` / `status` / `forceIndex` / `invalidate` / `close`) and two
implementations:

- `InProcessBackend` (`in-process.ts`) — wraps `getRetriever` +
  `KnowledgeIndexer` directly. Drop-in for the historical
  "just call getRetriever()" path. Threads an explicit `KnowledgeConfig`
  so issue #6 stays fixed regardless of instantiator. Records
  `metrics.queriesTotal` / `queryDuration` / `errors` (P7) on every call.
- `DaemonBackend` (`daemon-client.ts`) — UDS JSON-RPC 2.0 client. One
  socket connection per call (server keeps state). `ping()` returns
  true for a live daemon within ~250ms.

`pickBackend(cfg)` returns daemon if the socket exists AND `preferDaemon`
AND `ping()` succeeds; otherwise falls through to `InProcessBackend`.
`daemonSocketPath(dataDir, project)` resolves to UDS on POSIX
(`<dataDir>/daemon/<project>.sock`) or named pipe on Windows.

### Daemon (P4)

`src/daemon/index.ts` is the long-lived indexer process. Boot:

1. Resolve unified config (with `workspaceDir` overlay).
2. Build/refresh the index for `--workspace <path>`.
3. Start the file watcher (debounced batches).
4. Start the UDS JSON-RPC server (the same protocol `DaemonBackend`
   speaks).
5. Write `<dataDir>/daemon/<project>.pid`; trap SIGINT/SIGTERM.

`src/daemon/watcher.ts:Watcher` — zero-dep `fs.watch` with `recursive:
true` on darwin/win32; per-directory walk on linux. Coalesces fs events
into debounced batches (default `indexing.debounceMs=500`). Honors
`indexing.ignorePatterns` (`node_modules`, `.git`, `dist`, ...).

`src/daemon/rpc-server.ts:RpcServer` — JSON-RPC 2.0 method set:
`search.code` / `index.status` / `index.force` / `index.invalidate` /
`health`. Strict 1.0 contract — both client and server must bump
together when adding methods.

### Standalone CLI (P5)

`src/cli/index.ts` — subcommand router for the `code-search` bin.
Subcommands:
- `code-search index [path] [--force]` — one-shot index of a directory.
- `code-search query <text> [--mode hybrid|vector|bm25] [--top-k N]
  [--repo r1 --repo r2] [--format text|json|jsonl] [--project p]`.
  Picks daemon when alive, else in-process.
- `code-search status [--project p]` — JSON status: chunks, repos,
  embedding provider, last-indexed-at, daemon socket + liveness.
- `code-search reset [--project p]` — `rm -rf` the project's KB dir.
- `code-search daemon …` — forwards to `code-search-daemon`.
- `code-search serve …` / `code-search mcp …` — forward to the original
  `dist/index.js` entry in serve / mcp mode.
- `code-search --print-config` — shared with `code-search-mcp`.

### Observability (P7)

`src/observability/metrics.ts` — zero-dep Prometheus-format collectors:
`Counter`, `Gauge`, `Histogram`. Process-wide `registry` renders the
text body for `/metrics`. Pre-declared `metrics` namespace covers
`code_search_queries_total`, `code_search_query_duration_seconds`,
`code_search_index_chunks_total`, `code_search_index_age_seconds`,
`code_search_embeddings_calls_total`, `code_search_llm_calls_total`,
`code_search_errors_total`, `code_search_reranker_cache_hits_total`.
`InProcessBackend.search` records `queriesTotal` / `queryDuration` /
`errors`; other call sites are wiring points for future work.

`src/observability/logger.ts:Logger` — structured JSON logger
(`{level, msg, ts, …}` per line) when `telemetry.structuredLogs=true`;
falls back to passthrough text mode for the existing stderr-scrape
pattern. `configureLogger(opts)` swaps the process-wide instance.

### Multi-project / multi-tenant (P8)

`src/projects/registry.ts` — file-backed `ProjectRegistry` over
`<dataDir>/projects/<name>/project.yaml`. Each entry carries
`{workspaceDir, repos, scopes, quotas, config}`. Quotas:
`maxQueriesPerMinute` (sliding window per (identity, project)),
`maxEmbeddingCostUsd`, `maxLlmCostUsd`.

- `projectAccessAllowed(project, identityScopes)` — public when
  `project.scopes=[]`, scope-match otherwise, `*` is admin override.
- `checkProjectQuota(project, identity)` — sliding 1-min bucket keyed by
  `(identity, project)`; `maxQueriesPerMinute=0` disables.

Daemon-side wiring (multi-project mode where one daemon serves N
projects) is the next implementation step; the registry + accessors are
ready.

## Build + test

```sh
npm -w @esankhan3/code-search-mcp run build       # node build.mjs (esbuild bundle)
npm -w @esankhan3/code-search-mcp run dev         # tsc -b --watch
node --test packages/code-search-mcp/dist/__tests__/*.test.js
```

Tests at `src/__tests__/`:
- `config-resolver.test.ts` — P3 precedence, secret redaction.
- `daemon-rpc.test.ts` — P4 UDS JSON-RPC roundtrip (skipped on win32).
- `observability.test.ts` — P7 Counter/Gauge/Histogram + Logger.
- `projects.test.ts` — P8 registry, scope auth, quota window.

Build output: bundled `dist/` with three bin entries:
- `dist/index.js` → `code-search-mcp`
- `dist/cli/index.js` → `code-search`
- `dist/daemon/index.js` → `code-search-daemon`

`build.mjs:23` uses `src[\\/]` regex (Windows-safe). Native LanceDB
binding redundancy declared in `optionalDependencies`.

## Conventions

### Comment hygiene — delete stale comments when you touch code

Every comment must be true of the code **as it currently stands**. When a change makes a comment false, irrelevant, or obsolete, update or delete it **in the same edit** — this is not optional.
- Delete references to removed symbols / functions / files (e.g. a comment naming a deleted helper).
- Delete "this used to…", "for now / temporary", "Phase X pending", or "TODO (already done)" narration once it no longer matches reality.
- A comment describing a removed mechanism or a since-completed migration is **worse than no comment** — it actively misleads (humans and agents alike).
- History belongs in commit messages / ADRs, not in code comments. If a comment narrates the past instead of describing the present code, move it or delete it.

### Adding a new tool

1. Add a `register<X>Tools()` exporter that returns an MCP tool
   descriptor `{ name, description, inputSchema }[]`.
2. Add a `handle<X>Tool(name, args, ctx)` that returns
   `{ content: [{ type: 'text', text }] } | null` (null = "not my
   tool, try the next handler").
3. Wire both into `src/server.ts:createMcpServerInstance` —
   `allTools.push` for listing and a sequential `if` chain for
   dispatch.

### Auth on admin endpoints

`POST /index` and `/mcp` both go through `authenticate(req, res)` when
`config.authEnabled === true`. `/health` and `/status` are always
public (read-only). The `/index` handler also goes through `onIndex`
in `server.ts`, which gates against concurrent indexing via
`ctx.indexing.status === 'indexing'`.

### Status tracking

Every index call goes through `trackedIndex(ctx, project, dirPath, opts)`
which:

1. Sets `ctx.indexing.status = 'indexing'`, pushes a `start` history entry.
2. Calls `indexFromPath(project, dirPath, { onProgress, onDetailedProgress })`.
3. On success: `lastSuccess`, `lastDurationMs`, push `complete` entry.
4. On error: `error` field set, push `error` entry, rethrow.

History capped at 50 entries (FIFO). Available via `GET /status`.

### Auto-reindex schedule

`CODE_SEARCH_REINDEX_INTERVAL` accepts `30m` / `1h` / `6h` / `0` (off).
Parsed by `parseReindexInterval()`. Skips when
`indexing.status === 'indexing'` to prevent overlap. Uses
`setInterval(..).unref()` so the timer doesn't keep the process alive.

### Security defaults

- Default `host` is `127.0.0.1` when `authMode === 'none'`, else
  `0.0.0.0`. Public binding without auth logs a stderr warning.
- API keys compared via `timingSafeEqual` (`safeCompare`).
- JWT: HS256 only, signature + `exp` + `iss` validated.

## Things that don't exist (intentionally)

- No vendor LLM SDK — anything LLM-driven (repo profiling, service
  mesh inference) goes through `@anvil/knowledge-core`'s
  `claude-runner.ts` shim → `@anvil/agent-core`'s single-shot.
- No persistent session store. HTTP sessions are in-memory; restart
  drops them. Remote-proxy clients re-init on first request.
- No web framework — `http-transport.ts` is hand-rolled `node:http`
  with a single dispatch function so zero-runtime-dep stays a goal.
- No chokidar / native file-watcher dep — the daemon uses Node's
  built-in `fs.watch` with platform-specific recursive support.
  Future robustness upgrade can swap `daemon/watcher.ts` without
  touching callers.

## Where to look first

- New CLI flag (root)? `src/index.ts` argv loop (top of file).
- New subcommand? `src/cli/index.ts:main` switch — pattern is
  `cmd<X>(rest: string[])`.
- New tool? Pick the right `tools/<x>.ts` file; pattern is
  `register<X>Tools()` + `handle<X>Tool(name, args, ctx)`.
- HTTP route? `src/transports/http-transport.ts` — single dispatch
  function inside `createServer`.
- New backend impl? `src/backends/types.ts` defines `SearchBackend`;
  add the class, wire it into `pickBackend(cfg)`.
- New RPC method? Bump both `src/daemon/rpc-server.ts:RpcHandlers` AND
  `src/backends/daemon-client.ts` together — the contract is strict.
- Auth behavior? `src/middleware/auth.ts:createAuthMiddleware` — one
  function, three branches (`none` / `api-key` / `jwt`).
- Env var resolution / unified config? `src/core/config.ts:
  resolveCodeSearchConfig` (P3). Legacy flat shape via
  `src/core/env-config.ts:loadServerConfig`.
- New metric? `src/observability/metrics.ts:metrics` namespace; declare
  + use directly (registry is process-wide).
- Per-project quota / scope? `src/projects/registry.ts`.

## Architecture + flow docs

- `ARCHITECTURE.md` — module map, mode dispatch, HTTP routes, tool
  surface, session lifecycle.
- `FLOW.md` — sequence diagrams: remote-proxy startup, serve-mode
  startup, search call, graph call, admin index, auto-reindex.
