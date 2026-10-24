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

`src/index.ts` splits config flags off with `parseCliFlags` (unknown
flag → exit 2), then dispatches on order-independent mode flags:

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
- **Serve mode** — `--serve [path] [--port] [--auth]` (any order with
  `--local <path>`; project defaults to `default`). Starts an HTTP
  server (Streamable HTTP only — `--transport sse` exits 2) with `/mcp` +
  `/health` + `/ready` + `/version` + `/status` + `/metrics` +
  `/admin/api/status` + `POST /index` endpoints.

### Tools (4 categories, 17 tools total)

All implemented in `src/tools/`:

- **Search** (`search.ts`) — `search_code` (hybrid),
  `search_semantic` (vector-only), `search_exact` (BM25) all call
  `getRetriever(project).retrieve(query, opts)` and record the query
  metrics. `repos` may be an array, one name, or a comma-separated
  string (agents send all three). `search_exact` skips the `ctx.indexReady` gate (BM25 needs no
  embedder). `get_code_snippet` fetches one entity's source from the
  vector store, else `chunks.json` (embedder-independent — works in
  BM25-only mode).
- **Graph** (`graph.ts`) — `get_repo_graph`, `get_cross_repo_edges`,
  `find_callers`, `find_dependencies`, `impact_analysis`, `trace_path`
  (multi-hop call-chain BFS), `search_graph` (structural query by
  name/type/file, ranked by degree), `find_dead_code` (zero-caller
  entities), `detect_changes` (git diff → affected entities + dependents),
  `get_architecture` (project overview). The system-graph tools query
  knowledge-core's `GraphStore` (`getGraphStore` → `system_graph.sqlite`,
  JSON fallback for older indexes); `get_repo_graph` and `find_dead_code`
  read `<KB>/<repo>/graph.json`; `get_architecture` reads
  `PROJECT_GRAPH.json` / `PROJECT_SUMMARY.md` (CLI-generated) and falls back
  to profiles. `find_callers` / `find_dependencies` / `trace_path` follow
  `calls` edges by default; `relations` (`imports`, `uses`, `type-ref`,
  `inherits`, `all`) lists the others, grouped by relation. Symbol
  resolution is exact by default via `store.resolveNodes` (full
  `repo::file::entity` id, label, or `::name` suffix — case-sensitive,
  index-backed; `fuzzy:true` = case-insensitive substring of symbol names).
  `impact_analysis` follows dependents up to `depth` hops; it and
  `detect_changes` mark cross-repo endpoints of the file as
  `[file-level]`. `detect_changes` maps `git diff -U0` hunks onto entity
  line ranges derived from declaration lines at the base commit.
  Multi-hop traversals are bounded (`graph.ts:TraversalBudget`): at most
  `TRAVERSAL_MAX_NODES` (50k) nodes discovered and `TRAVERSAL_BUDGET_MS`
  (1 s) of wall clock per call, neighbours fetched one batched query per
  frontier slice (`store.neighborEdges`). `trace_path` with `to` is a
  bidirectional BFS (expands the smaller frontier); out of budget it answers
  "No path … found within the traversal budget (explored N nodes, depth D
  of M …)", never a bare "No path". `impact_analysis` / `detect_changes`
  count at most 50k dependent edges per hop (`dependents(…, maxRows)`,
  shown as `50000+`) and note a hop the clock cut off.
- **Profiles** (`profile.ts`) — `list_repos`, `get_repo_profile`. Read
  from `<KB>/<repo>/profile.json` via `loadProfile` /
  `loadAllProfiles`.
- **Index** (`index-tools.ts`) — `index_status`. Reads
  `KnowledgeIndexer.getStats(project)`, including the vector-index line
  (type, partitions, training size + rows since, unindexed rows) from the
  writer's `vector_index.json`.
- Every handler validates its arguments against its own `inputSchema`
  (`tools/validate.ts:validateArgs`); bad input and thrown errors return
  `isError: true`.

### Resources

`src/resources/resources.ts` exposes:

- `code-search://repos` — JSON of all profiles.
- `code-search://system-graph` — bounded overview of the merged graph
  (top nodes by degree + cross-repo edges + totals), served from
  `system_graph.sqlite` via `getGraphStore`. Not a full dump —
  that would reintroduce the org-scale OOM; use the graph tools for
  traversal.
- `code-search://repo/{name}/profile` — single repo profile (dynamic).
- `code-search://repo/{name}/graph` — single repo graph (dynamic).

The two dynamic URIs are advertised by `registerResourceTemplates()` on
`resources/templates/list`.

### Server core

- `src/server.ts:startServer(projectName, dirPath?, { force? })` — wires
  tools + resources. stdio: `autoIndex` (build if no index), then
  connect. HTTP: `startHttpTransport` first (port bound, `/ready` 503),
  then `autoIndex`. Schedules the reindex from
  `indexing.reindexIntervalMs` (env / YAML / CLI). The server process is
  itself the writer for its project and searches in-process; it never
  routes to a `code-search-daemon` (only the CLI's `pickBackend` does).
- Cluster mode (`CODE_SEARCH_WORKERS` > 1, HTTP only) — `node:cluster`
  primary + N workers sharing the port. The primary never serves HTTP;
  it is the sole writer (startup index, scheduled reindex, `POST /index`
  forwarded by workers over IPC) and broadcasts a retriever invalidate
  after each index. Workers mirror its indexing state (`csm:state`, so
  `/status` / `/ready` / `/admin/api/status` agree on every worker) and
  ask it for rate-limit / quota decisions (`csm:rate`, one window per
  server). See `ARCHITECTURE.md` §3.2.1.
- `src/transports/http-transport.ts:startHttpTransport(opts)` —
  `node:http` server; `/mcp` is served statelessly by one SDK-v2
  `createMcpHandler` (modern 2026-07-28 era + per-request legacy
  fallback; GET/DELETE answer 405). Routes: `/health`, `/status`,
  `/version`, `/ready`, `/metrics`, `/admin/api/status`, `POST /index`,
  `/mcp`. `/mcp` runs `authorize(identity)` (the P8 entry, below) after
  authentication.
- `src/middleware/auth.ts:createAuthMiddleware(config, { rateLimiter })` —
  `none` / `api-key` / `jwt` (HS256; `exp` required, `nbf` honoured;
  throws at creation for jwt without a secret). Rate limit: sliding 1 min
  window per identity subject (`middleware/rate-limit.ts:SlidingWindow`),
  API-key subject = hash of the full key, 429 + `Retry-After`.
- `src/transports/remote-proxy.ts:startRemoteProxy(config)` — stdio
  MCP server that proxies to a remote (stateless) `/mcp` endpoint over
  HTTP, one POST per call. Parses `text/event-stream` replies event by
  event and picks the message whose id matches; HTTP / JSON-RPC failures
  reach the client as JSON-RPC errors.

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
- `parseCliFlags(argv)` → `{ patch: DeepPartial<CodeSearchConfig>, rest,
  unknown }`. Reserved-flag set (`--local`, `--remote`, `--serve`,
  `--workspace`, …) is forwarded to the caller via `rest`; `--port` /
  `--host` / `--transport` / `--auth` map to `server.*` / `auth.mode`;
  flags naming no config leaf land in `unknown` and every caller exits 2.
- `exportDataDir(cfg)` — sets `CODE_SEARCH_DATA_DIR` (knowledge-core's
  only data-dir input) so `storage.dataDir` from YAML / CLI moves the KB.
  The default `storage.dataDir` is knowledge-core's own fallback
  (`~/.anvil/knowledge-base`). Every entry point calls it.
- `parseReindexInterval(raw)` — `0`/`none`, `<n>m`, `<n>h` or ≥ 60000 ms;
  anything else → the resolver warns once and uses 0.
- `toKnowledgeConfig(cfg)` → strict `KnowledgeConfig`. Used by `server.ts`
  + `cli/index.ts` to thread the resolved struct into
  `indexFromPath(..., { config })` and `getRetriever(project, config)`.
- `printConfig(cfg)` + `redactSecrets(value)` — for `--print-config`:
  secret-named keys at any depth, OTEL header values, URI credentials.

`src/core/env-config.ts:loadServerConfig({ cli?, workspaceDir? })` is a
**back-compat shim** over `resolveCodeSearchConfig()`. Returns the legacy
flat `ServerConfig` shape (for `auth.ts`, `http-transport.ts`, etc.) plus
`__unified: CodeSearchConfig`. Cached — `src/index.ts` makes the first
call with the CLI patch; use `resetServerConfig()` in tests. `llmMode`
mirrors agent-core: an explicit `cli` / `api` / `none` wins. The shim still bridges
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
  `forceIndex` / `invalidate` call knowledge-core's `invalidateRetriever`
  so the next search sees the new index.
- `DaemonBackend` (`daemon-client.ts`) — UDS JSON-RPC 2.0 client. One
  socket connection per call (server keeps state). `ping()` returns
  true for a live daemon within ~250ms.

`pickBackend(cfg)` returns daemon if the socket exists AND `preferDaemon`
AND `ping()` succeeds; otherwise falls through to `InProcessBackend`.
Only the CLI (`query`) calls it — the MCP server doesn't.
`daemonSocketPath(dataDir, project)` resolves to UDS on POSIX
(`<dataDir>/daemon/<project>.sock`) or named pipe on Windows.

### Daemon (P4)

`src/daemon/index.ts` is the long-lived indexer process. Boot:

1. Resolve unified config (with `workspaceDir` overlay); project =
   basename of the resolved `--workspace` path.
2. Refuse to start when a daemon already answers on
   `<dataDir>/daemon/<project>.sock`; remove a stale socket.
3. Start the UDS JSON-RPC server (binding the socket is the daemon's
   claim on the project) and write `<dataDir>/daemon/<project>.pid`.
4. Build/refresh the index, then start the file watcher. Every index run
   (initial, watcher batch, `index.force`) goes through one serial queue;
   one run per watcher batch.
5. SIGINT/SIGTERM: remove only its own socket and pid file, exit.

`src/daemon/watcher.ts:Watcher` — zero-dep `fs.watch` with `recursive:
true` on darwin/win32; per-directory walk on linux. Coalesces fs events
into debounced batches (default `indexing.debounceMs=500`). Honors
`indexing.ignorePatterns` (`node_modules`, `.git`, `dist`, ...).

`src/daemon/rpc-server.ts:RpcServer` — JSON-RPC 2.0 method set:
`search.code` / `index.status` / `index.force` / `index.invalidate` /
`health`. Strict 1.0 contract — both client and server must bump
together when adding methods. Dispatches own handler names only;
notifications (no `id`) get no reply; a batch gets one `-32600`.

### Standalone CLI (P5)

`src/cli/index.ts` — subcommand router for the `code-search` bin.
Each subcommand parses its own flags + positionals in any order; unknown
flags and invalid values exit 2; project names go through
`core/project-name.ts:validateProjectName`. Subcommands:
- `code-search index [path] [--force] [--project p]` — one-shot index of
  a directory.
- `code-search query <text> [--mode hybrid|vector|bm25] [--top-k N]
  [--repo r1 --repo r2] [--format text|json|jsonl] [--project p]
  [--no-daemon]`. Picks daemon when it answers a ping, else in-process.
- `code-search status [--project p]` — JSON status: dataDir, kbPath,
  indexed, chunks, repos, embedding provider, last-indexed-at, daemon
  socket + liveness (ping). Never creates dirs for an unindexed project.
- `code-search reset [--project p]` — `rm -rf <dataDir>/<project>` only.
- `code-search daemon …` — runs `code-search-daemon` as a child,
  forwarding SIGINT/SIGTERM/SIGHUP and exiting with its status.
- `code-search serve …` / `code-search mcp …` — run the original
  `dist/index.js` entry in-process in serve mode / stdio local mode
  (`mcp --remote URL` = proxy).
- `code-search --print-config` — shared with `code-search-mcp`.

### Observability (P7)

`src/observability/metrics.ts` — zero-dep Prometheus-format collectors:
`Counter`, `Gauge`, `Histogram`. Process-wide `registry` renders the
text body for `/metrics`. Pre-declared `metrics` namespace:
`code_search_queries_total`, `code_search_query_duration_seconds`,
`code_search_errors_total`, `code_search_index_age_seconds`,
`code_search_index_chunks_total`, `code_search_vector_index_unindexed_rows`,
`code_search_vector_index_growth_ratio`.
`InProcessBackend.search` and the MCP search tools (`tools/search.ts`)
record `queriesTotal` / `queryDuration` / `errors`. The four index gauges
are owned by `server.ts:collectIndexMetrics`, the `collectMetrics` hook
passed to `startHttpTransport`: per scrape it clears them and re-reads the
writer's blobs (`index_stats.json`, `vector_index.json` — in cluster mode
the HTTP workers aren't the writer); index age = seconds since the last
successful index. A failing collector never fails the scrape.

`src/observability/logger.ts:Logger` — structured JSON logger
(`{level, msg, ts, component, …}` per line) when
`telemetry.structuredLogs=true`; otherwise passthrough text
(`[component] msg`, the historical stderr format). The server, daemon
and CLI log through `getComponentLogger(component)` after
`configureLogger` applies the resolved config; lines knowledge-core
prints itself are not wrapped.

### Multi-project / multi-tenant (P8)

`src/projects/registry.ts` — file-backed `ProjectRegistry` over
`<dataDir>/projects/<name>/project.yaml`. Each entry carries
`{workspaceDir, repos, scopes, quotas, config}`.

- `projectAccessAllowed(project, identityScopes)` — public when
  `project.scopes=[]`, scope-match otherwise, `*` is admin override.
- `checkProjectQuota(project, identity)` / `projectQuotaKey` — sliding
  1-min window keyed by `(identity, project)`;
  `maxQueriesPerMinute=0` disables.

Enforced: the HTTP server loads the registry at boot and, when the served
project has an entry, gates every `/mcp` request on its scopes (403) and
query quota (429 + `Retry-After`) — `server.ts:createProjectAuthorizer`.
API keys are admin (`*`); a JWT's scopes are its `scope` claim (none →
no scopes). Not enforced anywhere: `repos`, `maxEmbeddingCostUsd`,
`maxLlmCostUsd`; a `config:` block isn't read (`ProjectEntry.config` is
the workspace's `.code-search.yaml` layer). The daemon and CLI don't
consult the registry.

## Build + test

```sh
npm -w @esankhan3/code-search-mcp run build       # node build.mjs (esbuild bundle)
npm -w @esankhan3/code-search-mcp run dev         # tsc -b --watch
node --test packages/code-search-mcp/dist/__tests__/*.test.js
```

Tests at `src/__tests__/`:
- `config-resolver.test.ts` — P3 precedence, secret redaction.
- `config-cli.test.ts` — CLI flag parsing (aliases, unknown flags),
  redaction, reindex intervals, LLM mode, project names.
- `daemon-rpc.test.ts` — P4 UDS JSON-RPC roundtrip (skipped on win32).
- `daemon-rpc-protocol.test.ts` — own-property dispatch, notifications,
  batch, socket ownership on stop.
- `graph-tools.test.ts` — `trace_path`, `find_callers`, `find_dead_code`,
  `get_architecture`, `get_code_snippet` over the JSON system graph.
- `graph-tools-store.test.ts` — graph tools over the SQLite system graph:
  evidence, workspace edges, symmetric / multi-hop / file-level impact,
  symbol resolution, relations, `search_graph` regex, `get_repo_graph`
  edges, hunk-precise and deleted-file `detect_changes`, `find_dead_code`.
- `graph-traversal.test.ts` — `trace_path` shortest paths vs a plain BFS on
  seeded random graphs (direction, relations, confidence, maxDepth); node
  cap + wall-clock budget on a 63k-node fan-out graph (`trace_path`,
  `impact_analysis` lower-bound counts and cut-off hops).
- `tool-inputs.test.ts` — argument validation (`isError`), descriptors vs
  behaviour, `search_exact` without an embedder, search metrics, hints.
- `http-stateless.test.ts` — stateless `/mcp` serving (no session affinity).
- `http-auth.test.ts` — JWT claims, jwt-without-secret, sliding window,
  per-key limits + `Retry-After`, `/admin/api/status` auth, P8 scopes +
  quota on `/mcp` (spawns the server).
- `metrics-endpoint.test.ts` — `/metrics` awaits `collectMetrics`, renders
  when it throws.
- `metrics-collect.test.ts` — `collectIndexMetrics` gauges.
- `observability.test.ts` — P7 Counter/Gauge/Histogram + Logger.
- `projects.test.ts` — P8 registry, scope auth, quota window.
- End-to-end (spawn the built binaries against a git fixture + a fake
  OpenAI-compatible embedder, helpers in `_harness.ts`, ports
  47380–47399): `server-cli-args.test.ts`, `server-lifecycle.test.ts`,
  `http-index.test.ts` (POST /index + cluster mode), `remote-proxy.test.ts`,
  `daemon-runtime.test.ts`.

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
2. Add a `handle<X>Tool(name, args, ctx)` that returns a `ToolResult`
   (`toolText` / `toolError` from `tools/validate.ts`) or null (= "not
   my tool, try the next handler"). Run `validateArgs(inputSchema, args)`
   first so the descriptor is the contract.
3. Wire both into `src/server.ts:createMcpServerInstance` —
   `allTools.push` for listing and a sequential `if` chain for
   dispatch.

### Auth on admin endpoints

`POST /index`, `/admin/api/status` and `/mcp` go through
`authenticate(req, res)` when `config.authEnabled === true`. `/health`,
`/status`, `/ready`, `/version` and `/metrics` are always public. The
`/index` handler (`server.ts:runAdminIndex`, via `onIndex`) re-indexes
the served project only (another `project` → 400), 409s while an index
runs (`ctx.indexing.status === 'indexing'`), and throws `HttpError` for
the status to answer with; the transport caps the body at 64 KiB (413)
and 400s invalid JSON / a missing `path`.

### Status tracking

Every index call goes through `trackedIndex(ctx, project, dirPath, opts)`
which:

1. Sets `ctx.indexing.status = 'indexing'`, pushes a `start` history entry.
2. Calls `indexFromPath(project, dirPath, { onProgress, onDetailedProgress })`.
3. On success: `lastSuccess`, `lastDurationMs`, push `complete` entry.
4. On error: `error` field set, push `error` entry, rethrow.

History capped at 50 entries (FIFO). Available via `GET /status`.

### Auto-reindex schedule

`indexing.reindexIntervalMs` (`CODE_SEARCH_REINDEX_INTERVAL` /
YAML / `--indexing.reindex-interval-ms`) accepts `30m` / `1h` / `6h` /
`0` (off) or ms ≥ 60000; anything else is reported invalid and disables
it. Normalised by `core/config.ts:parseReindexInterval()`. Skips when
`indexing.status === 'indexing'` to prevent overlap. Uses
`setInterval(..).unref()` so the timer doesn't keep the process alive.

### Security defaults

- Default `host` is `127.0.0.1` when `authMode === 'none'`, else
  `0.0.0.0`. Public binding without auth logs a stderr warning.
- API keys compared via `timingSafeEqual` (`safeCompare`).
- JWT: HS256 only, signature + `iss` + required `exp` + `nbf` validated;
  no secret in jwt mode → the server refuses to start.
- `--print-config` redacts every credential it can recognise (secret-named
  keys, OTEL headers, URI userinfo).

## Things that don't exist (intentionally)

- No vendor LLM SDK — anything LLM-driven (repo profiling, service
  mesh inference) goes through `@anvil/knowledge-core`'s
  `claude-runner.ts` shim → `@anvil/agent-core`'s single-shot.
- No session state at all — every `/mcp` request is an independent
  stateless exchange (SDK v2 / spec 2026-07-28). The remote proxy keeps
  no session either.
- No SSE transport.
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
  surface.
