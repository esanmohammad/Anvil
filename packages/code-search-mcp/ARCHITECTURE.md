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
       │  forwards to │  │   autoIndex(ctx)                     │
       │  /mcp)       │  │   transport === 'stdio'              │
       └──────────────┘  │     ? StdioServerTransport           │
                         │     : startHttpTransport(opts)       │
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

The single binary `code-search-mcp` parses argv into `mode: 'remote' |
'local' | 'serve'`:

| Mode | When | What it spawns |
|---|---|---|
| `remote` (default) | `code-search-mcp` (no flags) or `--remote URL` or any `http(s)://...` bare arg | `startRemoteProxy({ serverUrl, apiKey })` — stdio MCP server forwarding to a remote `/mcp` |
| `local` | `--local <path>` or `--local github:org[/pattern]` | Discovers/clones repos → `startServer(project, dirPath)` over stdio |
| `serve` | `--serve` (with `--port`/`--auth`/`--transport`) | `startServer(project, src?)` with HTTP transport |

CLI flags (parsed by argv loop):

```
--remote <url>          Remote server URL (also accepts bare URL arg)
--local [path|github:..] Local source
--serve                 HTTP server mode
--api-key <key>
--project <name>
--token <token>         GitHub token
--force                 Force full re-index
--port <port>
--transport <stdio|sse|streamable-http>
--auth <none|api-key|jwt>
--help / -h
```

Remote mode env fallback: `CODE_SEARCH_SERVER` /
`CODE_SEARCH_REMOTE_URL`, `CODE_SEARCH_API_KEY` /
`CODE_SEARCH_AUTH_API_KEY`.

GitHub source: `--local github:<org>[/<pattern>]` clones to
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

### 3.2 `startServer(projectName, directoryPath)`

1. `loadServerConfig()` — pull every `CODE_SEARCH_*` env var.
2. Log resolved LLM mode (`disabled` / `api → ...` / `cli → ...`).
3. `await autoIndex(ctx)` — if the writer's `index_stats.json` shows a
   finished embed (`embeddingProvider !== 'pending'`), or the legacy local
   layout exists (`lancedb` + `system_graph.sqlite` or
   `system_graph_v2.json`) → `ctx.indexReady = true`. Else if `directoryPath` set →
   `trackedIndex(ctx, ..., { label: 'auto-index' })`. Else log "tools
   will return empty results."
4. Pick transport:
   - `stdio` → `new StdioServerTransport()` + `server.connect`.
   - else → `startHttpTransport(opts)` with `createMcpServer` factory
     producing one Server per request.
5. If `parseReindexInterval() > 0` → `setInterval(...).unref()` running
   `trackedIndex(..., { label: 'auto-reindex' })`.

### 3.3 `createMcpServerInstance(ctx)` — per-request MCP wiring

```
const server = new Server({ name: 'code-search-mcp', version: '0.1.0' },
                          { capabilities: { tools: {}, resources: {} } });
allTools = [...registerSearchTools, ...registerGraphTools,
            ...registerProfileTools, ...registerIndexTools];
server.setRequestHandler('tools/list',     () => ({ tools: allTools }));
server.setRequestHandler('tools/call',     handleSearchTool || handleGraphTool
                                           || handleProfileTool || handleIndexTool
                                           || { error: 'Unknown tool: ...' });
server.setRequestHandler('resources/list', () => ({ resources }));
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

### 3.5 `parseReindexInterval()`

Parses `CODE_SEARCH_REINDEX_INTERVAL`:

| Value | Result |
|---|---|
| unset / `0` / `none` | `0` (disabled) |
| `30m` / `1h` / `6h` (or any `\d+(m\|h)`) | converted to ms |
| anything else | `0` + stderr warning |

## 4. HTTP transport (`src/transports/http-transport.ts`)

`startHttpTransport(opts)` opens a `node:http` server listening on
`config.port` / `config.host`. Serving is stateless: one
`createMcpHandler` (SDK v2) instance serves every `/mcp` request —
modern (2026-07-28) envelope traffic on a per-request micro-transport,
2025-era clients via the stateless legacy fallback. Each exchange gets
its own `mcpServer = await createMcpServer()`; no session ids, no TTL.

Routes:

| Method + path | Auth | Handler |
|---|---|---|
| `GET /health` | none | `getHealth()` |
| `GET /status` | none | `getStatus()` (live indexing telemetry) |
| `GET /version` | none | name, version, node, platform |
| `GET /ready` | none | 200 once `indexReady`, else 503 |
| `GET /metrics` | none | awaits `collectMetrics()`, renders the Prometheus registry |
| `GET /admin/api/status` | none | `getStatus()` + version + uptime |
| `POST /index` | yes when `authEnabled` | parses `{ path, project?, force? }` JSON, calls `onIndex(body)` |
| `POST /mcp` | yes when `authEnabled` | stateless exchange via `createMcpHandler` (both eras) |
| `GET /mcp` / `DELETE /mcp` | yes when `authEnabled` | 405 (legacy session verbs — no sessions exist) |
| anything else | — | 404 |

Every response carries an `X-Request-ID` header (8-char UUID slice).

## 5. Auth middleware (`src/middleware/auth.ts`)

```
createAuthMiddleware(config) → authenticate(req, res): AuthIdentity | null
```

Branches on `config.authMode`:

- `'none'` → returns `{ mode: 'anonymous', subject: 'anonymous',
  scopes: ['*'] }` immediately.
- Missing `Authorization: Bearer ...` header → 401.
- `'api-key'` → `safeCompare` (timing-safe `timingSafeEqual`) against
  every entry in `config.authApiKeys`. Subject = `key:<first 8 chars>...`.
- `'jwt'` → `verifyJwt(token, secret, issuer)`:
  - HS256 only.
  - Verifies signature with `createHmac` + `timingSafeEqual`.
  - Checks `exp` (unix seconds).
  - Checks `iss` against `config.authJwtIssuer`.
  - Returns `{ sub, scope? }` on success.

Rate limiter: in-memory `Map<subject, { count, resetAt }>`, sliding 1
min window, `config.rateLimitPerMinute` cap. Stale buckets cleaned
every 5 min.

## 6. Remote proxy (`src/transports/remote-proxy.ts`)

`startRemoteProxy({ serverUrl, apiKey })`:

1. `RemoteConnection` instance pinned to `serverUrl` + `apiKey`.
2. `await remote.health()` — best-effort warm-up; logs warning on
   failure but starts anyway.
3. `await remote.initialize()` — sends MCP `initialize` JSON-RPC.
4. Creates a local stdio MCP `Server` and wires four handlers:

| Local handler | Remote method |
|---|---|
| `ListToolsRequestSchema` | `tools/list` |
| `CallToolRequestSchema` | `tools/call` (`{ name, arguments }`) |
| `ListResourcesRequestSchema` | `resources/list` |
| `ReadResourceRequestSchema` | `resources/read` |

5. `await server.connect(new StdioServerTransport())`.

`RemoteConnection.request(method, params, id?)`:

- `POST <serverUrl>/mcp` with JSON-RPC body.
- Headers: `Content-Type`, `Accept: application/json,
  text/event-stream`, `Authorization: Bearer <apiKey>` (if set),
  `mcp-session-id: <captured>` (if set).
- Captures `mcp-session-id` from response headers for sticky sessions.
- Parses both `application/json` and `text/event-stream` responses
  (extracts JSON from `data: ...` lines).

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

The three search tools (`query`, `maxResults` ≥ 1, `repos`):

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
`label`, or a `::name` key suffix; case-sensitive, no wildcards), so a full
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
| `impact_analysis` | `GraphStore` | scope = `nodesInFiles(repo, [file], entity?)` (`entity` may be a full id) → `dependents` hop by hop up to `depth` (default 2, max 5); with `entity`, the file's `external` (cross-repo endpoint) nodes join the scope and their dependents are marked `[file-level]`; no nodes for the file → `isError` |
| `trace_path` | `GraphStore` | BFS over `neighborsOf(key, direction, types)` (`confidence ≥ 0.7`, unweighted); shortest path (≥ 1 hop) to `to`, else the reachable tree (≤`maxDepth` ≤ 10, cap 50) |
| `search_graph` | `GraphStore` | `searchNodes`: name = case-insensitive regex over symbol labels (invalid → `isError`), type / file / repo filters; rank by non-`contains` degree; top `limit` |
| `find_dead_code` | `<repo>/graph.json` + indexed chunk text | entity nodes (function/method/class/…) with zero non-`contains` in-degree whose name doesn't occur again in their own file (vector store `getChunksByFile`, else `chunks.json`) |
| `detect_changes` | git + `GraphStore` + `<repo>/index_meta.json` | `getAllChanges(repoPath, baseSha)`; added / deleted files → every node; modified files → entities whose range at the base overlaps a `git diff -U0` old-side hunk (ranges run from each entity's declaration line in `git show base:file` to the next declaration; an entity whose declaration isn't found is kept) + module node when a hunk falls outside every range + the file's endpoints (`[file-level]`) → one hop of `dependents` |
| `get_architecture` | `PROJECT_GRAPH.json` / `PROJECT_SUMMARY.md` / profiles | renders the CLI-generated project graph; degrades to profiles, then to a "no data" hint |

`dependents` follows edges into the scope plus shared-resource cross-repo
edges (`SYMMETRIC_EDGE_TYPES`: topics, tables, Redis keys, buckets, shared
types / constants / env vars / npm deps) out of it, so both sides of a
shared topic see each other.

Node id convention: `<repo>::<filePath>::<entity>` (matches AST graph
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

`registerResources(ctx)` lists only the two static URIs; dynamic ones
are matched via regex inside `handleResource(uri, ctx)`. Unknown URIs
return `text/plain "Unknown resource: <uri>"`.

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

## 10. Environment config (`src/core/env-config.ts`)

`loadServerConfig()` returns the full `ServerConfig`, cached in a
module-level `_config`. `resetServerConfig()` clears for tests.

`CODE_SEARCH_*` env var surface (via `env(key)` helper):

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3100` | parsed int |
| `HOST` | `127.0.0.1` if auth=none else `0.0.0.0` | |
| `TRANSPORT` | `stdio` | `stdio` / `sse` / `streamable-http` |
| `DATA_DIR` | `''` | passes through to knowledge-core's `getKnowledgeBasePath` |
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
| `AUTH_JWT_SECRET` | — | required for `jwt` mode |
| `AUTH_JWT_ISSUER` | `code-search-mcp` | |
| `RATE_LIMIT_PER_MINUTE` | `100` | |
| `LLM_MODE` | auto-resolved | see `resolveLlmMode` |
| `LLM_PROVIDER` | `anthropic` | |
| `LLM_MODEL` | `sonnet` | |
| `LLM_API_KEY` | falls back to `ANTHROPIC_API_KEY` | |
| `LLM_BASE_URL` | — | |
| `CLAUDE_BIN` | `claude` | |

`resolveLlmMode(explicit, apiKey)`:

1. Explicit `'cli'`/`'api'`/`'none'` wins (with API-key sanity check).
2. `apiKey` set → `'api'`.
3. `which <claudeBin>` succeeds → `'cli'`.
4. Else `'none'` (LLM features disabled, indexing still works).

API-key bridging at load time:

- `EMBEDDING_API_KEY` + provider → `MISTRAL_API_KEY` /
  `OPENAI_API_KEY` / `VOYAGE_API_KEY` (only if not already set).
- `RERANKER_API_KEY` + provider → `COHERE_API_KEY` / `VOYAGE_API_KEY`.
- `OLLAMA_HOST` set on `process.env` for downstream consumers.

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
    │   └── env-config.ts                    ← loadServerConfig (back-compat shim) + resolveLlmMode
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
    │   └── auth.ts                          ← none/api-key/jwt + rate limit
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
resolver, daemon RPC, graph tools (JSON and SQLite system graph), tool
input validation / descriptors / search metrics, stateless HTTP,
`/metrics` endpoint, observability, project registry. Retrieval and indexing behaviour is
covered by `@esankhan3/anvil-knowledge-core`'s tests.
