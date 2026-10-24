# `@esankhan3/code-search-mcp` — Architecture

Reference for what physically lives in `packages/code-search-mcp/src/` and how
the modules wire together. No future-tense roadmap content — only what
compiles today.

## 1. Layered module map

```
                     ┌──────────────────────────────────────┐
                     │ MCP clients: Claude Code / Desktop / │
                     │ Cursor / any MCP-aware tool          │
                     └──────────────────────────────────────┘
                                       │
                              stdio    │   HTTP
                          ┌────────────┴────────────┐
                          ▼                         ▼
              ┌────────────────────────┐  ┌────────────────────────┐
              │ src/index.ts (CLI)     │  │ Remote HTTP server     │
              │  argv → mode dispatch  │  │ (another `code-search- │
              │                        │  │  mcp --serve` instance)│
              │  remote / local / serve│  └────────────────────────┘
              └────────────────────────┘
                  │           │           │
            remote│      local│           │serve
                  ▼           ▼           ▼
       ┌──────────────┐  ┌──────────────────────────────────────┐
       │ remote-proxy │  │ server.ts:startServer                │
       │ (stdio loop  │  │   loadServerConfig                   │
       │  forwards to │  │   stdio: autoIndex → connect         │
       │  /mcp)       │  │   HTTP:  startHttpTransport (bind)   │
       └──────────────┘  │          → autoIndex                 │
                         │   schedule auto-reindex              │
                         └──────────────────────────────────────┘
                                            │
                  ┌─────────────────────────┼─────────────────────┐
                  ▼                         ▼                     ▼
         ┌───────────────────┐  ┌───────────────────┐  ┌───────────────────┐
         │ tools/            │  │ resources/        │  │ middleware/auth   │
         │  search           │  │  resources        │  │ + rate limiter    │
         │  graph            │  │                   │  │                   │
         │  profile          │  │                   │  │                   │
         │  index-tools      │  │                   │  │                   │
         └───────────────────┘  └───────────────────┘  └───────────────────┘
                  │                         │
                  └─────────────┬───────────┘
                                ▼
                ┌─────────────────────────────────────┐
                │ @anvil/knowledge-core               │
                │   getRetriever / KnowledgeIndexer   │
                │   loadProfile / discoverRepos       │
                │   getKnowledgeBasePath              │
                │   indexFromPath                     │
                └─────────────────────────────────────┘
                                │
                                ▼
                 ┌───────────────────────────────┐
                 │ <KB>/<project>/               │
                 │   lancedb/                    │
                 │   system_graph.sqlite         │
                 │   <repo>/graph.json           │
                 │   <repo>/profile.json         │
                 │   <repo>/index_meta.json      │
                 └───────────────────────────────┘
```

## 2. Three operating modes (`src/index.ts`)

The single binary `code-search-mcp` first runs `parseCliFlags(argv)`
(`core/config.ts`), which splits off every config flag — `--<dotted.path>
<value>` plus the `--port` / `--host` / `--transport` / `--auth` shorthands
for `server.port` / `server.host` / `server.transport` / `auth.mode` — and
reports flags that name no config leaf (exit 2). The remaining mode flags are
order-independent and pick `mode: 'remote' | 'local' | 'serve'`:

| Mode | When | What it spawns |
|---|---|---|
| `remote` (default) | `code-search-mcp` (no flags) or `--remote URL` or any `http(s)://...` bare arg | `startRemoteProxy({ serverUrl, apiKey })` — stdio MCP server forwarding to a remote `/mcp` |
| `local` | `--local [path\|github:org[/pattern]]` (or a bare path) | Discovers/clones repos → `startServer(project, dirPath)` over stdio. Project defaults to the source's basename; `--local --project p` with no path serves an existing index |
| `serve` | `--serve [path]`, in any order with `--local <path>` | `startServer(project, dirPath)` over Streamable HTTP. Project defaults to `"default"` |

Mode flags:

```
--remote <url>           Remote server URL (also accepts bare URL arg)
--local [path|github:..] Local source (stdio unless --serve)
--serve [path]           HTTP server mode (Streamable HTTP on /mcp)
--api-key <key>
--project <name>         Validated: one path segment, not daemon/projects
--token <token>          GitHub token
--force                  Re-index at startup even if an index exists
--print-config           Print the resolved config (redacted) and exit
--help / -h
```

There is no SSE transport: `--transport sse` / `CODE_SEARCH_TRANSPORT=sse`
exit 2 with an error. The config layers are resolved once
(`loadServerConfig({ cli, workspaceDir })`, workspace layer = the source
path or the cwd), `exportDataDir` hands `storage.dataDir` to knowledge-core,
and `configureLogger` applies `telemetry.structuredLogs`.

Remote mode env fallback: `CODE_SEARCH_SERVER` /
`CODE_SEARCH_REMOTE_URL`, `CODE_SEARCH_API_KEY` /
`CODE_SEARCH_AUTH_API_KEY`.

GitHub source: `github:<org>[/<pattern>]` clones to
`~/.code-search/<org>/` via `cloneOrUpdateOrg` (gh CLI preferred,
GitHub API fallback).

## 3. Server lifecycle (`src/server.ts`)

### 3.1 `ServerContext`

Shared state across tools and HTTP handlers:

```ts
interface ServerContext {
  projectName: string;
  directoryPath: string | null;
  indexReady: boolean;
  startedAt: number;
  indexing: IndexingState;       // status / phase / message / percent / history(50)
}
```

### 3.2 `startServer(projectName, directoryPath, { force? })`

The server process is the index writer for the project it serves and
searches in-process — it never routes to a running `code-search-daemon`
(only the CLI's `pickBackend` does). Don't run a daemon and a server on the
same project + data dir.

1. `loadServerConfig()` — the cached resolved config.
2. Log resolved LLM mode (`disabled` / `api → ...` / `cli → ...`), which
   honours an explicit `llm.mode` (incl. `none`) the way agent-core does.
3. `autoIndex(ctx)` — if the writer's `index_stats.json` shows a
   finished embed (`embeddingProvider !== 'pending'`), or the legacy local
   layout exists (`lancedb` + `system_graph.sqlite` or
   `system_graph_v2.json`) → `ctx.indexReady = true` (unless `force`).
   Else if `directoryPath` set → `trackedIndex(ctx, ..., { label:
   'auto-index' })`. Else log "tools will return empty results."
   - stdio → `autoIndex`, then `StdioServerTransport` + `server.connect`.
   - HTTP → `startHttpTransport(opts)` first, then `autoIndex`: `/health`
     answers and `/ready` is 503 while the startup index runs.
4. `indexing.reindexIntervalMs > 0` (any config layer) →
   `setInterval(...).unref()` running `trackedIndex(..., { label:
   'auto-reindex' })`, skipped while an index runs.

`collectIndexMetrics(project, config, lastSuccess)` refreshes the index
gauges per `/metrics` scrape (see §4).

### 3.2.1 Cluster mode (`CODE_SEARCH_WORKERS`)

`CODE_SEARCH_WORKERS=N` (2–16) with an HTTP transport turns the process
into a `node:cluster` primary that forks N workers sharing the listen port.

- **Workers** serve HTTP only and never write: `POST /index` is forwarded
  to the primary over IPC (`csm:index` → `csm:index-result`, HTTP status
  preserved). Their `ctx.indexing` / `indexReady` / `directoryPath` mirror
  the primary's (`csm:state`, pushed every 250 ms when changed and on
  worker start), so `/status`, `/ready` and `/admin/api/status` report the
  writer's indexing from any worker. Rate-limit and quota checks go to the
  primary (`csm:rate`), so a limit applies to the whole server, not per
  worker (fallback to the worker's own window if the primary doesn't answer
  in 2 s).
- **The primary** never serves HTTP. It forks the workers, then runs the
  startup `autoIndex`, the reindex schedule and forwarded index requests as
  the sole writer, and broadcasts `csm:invalidate` after each successful
  index so workers drop their cached retrievers. It respawns workers that
  die and forwards SIGINT/SIGTERM to them; a worker whose primary is gone
  exits.

### 3.3 `createMcpServerInstance(ctx)` — per-request MCP wiring

```
const server = new Server({ name: 'code-search-mcp', version: PACKAGE_VERSION },
                          { capabilities: { tools: {}, resources: {} } });
allTools = [...registerSearchTools, ...registerGraphTools,
            ...registerProfileTools, ...registerIndexTools];
server.setRequestHandler('tools/list',     () => ({ tools: allTools }));
server.setRequestHandler('tools/call',     handleSearchTool || handleGraphTool
                                           || handleProfileTool || handleIndexTool
                                           || { error: 'Unknown tool: ...' });
server.setRequestHandler('resources/list', () => ({ resources }));
server.setRequestHandler('resources/templates/list', () => ({ resourceTemplates }));
server.setRequestHandler('resources/read', handleResource);
```

### 3.4 `trackedIndex(ctx, project, dirPath, opts)`

Wraps `indexFromPath` (knowledge-core) with status accounting:

- Sets `indexing.status = 'indexing'`, pushes `start` to history.
- Streams progress via `onProgress` + `onDetailedProgress`
  (updates `phase`, `percent`, `message`).
- On success: `lastSuccess`, `lastDurationMs`, push `complete`.
- On error: `error`, push `error`, rethrow.
- `pushHistory` keeps the last 50 entries (FIFO).

### 3.5 Reindex interval (`core/config.ts:parseReindexInterval`)

`indexing.reindexIntervalMs` from any layer (`CODE_SEARCH_REINDEX_INTERVAL`,
YAML `indexing.reindex_interval_ms`, `--indexing.reindex-interval-ms`) is
normalised by the resolver, so `--print-config` shows what the server runs:

| Value | Result |
|---|---|
| unset / `0` / `none` | `0` (disabled) |
| `30m` / `1h` / `6h` (any `\d+(m\|h)`) | converted to ms |
| a number of ms ≥ 60000 | as is |
| anything else (`90s`, `abc`, < 1 minute) | `0` + one stderr warning ("invalid reindex interval") |

## 4. HTTP transport (`src/transports/http-transport.ts`)

`startHttpTransport(opts)` opens a `node:http` server listening on
`config.port` / `config.host`. Serving is stateless: one
`createMcpHandler` (SDK v2) instance serves every `/mcp` request —
modern (2026-07-28) envelope traffic on a per-request micro-transport,
2025-era clients via the stateless legacy fallback. Each exchange gets
its own `mcpServer = await createMcpServer()`; no session ids, no TTL.
The port is bound before `startHttpTransport` resolves; a listen error
(e.g. `EADDRINUSE`) rejects it.

Routes:

| Method + path | Auth | Handler |
|---|---|---|
| `GET /health` | none | `getHealth()` |
| `GET /status` | none | `getStatus()` (live indexing telemetry) |
| `GET /version` | none | name, version (package.json), node, platform |
| `GET /ready` | none | 200 once `indexReady`, else 503 |
| `GET /metrics` | none | awaits `collectMetrics()`, renders the Prometheus registry |
| `GET /admin/api/status` | yes when `authEnabled` | `getStatus()` + version + uptime |
| `POST /index` | yes when `authEnabled` | body ≤ 64 KiB (else 413) parsed as `{ path, project?, force? }` (invalid JSON / no `path` → 400), then `onIndex(body)`; an `HttpError` thrown by it sets the status |
| `POST /mcp` | yes when `authEnabled`, then `authorize(identity)` | stateless exchange via `createMcpHandler` (both eras) |
| `GET /mcp` / `DELETE /mcp` | yes when `authEnabled` | 405 (legacy session verbs — no sessions exist) |
| anything else | — | 404 |

Every response carries an `X-Request-ID` header (8-char UUID slice).

`POST /index` (`server.ts:runAdminIndex`) re-indexes the served project
only: `project` defaults to it, a different `project` → 400 (the server
never switches projects); a missing `path` dir → 400; an index already
running → 409. On success `path` becomes the project's directory for
scheduled reindexes, and the response's `crossRepoEdges` is read from the
stats rollup (the embed stage's own result doesn't carry it).

`authorize` (`server.ts:createProjectAuthorizer`) applies the P8 registry
entry of the served project, if `<dataDir>/projects/<project>/project.yaml`
exists (read once at boot): identity scopes must match the project's
`scopes` (`projectAccessAllowed`, else 403) and requests per `(identity,
project)` are capped at `quotas.max_queries_per_minute` (sliding window,
429 + `Retry-After`). The entry's `repos`, cost ceilings and any `config:`
block are not enforced.

`/metrics` gauges (`server.ts:collectIndexMetrics`, run per scrape from
the writer's blobs, so cluster workers report the writer's index):
`code_search_index_age_seconds{project}` (seconds since the last
successful index — the newer of the stats rollup's `lastIndexed` and this
process's own last success), `code_search_index_chunks_total{project,repo}`,
and the two `code_search_vector_index_*` gauges. The collector clears these
gauges each scrape, so a vanished blob drops its series.

## 5. Auth middleware (`src/middleware/auth.ts`)

```
createAuthMiddleware(config, { rateLimiter? }) → async authenticate(req, res): AuthIdentity | null
```

Creating it throws for `jwt` mode without `authJwtSecret`, so the server
refuses to start (clear error) instead of answering 500.

Branches on `config.authMode`:

- `'none'` → returns `{ mode: 'anonymous', subject: 'anonymous',
  scopes: ['*'] }` immediately (no rate limit).
- Missing `Authorization: Bearer ...` header → 401.
- `'api-key'` → `safeCompare` (timing-safe `timingSafeEqual`) against
  every entry in `config.authApiKeys`. Subject = `key:<sha256(key)[0:16]>`
  (distinct per full key; the key itself is never logged). Scopes `['*']`.
- `'jwt'` → `verifyJwt(token, secret, issuer)`:
  - HS256 only; signature via `createHmac` + `timingSafeEqual`.
  - `exp` required (a token without it is refused) and must be in the future.
  - `nbf`, when present, must not be in the future.
  - `iss` must equal `config.authJwtIssuer`.
  - Scopes = the space-separated `scope` claim; no claim → no scopes.

Rate limit (`middleware/rate-limit.ts`): a sliding window — a request is
admitted when fewer than `config.rateLimitPerMinute` requests of the same
subject were admitted in the preceding 60 s (timestamp log per key, no
fixed-window boundary burst). 429 responses carry `Retry-After` (seconds
until the oldest admitted request leaves the window). The same
`SlidingWindow` backs the P8 per-(identity, project) quota. In cluster mode
the limiter is the primary's (§3.2.1), so limits are per server.

## 6. Remote proxy (`src/transports/remote-proxy.ts`)

`startRemoteProxy({ serverUrl, apiKey })`:

1. `RemoteConnection` instance pinned to `serverUrl` + `apiKey`.
2. `await remote.health()` — best-effort warm-up; logs warning on
   failure but starts anyway.
3. `await remote.initialize()` — an MCP `initialize` round trip used as a
   startup credentials / reachability check (logged; nothing is retried).
4. Creates a local stdio MCP `Server` forwarding `tools/list`,
   `tools/call` (`{ name, arguments }`), `resources/list`,
   `resources/templates/list`, `resources/read`.
5. `await server.connect(new StdioServerTransport())`.

`RemoteConnection.request(method, params)`:

- `POST <serverUrl>/mcp` with a JSON-RPC body (fresh id per request).
  The remote is stateless — no session header is sent or kept.
- Headers: `Content-Type`, `Accept: application/json,
  text/event-stream`, `Authorization: Bearer <apiKey>` (if set).
- `text/event-stream` bodies are parsed event by event (`data:` lines of
  an event joined) and the message whose `id` matches the request is the
  reply — notifications and other ids are skipped.
- An HTTP error, an unreachable remote, a missing reply, or a JSON-RPC
  `error` reply throws `ProtocolError`, which the local server returns to
  the client as a JSON-RPC error (codes of remote errors are kept).

## 7. Tools (`src/tools/`)

Pattern per file: `register<X>Tools()` + `handle<X>Tool(name, args,
ctx) → result | null`. The `null` return = "not my tool", lets the
server.ts dispatcher try the next handler.

Every handler first runs `validateArgs(inputSchema, args)`
(`tools/validate.ts`) against the tool's own descriptor — required args,
types, enums, integer `minimum` / `maximum`, `minLength` (non-blank
strings) — so the advertised schema and the accepted input can't drift.
A bad argument, or any thrown error, returns `isError: true` with the
reason (`toolError`).

### 7.1 Search (`tools/search.ts`)

| Tool | Mode passed to retriever |
|---|---|
| `search_code` | `'vector+bm25+graph'` (full pipeline) |
| `search_semantic` | `'vector'` (single-source) |
| `search_exact` | `'bm25'` (single-source) |

The three search tools (`query`, `maxResults` ≥ 1, `repos` — an array,
one name, or a comma-separated string, coerced to a list; one naming no
repo is an error):

1. Guard on `ctx.indexReady` — except `search_exact`: BM25 needs no
   embedder, so it serves whatever the index holds.
2. `retriever = await getRetriever(ctx.projectName)` (knowledge-core).
3. `retriever.retrieve(query, { maxChunks: maxResults ?? 10,
   maxTokens: maxResults × 4000, repoFilter: repos, mode })`.
4. Format chunks as markdown with score, source, language fence.
5. Record `metrics.queriesTotal{mode, outcome}`, `queryDuration{mode}`
   and, on failure, `errors{kind: 'search'}` — the same labels
   `InProcessBackend` uses (`mode` = `hybrid` / `vector` / `bm25`).

`get_code_snippet` is the exception — it never embeds, so it works in
BM25-only / lite mode. Parses `id="repo::file::entity"` (or
`repo`/`file`/`entity` fields), looks the entity up in the vector store
(indexed lookup), falls back to streaming `chunks.json`, and returns the
source for that entity.

### 7.2 Graph (`tools/graph.ts`)

The system-graph tools query knowledge-core's `GraphStore`
(`getGraphStore` → `system_graph.sqlite`, JSON fallback for older
indexes) by slice, never loading the whole graph. `store.resolveNodes(name,
repo?, fuzzy?)` resolves a symbol to node keys — exact by default (full key,
`label`, or a `::name` key suffix; case-sensitive, no wildcards; index
lookups on SQLite), so a full
`repo::file::entity` id works; `fuzzy:true` = case-insensitive substring of
symbol labels (files and cross-repo endpoints skipped). Traversal tools take
`relations` (`calls` default; `imports`, `uses`, `type-ref`, `inherits`,
`all`) and pass the edge types to the store, so imports, type references
and inheritance are never reported as calls.

| Tool | Reads | What it computes |
|---|---|---|
| `get_repo_graph` | `<repo>/graph.json` | node / edge counts (edges by type) + first `limit` entities and non-`contains` edges; unknown repo → `isError` |
| `get_cross_repo_edges` | `GraphStore` | `crossRepoEdges(repo?, 50)` — edges between repos plus same-repo `workspace-dep` edges (own section), each with its `evidence`; shared-resource types shown `↔` |
| `find_callers` | `GraphStore` | `resolveNodes` → `callers(keys, 30, types)` grouped by relation; when none, names the other relations present |
| `find_dependencies` | `GraphStore` | same, `dependencies(keys, 30, types)` |
| `impact_analysis` | `GraphStore` | scope = `nodesInFiles(repo, [file], entity?)` (`entity` may be a full id) → `dependents` hop by hop up to `depth` (default 2, max 5; ≤ 1000 edges kept, ≤ 50k counted per hop — `N+` when capped); with `entity`, the file's `external` (cross-repo endpoint) nodes join the scope and their dependents are marked `[file-level]`; no nodes for the file → `isError` |
| `trace_path` | `GraphStore` | level-by-level BFS over `neighborEdges(frontier, direction, types, limit)` (`confidence ≥ 0.7`, unweighted, one query per ≤ 400 keys); with `to`, bidirectional (smaller frontier first) shortest path (≥ 1 hop), else the reachable tree (≤`maxDepth` ≤ 10, cap 50) |
| `search_graph` | `GraphStore` | `searchNodes`: name = case-insensitive regex over symbol labels (invalid → `isError`), type / file / repo filters; rank by non-`contains` degree; top `limit` |
| `find_dead_code` | `<repo>/graph.json` + indexed chunk text | entity nodes (function/method/class/…) with zero non-`contains` in-degree whose name doesn't occur again in their own file (vector store `getChunksByFile`, else `chunks.json`) |
| `detect_changes` | git + `GraphStore` + `<repo>/index_meta.json` | `getAllChanges(repoPath, baseSha)`; added / deleted files → every node; modified files → entities whose range at the base overlaps a `git diff -U0` old-side hunk (ranges run from each entity's declaration line in `git show base:file` to the next declaration; an entity whose declaration isn't found is kept) + module node when a hunk falls outside every range + the file's endpoints (`[file-level]`) → one hop of `dependents` (same caps as `impact_analysis`; skipped, with a note, when the affected nodes alone exceed the budget) |
| `get_architecture` | `PROJECT_GRAPH.json` / `PROJECT_SUMMARY.md` / profiles | renders the CLI-generated project graph; degrades to profiles, then to a "no data" hint |

`dependents` follows edges into the scope plus shared-resource cross-repo
edges (`SYMMETRIC_EDGE_TYPES`: topics, tables, Redis keys, buckets, shared
types / constants / env vars / npm deps) out of it, so both sides of a
shared topic see each other.

Traversal budget (`TraversalBudget` in `tools/graph.ts`): store queries are
synchronous on the event loop, so every multi-hop traversal (`trace_path`,
`impact_analysis` and `detect_changes` hops) stops at 50k discovered nodes
(`TRAVERSAL_MAX_NODES`, which also caps the rows of one neighbour query or
one hop of dependents) or 1 s of wall clock (`TRAVERSAL_BUDGET_MS`, checked
before every query). The answer then says so: `trace_path` reports "found
within the traversal budget (explored N nodes, depth D of M …)" instead of
"No path"; a capped dependents count reads `N+`; a hop cut off by the clock
is named.

Node id convention: `<repo>::<filePath>::<entity>`, class members `<repo>::<filePath>::<Class>.<member>` (matches AST graph
builder's namespacing). `get_architecture` reads `PROJECT_GRAPH.json` /
`PROJECT_SUMMARY.md` through the project's blob store (`getBlobStore`),
not knowledge-core's `ANVIL_HOME`-based loaders.

### 7.3 Profile (`tools/profile.ts`)

| Tool | Source |
|---|---|
| `list_repos` | `loadAllProfiles(project)` (knowledge-core) |
| `get_repo_profile` | `loadProfile(project, repo)` |

`list_repos` falls back to `discoverRepos(directoryPath)` when no
profiles exist (renders `(not yet profiled)` list).

### 7.4 Index (`tools/index-tools.ts`)

| Tool | Source |
|---|---|
| `index_status` | `KnowledgeIndexer.getStats(project)` |

## 8. Resources (`src/resources/resources.ts`)

| URI | Source |
|---|---|
| `code-search://repos` | `loadAllProfiles(project)` JSON |
| `code-search://system-graph` | `GraphStore` — bounded overview (top nodes by degree, cross-repo edges, totals) |
| `code-search://repo/{name}/profile` | dynamic; `loadProfile(project, name)` JSON |
| `code-search://repo/{name}/graph` | dynamic; `<KB>/<repo>/graph.json` |

`registerResources(ctx)` lists the two static URIs (`resources/list`);
`registerResourceTemplates()` advertises the two dynamic ones
(`resources/templates/list`), which `handleResource(uri, ctx)` matches by
regex. Unknown URIs return `text/plain "Unknown resource: <uri>"`.

## 9. Sources (`src/sources/`)

### 9.1 `local-path.ts:discoverLocalRepos(dir)`

- If `<dir>/.git` exists → single repo (`name = basename(dir)`).
- Else scan subdirs (skip `node_modules`, `dist`, `.next`, `build`,
  `__pycache__`, `.venv`, `vendor`, `target`, `.git`, dotfiles); each
  with `.git` becomes a repo entry.
- `detectLanguage`: `go.mod` → `go`, `Cargo.toml` → `rust`, `pom.xml` /
  `build.gradle` → `java`, `composer.json` → `php`, `pyproject.toml` /
  `setup.py` → `python`, `package.json + tsconfig.json` → `typescript`,
  `package.json` → `javascript`, else `unknown`.

(Same logic as `@anvil/knowledge-core`'s `discoverRepos`. Kept here for
the GitHub-org workflow path that doesn't go through knowledge-core's
facade.)

### 9.2 `github-org.ts:cloneOrUpdateOrg(org, opts?)`

- Lists repos via `gh repo list <org> --json` (preferred) or GitHub
  API (fallback when `gh` not on PATH; requires `GITHUB_TOKEN`).
- Pattern filter (glob).
- Clones into `<workspacePath>/<repo-name>` (default
  `~/.code-search/<org>/`); updates existing clones via `git pull`.
- Returns `{ name, path, language }[]` shape compatible with
  `discoverRepos`.

## 10. Config (`src/core/config.ts`, `src/core/env-config.ts`)

`resolveCodeSearchConfig({ cli?, workspaceDir?, configPath? })` merges
`DEFAULTS` → `~/.code-search/config.yaml` → `<workspaceDir>/.code-search.yaml`
→ `CODE_SEARCH_*` env → CLI patch, then: binds `0.0.0.0` when auth is on
and no layer set a host, normalises the reindex interval (§3.5), makes
`storage.dataDir` absolute, and bridges `CODE_SEARCH_LLM_*` → `ANVIL_LLM_*`.
`exportDataDir(cfg)` sets `CODE_SEARCH_DATA_DIR` for knowledge-core (its
only data-dir input); the default `storage.dataDir` is knowledge-core's own
fallback (`$ANVIL_HOME/knowledge-base`, else `~/.anvil/knowledge-base`).
`printConfig` redacts secret-named keys (password / secret / token /
authorization / api key / credential, any depth), every OTEL header value,
and credentials inside URIs (`scheme://user:***@`).

`loadServerConfig({ cli?, workspaceDir? })` (back-compat shim) returns the
flat `ServerConfig` + `__unified`, cached in a module-level `_config` (the
first caller, `src/index.ts`, passes the CLI patch); `resetServerConfig()`
clears it for tests.

`CODE_SEARCH_*` env var surface:

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3100` | parsed int |
| `HOST` | `127.0.0.1` if auth=none else `0.0.0.0` | |
| `TRANSPORT` | `stdio` | `stdio` / `streamable-http` (`--serve` forces the latter; `sse` is an error) |
| `DATA_DIR` | `~/.anvil/knowledge-base` | KB root; daemon sockets / pid files and the P8 registry live under it too |
| `EMBEDDING_PROVIDER` | `auto` | |
| `EMBEDDING_MODEL` | — | |
| `EMBEDDING_DIMENSIONS` | `1024` | |
| `EMBEDDING_API_KEY` | — | bridged below |
| `EMBEDDING_BASE_URL` | — | |
| `OLLAMA_HOST` | `http://localhost:11434` | also exported via `process.env` |
| `RERANKER_PROVIDER` | `ollama` | |
| `RERANKER_MODEL` / `RERANKER_API_KEY` / `RERANKER_BASE_URL` | — | |
| `GITHUB_TOKEN` | falls back to `process.env.GITHUB_TOKEN` | |
| `AUTH_MODE` | `none` | |
| `AUTH_API_KEYS` | `''` | comma-separated, trimmed |
| `AUTH_JWT_SECRET` | — | required for `jwt` mode (startup fails without it) |
| `AUTH_JWT_ISSUER` | `code-search-mcp` | |
| `RATE_LIMIT_PER_MINUTE` | `100` | per identity, sliding window, per server |
| `REINDEX_INTERVAL` | `0` | see §3.5 |
| `STRUCTURED_LOGS` | off | JSON log lines from server, daemon and CLI |
| `DAEMON_DISABLED` | off | CLI `query` never uses a daemon |
| `LLM_MODE` | `none` | `cli` / `api` / `none` |
| `LLM_PROVIDER` | `anthropic` | |
| `LLM_MODEL` | `sonnet` | |
| `LLM_API_KEY` | falls back to `ANTHROPIC_API_KEY` | |
| `LLM_BASE_URL` | — | |
| `CLAUDE_BIN` | `claude` | |
| `WORKERS` | `1` | >1 → cluster mode (§3.2.1) |

`resolveLlmMode(explicit, apiKey)` mirrors agent-core's single-shot (what
indexing actually uses), with `explicit` = `ANVIL_LLM_MODE` (bridged from
`llm.mode`):

1. Explicit `'cli'`/`'api'`/`'none'` wins (`api` without a key → `none`).
2. Otherwise (an unrecognised value): `apiKey` set → `'api'`; `which
   <claudeBin>` succeeds → `'cli'`; else `'none'`.

API-key bridging at load time:

- `EMBEDDING_API_KEY` + provider → `MISTRAL_API_KEY` /
  `OPENAI_API_KEY` / `VOYAGE_API_KEY` (only if not already set).
- `RERANKER_API_KEY` + provider → `COHERE_API_KEY` / `VOYAGE_API_KEY`.
- `OLLAMA_HOST` set on `process.env` for downstream consumers.

### 10.1 Daemon + CLI (`src/daemon/`, `src/cli/`, `src/backends/`)

`code-search-daemon --workspace <path>` — project = basename of the
resolved path (validated like every project name: one path segment, not
`daemon` / `projects`). Boot: resolve config (workspace layer included) →
refuse to start if a daemon already answers `health` on
`<dataDir>/daemon/<project>.sock` (a stale socket is removed) → bind the
RPC socket (its claim on the project) → write `<project>.pid` → initial
index → start the watcher. All index runs (initial, watcher batch,
`index.force`) go through one serial queue; a batch that arrives while a
watcher run is queued folds into it (one run per batch). `InProcessBackend`
calls knowledge-core's `invalidateRetriever` after every index run and
after `index.invalidate`, so the next search sees the new state. On
SIGINT/SIGTERM it removes only its own socket (inode check; it leaves the
handle open rather than unlink a path another daemon took over) and its pid
file (if it still holds its pid).

`RpcServer` dispatches only the handlers' own method names; requests
without an `id` are notifications (run, never answered); a batch array gets
one `-32600` error.

`code-search` (`cli/index.ts`) parses each subcommand's own flags and
positionals in any order (`query --project ws "text"`); unknown flags,
invalid `--format` / `--top-k` / `--mode` exit 2. `query` / `status` resolve
the workspace layer from the cwd, `index` from its path. `query` uses the
daemon when `pickBackend` gets a ping (`--no-daemon` / `daemon.disabled`
skip it); `status` reports `daemonAlive` from a ping and never touches a
project that has no index (`indexed: false`, nothing created); `reset`
deletes only `<dataDir>/<project>` for a valid project name. `code-search
daemon` runs the daemon as a child and forwards SIGINT/SIGTERM/SIGHUP to
it, exiting with its status; `serve` / `mcp` run `src/index.ts` in-process
(`mcp` = `--local`, i.e. stdio over the cwd or a path; `mcp --remote URL`
is the proxy).

## 11. File layout

```
packages/code-search-mcp/
├── package.json
├── tsconfig.json
├── README.md
├── CLAUDE.md
├── ARCHITECTURE.md
├── build.mjs                                ← esbuild bundle script
└── src/
    ├── index.ts                             ← code-search-mcp entry + mode dispatch
    ├── server.ts                            ← startServer + ServerContext + autoIndex + trackedIndex
    │
    ├── core/
    │   ├── config.ts                        ← unified CodeSearchConfig resolver
    │   ├── env-config.ts                    ← loadServerConfig (back-compat shim) + resolveLlmMode
    │   ├── project-name.ts                  ← validateProjectName
    │   └── version.ts                       ← PACKAGE_VERSION (from package.json)
    │
    ├── backends/                            ← SearchBackend: in-process + daemon client
    ├── daemon/                              ← code-search-daemon: watcher + UDS JSON-RPC
    ├── cli/
    │   └── index.ts                         ← code-search subcommands
    ├── observability/                       ← Prometheus metrics + structured logger
    ├── projects/
    │   └── registry.ts                      ← multi-project registry + quotas
    │
    ├── transports/
    │   ├── http-transport.ts                ← Streamable HTTP (stateless)
    │   └── remote-proxy.ts                  ← stdio → /mcp forwarder
    │
    ├── middleware/
    │   ├── auth.ts                          ← none/api-key/jwt + rate limit
    │   └── rate-limit.ts                    ← SlidingWindow + RateLimiter
    │
    ├── tools/
    │   ├── search.ts                        ← search_code / _semantic / _exact / get_code_snippet
    │   ├── graph.ts                         ← 10 graph tools
    │   ├── profile.ts                       ← list_repos / get_repo_profile
    │   ├── index-tools.ts                   ← index_status
    │   └── validate.ts                      ← validateArgs + toolText / toolError
    │
    ├── resources/
    │   └── resources.ts                     ← static + dynamic URIs
    │
    └── sources/
        ├── local-path.ts                    ← discoverLocalRepos
        └── github-org.ts                    ← cloneOrUpdateOrg
```

## 12. Runtime dependencies

From `package.json`:

- `@modelcontextprotocol/server` + `@modelcontextprotocol/node` (^2.0.0) —
  MCP SDK v2 (`createMcpHandler` for stateless HTTP, stdio transport).
- `@esankhan3/anvil-knowledge-core` — chunking, retrieval, indexing,
  repo profiling, graph store. All tools and resources delegate here.
- `@esankhan3/anvil-agent-core` — LLM runner shim used during repo
  profiling and service mesh inference.
- `@lancedb/lancedb-*` native bindings as `optionalDependencies`.

Build: `node build.mjs` bundles three bin targets — `dist/index.js`,
`dist/cli/index.js`, `dist/daemon/index.js`. No `tsc` for shipping;
`tsc -b --watch` in dev only.

## 13. Tests

`src/__tests__/` (`node --test` on the built `dist/__tests__/`): config
resolver + CLI flag parsing, daemon RPC (wire + protocol edges), graph
tools (JSON and SQLite system graph), tool input validation / descriptors /
search metrics, stateless HTTP, `/metrics` endpoint + index collector,
observability, project registry, HTTP auth, plus end-to-end tests that
spawn the built binaries against a git fixture and a fake
OpenAI-compatible embedder (`_harness.ts`): argv handling, server
lifecycle, `POST /index` + cluster mode, remote proxy, daemon runtime.
Retrieval and indexing behaviour is covered by
`@esankhan3/anvil-knowledge-core`'s tests.
