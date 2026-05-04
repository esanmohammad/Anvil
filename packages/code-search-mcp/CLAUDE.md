# CLAUDE.md — `@esankhan3/code-search-mcp`

Guidance for Claude Code when working inside `packages/code-search-mcp/`.
The MCP server (and stdio proxy) for multi-repo code intelligence.
Wraps `@anvil/knowledge-core` behind the Model Context Protocol so any
MCP client (Claude Code, Claude Desktop, Cursor, ...) can search,
trace callers, and analyze impact across all indexed repos.

## What this package owns

### Three operating modes (single binary)

`src/index.ts` parses argv and dispatches:

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
  `/health` + `/status` + `POST /index` admin endpoints.

### Tools (4 categories, 11 tools total)

All implemented in `src/tools/`:

- **Search** (`search.ts`) — `search_code` (hybrid),
  `search_semantic` (vector-only), `search_exact` (BM25). All call
  `getRetriever(project).retrieve(query, opts)` from knowledge-core.
- **Graph** (`graph.ts`) — `get_repo_graph`, `get_cross_repo_edges`,
  `find_callers`, `find_dependencies`, `impact_analysis`. Read directly
  from `<KB>/system_graph_v2.json` and `<KB>/<repo>/graph.json`.
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

### Environment config

`src/core/env-config.ts:loadServerConfig()` — single source of truth
for every `CODE_SEARCH_*` env var. Cached on first load (use
`resetServerConfig()` in tests).

Bridges API keys to provider-specific env vars at load time:
- `EMBEDDING_API_KEY` → `MISTRAL_API_KEY` / `OPENAI_API_KEY` /
  `VOYAGE_API_KEY` (based on `EMBEDDING_PROVIDER`).
- `RERANKER_API_KEY` → `COHERE_API_KEY` / `VOYAGE_API_KEY`.
- `OLLAMA_HOST` set on `process.env` for downstream consumers.

## Build + test

```sh
npm -w @esankhan3/code-search-mcp run build       # node build.mjs (esbuild bundle)
npm -w @esankhan3/code-search-mcp run dev         # tsc -b --watch
```

No tests in this package — surface area is mostly glue over
`@anvil/knowledge-core`. Behavioral tests live one layer down in
knowledge-core's `__tests__/`.

Build output: single bundled `dist/index.js` (binary entry; bin
`code-search-mcp`).

## Conventions

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
- No tests in this package — knowledge-core covers the actual logic.

## Where to look first

- New CLI flag? `src/index.ts` argv loop (top of file).
- New tool? Pick the right `tools/<x>.ts` file; pattern is
  `register<X>Tools()` + `handle<X>Tool(name, args, ctx)`.
- HTTP route? `src/transports/http-transport.ts` — single dispatch
  function inside `createServer`.
- Auth behavior? `src/middleware/auth.ts:createAuthMiddleware` — one
  function, three branches (`none` / `api-key` / `jwt`).
- Env var resolution? `src/core/env-config.ts:loadServerConfig`.

## Architecture + flow docs

- `ARCHITECTURE.md` — module map, mode dispatch, HTTP routes, tool
  surface, session lifecycle.
- `FLOW.md` — sequence diagrams: remote-proxy startup, serve-mode
  startup, search call, graph call, admin index, auto-reindex.
