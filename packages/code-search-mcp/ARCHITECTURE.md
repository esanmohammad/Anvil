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
                 │   system_graph_v2.json        │
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
3. `await autoIndex(ctx)` — if `<KB>/lancedb` + `system_graph_v2.json`
   exist → `ctx.indexReady = true`. Else if `directoryPath` set →
   `trackedIndex(ctx, ..., { label: 'auto-index' })`. Else log "tools
   will return empty results."
4. Pick transport:
   - `stdio` → `new StdioServerTransport()` + `server.connect`.
   - else → `startHttpTransport(opts)` with `createMcpServer` factory
     producing one Server per session.
5. If `parseReindexInterval() > 0` → `setInterval(...).unref()` running
   `trackedIndex(..., { label: 'auto-reindex' })`.

### 3.3 `createMcpServerInstance(ctx)` — per-session MCP wiring

```
const server = new Server({ name: 'code-search-mcp', version: '0.1.0' },
                          { capabilities: { tools: {}, resources: {} } });
allTools = [...registerSearchTools, ...registerGraphTools,
            ...registerProfileTools, ...registerIndexTools];
server.setRequestHandler(ListToolsRequestSchema,  () => ({ tools: allTools }));
server.setRequestHandler(CallToolRequestSchema,   handleSearchTool || handleGraphTool
                                                  || handleProfileTool || handleIndexTool
                                                  || { error: 'Unknown tool: ...' });
server.setRequestHandler(ListResourcesRequestSchema, () => ({ resources }));
server.setRequestHandler(ReadResourceRequestSchema,  handleResource);
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
`config.port` / `config.host`. Per-session
`StreamableHTTPServerTransport` with:

- `MAX_SESSIONS = 100` cap.
- `SESSION_TTL_MS = 30 * 60 * 1000` (30 min).
- Cleanup `setInterval` every 5 min (drops stale sessions).
- Each new session creates its own `mcpServer = await createMcpServer()`
  → `transport.handleRequest(req, res)`. The transport allocates a
  session id (returned in `mcp-session-id` response header).

Routes:

| Method + path | Auth | Handler |
|---|---|---|
| `GET /health` | none | `getHealth()` + `activeSessions` count |
| `GET /status` | none | `getStatus()` (live indexing telemetry) |
| `POST /index` | yes when `authEnabled` | parses `{ path, project?, force? }` JSON, calls `onIndex(body)` |
| `POST /mcp` (no `mcp-session-id`) | yes when `authEnabled` | new session: create transport + Server, route request |
| `POST /mcp` (with `mcp-session-id`) | yes when `authEnabled` | route to existing session's transport, bump `lastActivity` |
| `GET /mcp` | yes when `authEnabled` | SSE stream for existing session |
| `DELETE /mcp` | yes when `authEnabled` | drop session |
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

### 7.1 Search (`tools/search.ts`)

| Tool | Mode passed to retriever |
|---|---|
| `search_code` | `'vector+bm25+graph'` (full pipeline) |
| `search_semantic` | `'vector'` (single-source) |
| `search_exact` | `'bm25'` (single-source) |

All three:

1. Guard on `ctx.indexReady`.
2. `retriever = await getRetriever(ctx.projectName)` (knowledge-core).
3. `retriever.retrieve(query, { maxChunks: maxResults || 10,
   repoFilter: repos, mode })`.
4. Format chunks as markdown with score, source, language fence.

### 7.2 Graph (`tools/graph.ts`)

Reads JSON files directly from `<KB>/<project>/`:

| Tool | Reads | What it computes |
|---|---|---|
| `get_repo_graph` | `<repo>/graph.json` | summary + first 50 entities |
| `get_cross_repo_edges` | `system_graph_v2.json` | filter to `src.repo !== tgt.repo`, optional `repo` filter on either end |
| `find_callers` | `system_graph_v2.json` | match nodes by label/key substring → incoming edges → unique sources (top 30) |
| `find_dependencies` | `system_graph_v2.json` | same but outgoing → unique targets |
| `impact_analysis` | `system_graph_v2.json` | nodes whose key contains `<repo>::<file>::` (and optional `<entity>`); incoming edges from outside the file → dependents + affected repo set |

Node id convention: `<repo>::<filePath>::<entity>` (matches AST graph
builder's namespacing).

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
| `code-search://system-graph` | `<KB>/system_graph_v2.json` |
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
├── FLOW.md
├── build.mjs                                ← esbuild bundle script
└── src/
    ├── index.ts                             ← CLI entry + mode dispatch
    ├── server.ts                            ← startServer + ServerContext + autoIndex + trackedIndex
    │
    ├── core/
    │   └── env-config.ts                    ← loadServerConfig + resolveLlmMode
    │
    ├── transports/
    │   ├── http-transport.ts                ← Streamable HTTP + sessions
    │   └── remote-proxy.ts                  ← stdio → /mcp forwarder
    │
    ├── middleware/
    │   └── auth.ts                          ← none/api-key/jwt + rate limit
    │
    ├── tools/
    │   ├── search.ts                        ← search_code / _semantic / _exact
    │   ├── graph.ts                         ← 5 graph tools
    │   ├── profile.ts                       ← list_repos / get_repo_profile
    │   └── index-tools.ts                   ← index_status
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

- `@modelcontextprotocol/sdk` (^1.29.0) — MCP `Server`,
  `StdioServerTransport`, `StreamableHTTPServerTransport`, request
  schemas.
- `@anvil/knowledge-core` (workspace) — chunking, retrieval, indexing,
  repo profiling, project graph. All tools and resources delegate
  here.
- `@anvil/agent-core` (workspace, transitive via knowledge-core) — LLM
  runner shim used during repo profiling and service mesh inference.

Build: `node build.mjs` produces a single bundled `dist/index.js` (bin
target). No `tsc` for shipping; `tsc -b --watch` in dev only.

## 13. Tests

No `__tests__/` directory — the package is glue code. Behavioral
coverage lives in `@anvil/knowledge-core`'s tests (chunker,
query-classifier, retriever defaults, structural hasher).
