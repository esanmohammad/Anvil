# `@esankhan3/code-search-mcp` — Flows

Sequence-style descriptions of the core paths through the package. Every
arrow + box maps to actual symbols in `src/`. See `ARCHITECTURE.md` for
the static module map.

## 1. Mode dispatch — `code-search-mcp` invocation

```
process.argv (sliced past 'node code-search-mcp')
  │
  ▼
src/index.ts argv loop
  ├─ --remote <url>         → mode='remote', remoteUrl=<url>
  ├─ --local [src]          → mode='local', source=<src>
  ├─ --serve                → mode='serve'
  ├─ --api-key | --project | --token | --port | --transport | --auth
  ├─ --force                → force=true
  ├─ --help / -h            → print usage, exit 0
  └─ bare arg starting with http(s):// → mode='remote', remoteUrl=<arg>
     bare arg otherwise               → mode='local', source=<arg>

▼ (async IIFE)
  switch mode:
    'remote' → resolve serverUrl ?? CODE_SEARCH_SERVER ?? CODE_SEARCH_REMOTE_URL
               resolve apiKey   ?? CODE_SEARCH_API_KEY ?? CODE_SEARCH_AUTH_API_KEY
               serverUrl missing? print usage, exit 1
               import('./transports/remote-proxy.js').startRemoteProxy(...)

    'serve'  → set CODE_SEARCH_PORT / AUTH_MODE / TRANSPORT from flags
               import('./server.js').startServer(projectName ?? 'default',
                                                  source ? resolve(source) : null)

    'local'  → if source startsWith 'github:':
                  cloneOrUpdateOrg(org, { pattern, token, onProgress })
                  directoryPath = ~/.code-search/<org>/
               elif source: directoryPath = resolve(source); validate exists
               elif !projectName: directoryPath = process.cwd()
               projectName ?= basename(directoryPath)
               startServer(projectName, directoryPath)
```

## 2. Remote-proxy startup — `startRemoteProxy({ serverUrl, apiKey })`

```
startRemoteProxy(config)                          ← src/transports/remote-proxy.ts
  │
  ├─ remote = new RemoteConnection(config)
  │     this.serverUrl = config.serverUrl.replace(/\/$/, '')
  │     this.apiKey    = config.apiKey
  │     this.sessionId = null
  │
  ├─ try await remote.health()
  │     GET <serverUrl>/health
  │     log "Connected ... project, index ready: ..."
  │   catch: log warning, continue anyway
  │
  ├─ try await remote.initialize()
  │     POST <serverUrl>/mcp { jsonrpc, method:'initialize', params: { protocolVersion, capabilities, clientInfo } }
  │     headers: Content-Type, Accept: application/json,text/event-stream,
  │              Authorization: Bearer <apiKey>?, mcp-session-id <captured>?
  │     parse SSE or JSON; capture mcp-session-id response header
  │   catch: log warning, retry on first request
  │
  ├─ server = new Server({ name: 'code-search-mcp', version: '0.1.0' },
  │                       { capabilities: { tools: {}, resources: {} } })
  │
  ├─ wire 4 forwarders:
  │     ListToolsRequestSchema     → remote.request('tools/list')
  │     CallToolRequestSchema      → remote.request('tools/call', { name, arguments })
  │     ListResourcesRequestSchema → remote.request('resources/list')
  │     ReadResourceRequestSchema  → remote.request('resources/read', { uri })
  │
  └─ await server.connect(new StdioServerTransport())
       ↑ binds to process.stdin/stdout for the MCP client
```

`RemoteConnection.request` body sketch:

```
fetch(<serverUrl>/mcp, {
  method: 'POST',
  headers: { 'Content-Type', 'Accept: application/json, text/event-stream',
             Authorization?, mcp-session-id? },
  body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
})
  on response:
    capture mcp-session-id header → this.sessionId
    if content-type includes 'text/event-stream':
      parse "data: <json>" lines; return first parsed JSON
    else
      return response.json()
```

## 3. Serve-mode startup — `startServer(project, dirPath)`

```
startServer(projectName, directoryPath)             ← src/server.ts
  │
  ├─ config = loadServerConfig()                    ← src/core/env-config.ts (cached)
  │     reads every CODE_SEARCH_* env var
  │     resolveLlmMode(LLM_MODE, LLM_API_KEY ?? ANTHROPIC_API_KEY)
  │     bridges EMBEDDING_API_KEY → MISTRAL/OPENAI/VOYAGE_API_KEY
  │     bridges RERANKER_API_KEY → COHERE/VOYAGE_API_KEY
  │     sets process.env.OLLAMA_HOST
  │
  ├─ ctx: ServerContext = {
  │     projectName, directoryPath,
  │     indexReady: false, startedAt: Date.now(),
  │     indexing: { status: 'idle', phase, message, percent: 0,
  │                 startedAt: null, error: null,
  │                 lastSuccess: null, lastDurationMs: 0,
  │                 history: [] (cap 50) }
  │   }
  │
  ├─ console.error("LLM: " + (mode==='none' ? 'disabled' :
  │                            mode==='api'  ? `api → ${provider}/${model}` :
  │                            `cli → ${claudeBin}`))
  │
  ├─ await autoIndex(ctx):
  │     kbPath = getKnowledgeBasePath(projectName)
  │     hasLanceDB = existsSync(kbPath/lancedb)
  │     hasGraph   = existsSync(kbPath/system_graph_v2.json)
  │     hasLanceDB && hasGraph?
  │        ctx.indexReady = true; log "Index loaded"
  │     else !directoryPath?
  │        log "No index, no path — tools return empty"
  │     else:
  │        log "No index — building from <dirPath>..."
  │        await trackedIndex(ctx, projectName, directoryPath, { label: 'auto-index' })
  │
  ├─ if config.transport === 'stdio':
  │     server = createMcpServerInstance(ctx)
  │     transport = new StdioServerTransport()
  │     await server.connect(transport)
  │     log "Server running for <project> (stdio)"
  │   else:
  │     warn if authMode==='none' && host !== '127.0.0.1'/'localhost'
  │     await startHttpTransport({
  │       config,
  │       createMcpServer: async () => ({ server: createMcpServerInstance(ctx) }),
  │       onReady, getHealth, getStatus, onIndex
  │     })
  │
  └─ reindexMs = parseReindexInterval()
     reindexMs > 0 && ctx.directoryPath?
        setInterval(async () => {
          if !ctx.directoryPath || ctx.indexing.status==='indexing': return
          await trackedIndex(ctx, ctx.projectName, ctx.directoryPath, { label: 'auto-reindex' })
        }, reindexMs).unref()
```

## 4. HTTP transport request lifecycle

```
startHttpTransport({ config, createMcpServer, onReady, getHealth, getStatus, onIndex })
  │
  ├─ authenticate = createAuthMiddleware(config)
  ├─ sessions: Map<id, { transport, lastActivity }>  (cap 100, TTL 30 min)
  ├─ setInterval cleanup-stale-sessions every 5 min .unref()
  │
  └─ http.createServer(async (req, res) => {
       requestId = randomUUID().slice(0,8)
       res.setHeader('X-Request-ID', requestId)

       switch path + method:

       GET /health:
         json { status: 'ok', activeSessions: sessions.size, ...getHealth?() }

       GET /status:
         json getStatus?()  ← live indexing telemetry (phase, percent, history, ...)

       POST /index:
         if config.authEnabled: identity = authenticate(req,res); !identity → return
         body = collect chunks
         parsed = JSON.parse(body) as { path, project?, force? }
         !parsed.path → 400
         !onIndex     → 501
         result = await onIndex(parsed)
         json 200 result

       POST /mcp:
         if config.authEnabled: authenticate; !identity → return
         sessionId = req.headers['mcp-session-id']
         if sessionId && sessions.has(sessionId):
           bump lastActivity → existing transport.handleRequest
         elif sessionId && !sessions.has(sessionId):
           400 "Invalid session ID"
         elif sessions.size >= 100:
           503 "Too many active sessions"
         else (new session):
           transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID })
           { server: mcpServer } = await createMcpServer()
           await mcpServer.connect(transport)
           transport.onclose = drop session from Map
           await transport.handleRequest(req, res)   ← writes mcp-session-id response header
           newSessionId = res.getHeader('mcp-session-id')
           sessions.set(newSessionId, { transport, lastActivity: Date.now() })

       GET /mcp:
         existing session → SSE stream via transport.handleRequest
         else 400

       DELETE /mcp:
         existing session → transport.handleRequest + sessions.delete
         else 400

       *: 404
     }).listen(config.port, config.host, () => onReady(`http://${host}:${port}`))
```

## 5. Auth middleware decision tree

```
authenticate(req, res):                            ← src/middleware/auth.ts

config.authMode === 'none'?
  → return { mode: 'anonymous', subject: 'anonymous', scopes: ['*'] }

req.headers.authorization startsWith 'Bearer '? else
  → 401 "Missing Authorization header"; return null

token = authHeader.slice(7)

config.authMode === 'api-key':
  matched = config.authApiKeys.some(key => safeCompare(token, key))   ← timingSafeEqual
  !matched → 401 "Invalid API key"; return null
  identity = { mode:'api-key', subject:`key:${token.slice(0,8)}...`, scopes:['*'] }
  checkRateLimit(identity.subject, config.rateLimitPerMinute)?
    pass → return identity
    fail → 429 "Rate limit exceeded"; return null

config.authMode === 'jwt':
  !config.authJwtSecret → 500 "JWT secret not configured"
  claims = verifyJwt(token, secret, issuer):
    parts = token.split('.'); !=3 → null
    header.alg === 'HS256'? else null
    expected = createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest('base64url')
    timingSafeEqual(sigBuf, expectedBuf)? else null
    payload.exp && exp < now? null
    issuer && payload.iss !== issuer? null
    return { sub, scope }
  !claims → 401 "Invalid or expired JWT"; return null
  identity = { mode:'jwt', subject:claims.sub, scopes: claims.scope?.split(' ') ?? ['*'] }
  rate limit → return | 429
```

Rate-limit bucket: `Map<subject, { count, resetAt: now + 60_000 }>`.
Cleanup `setInterval` every 5 min `.unref()`.

## 6. Tool dispatch — `tools/call` request

```
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  name = request.params.name
  args = request.params.arguments ?? {}

  searchResult  = await handleSearchTool(name, args, ctx);   if (searchResult)  return searchResult
  graphResult   = await handleGraphTool(name, args, ctx);    if (graphResult)   return graphResult
  profileResult = await handleProfileTool(name, args, ctx);  if (profileResult) return profileResult
  indexResult   = await handleIndexTool(name, args, ctx);    if (indexResult)   return indexResult

  return { content: [{ type:'text', text:`Unknown tool: ${name}` }], isError: true }
})
```

Each handler returns `null` if `name` doesn't match its TOOL_NAMES, so
the next handler gets a chance.

## 7. Search call — `search_code` / `search_semantic` / `search_exact`

```
handleSearchTool(name, args, ctx):                ← src/tools/search.ts
  │
  ├─ name not in {search_code, search_semantic, search_exact}? return null
  ├─ !ctx.indexReady? return "Index not ready..."
  │
  ├─ retriever = await getRetriever(ctx.projectName)            ← @anvil/knowledge-core
  │
  ├─ modeMap[name] →
  │     search_code     : 'vector+bm25+graph'
  │     search_semantic : 'vector'
  │     search_exact    : 'bm25'
  │
  ├─ result = await retriever.retrieve(args.query, {
  │     maxChunks  : args.maxResults ?? 10,
  │     repoFilter : args.repos,
  │     mode
  │   })
  │     ↑ runs HybridRetriever 4-phase pipeline (knowledge-core/FLOW.md §4)
  │
  ├─ result.chunks.length === 0? return "No results found for ..."
  │
  └─ format markdown with score + source + language fence:
       "### N. <repo>/<file>:<line> (score: 0.XXX, source: vector|bm25|graph|fused)\n
        ```<lang>\n<content>\n```"
     return { content: [{ type:'text', text }] }
```

## 8. Graph call — `find_callers` / `find_dependencies`

```
handleGraphTool(name='find_callers'|'find_dependencies', args, ctx):
  │
  ├─ kbPath = getKnowledgeBasePath(ctx.projectName)
  ├─ sysGraph = JSON.parse(read(kbPath/system_graph_v2.json))
  ├─ edges = sysGraph.edges ?? []
  │
  ├─ funcName = args.function; repoFilter = args.repo
  ├─ matchingNodes = sysGraph.nodes.filter(n =>
  │     (n.attributes.label || n.key).includes(funcName)
  │     && (!repoFilter || n.key.startsWith(`${repoFilter}::`))
  │   )
  │
  ├─ matchingNodes.length === 0? return `No entity found matching "${funcName}"`
  │
  ├─ nodeKeys = new Set(matchingNodes.map(n => n.key))
  │
  ├─ if name === 'find_callers':
  │     incoming = edges.filter(e => nodeKeys.has(e.target)).map(e => e.source)
  │   else:
  │     outgoing = edges.filter(e => nodeKeys.has(e.source)).map(e => e.target)
  │
  └─ unique = [...new Set(results)].slice(0, 30)
     direction = name === 'find_callers' ? 'Callers of' : 'Dependencies of'
     return markdown list of unique node keys
```

`get_repo_graph`, `get_cross_repo_edges`, `impact_analysis` follow the
same pattern — read a JSON file, filter, format. See
`src/tools/graph.ts` for exact predicates.

## 9. Admin index — `POST /index` request

```
client → POST /index { path, project?, force? } + Authorization: Bearer <key>
  │
  ▼
http-transport.ts route handler:
  │
  ├─ config.authEnabled? authenticate(req, res); !identity → return
  ├─ collect body chunks → JSON.parse
  ├─ !parsed.path → 400 "`path` is required"
  ├─ !opts.onIndex → 501 "Indexing handler not configured"
  │
  └─ result = await opts.onIndex(parsed)   ← server.ts onIndex callback
        │
        ├─ dirPath = resolve(parsed.path)
        ├─ !existsSync(dirPath) → throw "Path does not exist: ..."
        ├─ ctx.indexing.status === 'indexing'?
        │     throw "Indexing already in progress (phase: ...)"
        ├─ project = parsed.project || basename(dirPath) || 'project'
        │
        ├─ stats = await trackedIndex(ctx, project, dirPath, {
        │     force: parsed.force, label: 'admin-index'
        │   })
        │
        ├─ ctx.projectName   = project       ← store now points to this project
        ├─ ctx.directoryPath = dirPath
        │
        └─ return { status: 'ok', project, path: dirPath,
                    chunks: stats.totalChunks, repos: stats.repos.length,
                    crossRepoEdges, durationMs }

  res.writeHead(200) + res.end(JSON.stringify(result))
```

## 10. `trackedIndex` — status tracking around `indexFromPath`

```
trackedIndex(ctx, project, dirPath, opts={ force, label }):
  │
  ├─ ctx.indexing.status     = 'indexing'
  │  ctx.indexing.phase      = 'starting'
  │  ctx.indexing.message    = `Starting ${label}...`
  │  ctx.indexing.percent    = 0
  │  ctx.indexing.startedAt  = Date.now()
  │  ctx.indexing.error      = null
  │  pushHistory('start', `${label}: started for "${project}" at ${dirPath}`)
  │
  ├─ try:
  │     stats = await indexFromPath(project, dirPath, {
  │       force,
  │       onProgress: m => {
  │         ctx.indexing.message = m
  │         console.error(`[${label}] ${m}`)
  │       },
  │       onDetailedProgress: p => {
  │         ctx.indexing.phase   = p.phase   ← chunking|profiling|embedding|graphing|...
  │         ctx.indexing.percent = p.percent
  │         ctx.indexing.message = p.message
  │       }
  │     })   ← @anvil/knowledge-core 12-step buildKB + incremental embedChunks
  │
  │     ctx.indexReady              = true
  │     ctx.indexing.status         = 'idle'
  │     ctx.indexing.phase          = null
  │     ctx.indexing.percent        = 100
  │     ctx.indexing.lastSuccess    = ISO now
  │     ctx.indexing.lastDurationMs = stats.indexDurationMs
  │     ctx.indexing.message        = `Completed: ${chunks} chunks, ${repos} repos in ${secs}s`
  │     pushHistory('complete', message)
  │     return stats
  │
  └─ catch err:
       ctx.indexing.status  = 'error'
       ctx.indexing.error   = err.message
       ctx.indexing.message = `Failed: ${err.message}`
       pushHistory('error', err.message)
       throw err

pushHistory(ctx, type, message):
  ctx.indexing.history.push({ timestamp: ISO now, type, message })
  if length > 50: keep last 50 (FIFO)
```

Streamed live via `GET /status`:

```
{
  project, directoryPath, indexReady, uptime,
  indexing: {
    status, phase, message, percent,
    startedAt, error, lastSuccess, lastDurationMs,
    history: [...],
    elapsedMs: ctx.indexing.startedAt ? Date.now() - startedAt : null
  }
}
```

## 11. Auto-reindex schedule

```
reindexIntervalMs = parseReindexInterval():
  raw = process.env.CODE_SEARCH_REINDEX_INTERVAL?.trim()
  raw=='0' | 'none' | undefined → 0 (disabled)
  match = /^(\d+)(m|h)$/   else stderr warning + 0
  return value * (unit==='h' ? 3_600_000 : 60_000)

reindexIntervalMs > 0 && ctx.directoryPath?
  log "Auto-reindex every Xm"
  setInterval(async () => {
    if !ctx.directoryPath || ctx.indexing.status === 'indexing': return  ← prevent overlap
    try {
      await trackedIndex(ctx, ctx.projectName, ctx.directoryPath, { label: 'auto-reindex' })
    } catch (err) { console.error('[auto-reindex] Failed:', err) }
  }, reindexIntervalMs).unref()
                          ↑ doesn't keep process alive
```

Combined with knowledge-core's incremental indexing (git SHA skip,
`git diff` for changed files, embedding diff against LanceDB), most
auto-reindex runs complete in seconds with zero embedding API calls.

## 12. Resource read — `code-search://...`

```
ReadResourceRequestSchema → handleResource(uri, ctx):     ← src/resources/resources.ts

  uri === 'code-search://repos':
     profiles = loadAllProfiles(ctx.projectName)             ← @anvil/knowledge-core
     return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(profiles) }] }

  uri === 'code-search://system-graph':
     graphPath = <KB>/<project>/system_graph_v2.json
     !exists? → empty graph JSON
     return { contents: [{ uri, mimeType: 'application/json', text: read(graphPath) }] }

  uri match /^code-search:\/\/repo\/([^/]+)\/profile$/:
     profile = loadProfile(ctx.projectName, name)
     text = profile ? JSON.stringify(profile) : '{}'
     return { contents: [...] }

  uri match /^code-search:\/\/repo\/([^/]+)\/graph$/:
     graphPath = <KB>/<project>/<name>/graph.json
     return { contents: [...] }   (or '{"nodes":[],"links":[]}' if missing)

  default: return text/plain "Unknown resource: <uri>"
```

## 13. GitHub-org clone flow — `--local github:org/pattern`

```
src/index.ts:
  source startsWith 'github:' →
    spec = source.slice(7)
    org = spec before '/' (or whole spec)
    pattern = spec after '/' (or undefined)
    projectName ?= org
    repos = await cloneOrUpdateOrg(org, { pattern, token: --token ?? GITHUB_TOKEN, onProgress })
    directoryPath = ~/.code-search/<org>/

cloneOrUpdateOrg(org, { pattern?, token?, workspacePath?, maxRepos?=500, onProgress? }):
  ├─ workspacePath ?= ~/.code-search/<org>
  ├─ mkdirSync(workspacePath, { recursive: true })
  │
  ├─ try orgRepos = listReposViaGhCli(org, maxRepos)        ← `gh repo list <org> --json ...`
  │   catch: if !token → throw
  │          orgRepos = await listReposViaApi(org, token, maxRepos)
  │
  ├─ if pattern: filter orgRepos by glob
  │
  └─ for each orgRepo:
       targetPath = workspacePath/<repo-name>
       existsSync(targetPath)? → git pull (update)
       else                    → git clone <cloneUrl> <targetPath>
       push { name, path, language }

→ returned to index.ts as the local source (then standard local-mode path:
  startServer(projectName, directoryPath))
```
