# `@anvil/knowledge-core` — Flows

Sequence-style descriptions of the core paths through the package. Every
arrow + box maps to actual symbols in `src/`. See `ARCHITECTURE.md` for
the static module map.

## 1. Index a directory — `indexFromPath(project, dir, opts)`

```
indexFromPath(project, dir, opts)              ← src/indexer.ts
  │
  └─ buildKBFromPath(project, dir, opts)
        ├─ repos = discoverRepos(dir)
        │     ├─ existsSync(<dir>/.git)? → single repo
        │     └─ else scan subdirs (skip node_modules, dist, .git, …)
        │           include only those with .git inside
        │     └─ detectLanguage(repo) per entry
        │
        └─ indexer.buildKB(project, repos, DEFAULT_CONFIG, opts)
              │
              ▼ (12 steps below)

embedFromPath(project, opts)
  └─ indexer.embedChunks(project, DEFAULT_CONFIG, opts)
        │
        ▼ (described in §3 below)
```

## 2. `KnowledgeIndexer.buildKB(...)` — 12 steps

```
buildKB(project, repos, config, opts):
  │
  ├─ basePath = getKnowledgeBasePath(project)
  │     └─ CODE_SEARCH_DATA_DIR > ANVIL_HOME/knowledge-base > ~/.anvil/...
  │
  ├─ Step 1 — SHA-based skip check
  │     for repo in repos:
  │       sha = getRepoSha(repo.path)              ← git rev-parse HEAD
  │       meta = readRepoIndexMeta(<basePath>/<repo>/index_meta.json)
  │       if !force && meta.lastIndexedSha === sha: skip
  │       else add to reposToIndex
  │
  ├─ Step 2 — LLM repo profiling (skipped if !isLlmAvailable())
  │     profileProject(project, repos, { force, onProgress })
  │           │
  │           └─ for each repo (concurrency 3):
  │               fingerprint = read signal-dense files (≤ 6000 chars)
  │               if profile.json fingerprintHash matches → skip
  │               runLLM(prompt, PROFILER_SYSTEM_PROMPT)  ← agent-core shim
  │               write <basePath>/<repo>/profile.json
  │
  ├─ Step 3 — Chunk repos
  │     for repo in reposToIndex:
  │       diff = meta?.lastIndexedSha
  │              ? getAllChanges(repo.path, meta.lastIndexedSha)
  │              : null
  │       useIncremental = diff && !diff.fallbackToFull && (added+modified+deleted) > 0
  │       result = useIncremental
  │              ? chunkChangedFiles(repo, name, project, cfg, diff)
  │              : chunkRepo(repo, name, project, cfg, meta?.files)
  │       allChunks.push(...result.chunks)
  │
  ├─ Step 4 — Structural dedup
  │     dedup = deduplicateByStructure(allChunks)
  │           ├─ computeStructuralHash per chunk (strip comments,
  │           │  collapse whitespace, normalize idents, sha256)
  │           └─ keep one per hash bucket
  │
  ├─ Step 5 — Workspace detection
  │     for repo in repos:
  │       workspaceMaps[repo.name] = detectWorkspace(repo.path)
  │             └─ run every ManifestDescriptor (one per ecosystem)
  │
  ├─ Step 6 — AST graphs
  │     graphBuilder = new ProjectGraphBuilder(); await init()
  │     for repo in repos:
  │       diff = repoDiffs.get(repo.name)
  │       if diff non-fallback && existsSync(graph.json):
  │         graph = await incrementalGraphUpdate(existingGraph,
  │                       changedFiles, deletedFiles, repo.path, { workspaceMap })
  │       else:
  │         graph = await buildAstGraph(repo.path, { workspaceMap })
  │             └─ 6 phases: ws nodes, entity extraction, import resolution,
  │                          type refs, call disambiguation, inheritance, contains
  │       graphBuilder.addRepoGraph(repo.name, graph)   ← namespace nodes as <repo>::<id>
  │       write graph.json + GRAPH_REPORT.md
  │
  ├─ Step 7 — Cross-repo edges (when repos.length > 1 or workspaces present)
  │     edges = await detectCrossRepoEdges(repos, workspaceMaps)
  │           └─ 14 strategies (kafka, http, grpc, db, env vars, npm/workspace deps,
  │              k8s, docker-compose, proto, redis, s3, shared types, shared constants)
  │     graphBuilder.addCrossRepoEdges(edges)
  │
  ├─ Step 8 — LLM service mesh (skipped if !isLlmAvailable())
  │     profiles = loadAllProfiles(project)
  │     meshEdges = await inferServiceMesh(profiles, opts)
  │           ├─ Phase A: deterministic match (consumes ↔ exposes)
  │           │            via normalizeIdentifier (lowercase, separators, version strip)
  │           └─ Phase B: LLM gap-fill for orphans
  │     graphBuilder.addCrossRepoEdges(meshEdges)
  │
  ├─ Step 9 — Community detection
  │     graphBuilder.detectCommunities()             ← Louvain
  │
  ├─ Step 10 — Save project graph
  │     write <basePath>/system_graph_v2.json (graphBuilder.exportJson())
  │
  ├─ Step 11 — Save chunks + deleted files
  │     write <basePath>/chunks.json (uniqueChunks)
  │     write <basePath>/deleted_files.json
  │
  └─ Step 12 — Per-repo metadata
        for repo in reposToIndex:
          write <basePath>/<repo>/index_meta.json {
            lastIndexedSha, lastIndexedAt, chunkCount,
            embeddingProvider: 'pending', files: fileIndex
          }

returns BuildKBResult { project, repos, totalChunks, totalTokens,
                        crossRepoEdges, durationMs, chunksPath }
```

## 3. `KnowledgeIndexer.embedChunks(...)` — incremental embedding

```
embedChunks(project, config, opts):
  │
  ├─ chunks = JSON.parse(read(<basePath>/chunks.json))
  ├─ store  = new VectorStore(<basePath>/lancedb); await init()
  │
  ├─ existingIds = await store.getChunkIds(project)
  ├─ newChunks   = chunks.filter(c => !existingIds.has(c.id))
  ├─ deletedFiles = read(<basePath>/deleted_files.json) || []
  │
  ├─ if newChunks.length === 0 && deletedFiles.length === 0:
  │      return cached IndexStats
  │
  ├─ Apply deletes:
  │     for [repoName, filePaths] in groupByRepo(deletedFiles):
  │       store.deleteFileChunks(project, repoName, filePaths)
  │
  ├─ embedder = createEmbeddingProvider(config.embedding)
  │     'auto' resolution:
  │       CODE_SEARCH_EMBEDDING_BASE_URL → OpenAICompatibleEmbedder
  │       Ollama running                 → OllamaEmbedder
  │       MISTRAL_API_KEY                → CodestralEmbedder
  │       OPENAI_API_KEY                 → OpenAIEmbedder
  │       VOYAGE_API_KEY                 → VoyageEmbedder
  │       GOOGLE_API_KEY|GEMINI_API_KEY  → GeminiOAuthEmbedder
  │       gemini CLI authenticated       → GeminiOAuthEmbedder
  │       else throw
  │
  ├─ batchSize = embedder.name === 'ollama' ? 10 : 50
  │  batchDelay = embedder.name === 'ollama' ? 50  : 100
  │
  ├─ for i = 0; i < texts.length; i += batchSize:
  │      embeddings.push(...await embedder.embed(slice))
  │      report progress + ETA
  │      sleep batchDelay between batches
  │
  ├─ embeddedChunks = newChunks.map((c,i) => ({ ...c, embedding: embeddings[i] }))
  ├─ store.addChunks(embeddedChunks)
  │
  └─ for repoName in repoNames:
       update index_meta.json { embeddingProvider: embedder.name, lastIndexedAt }

returns IndexStats { project, repos, totalChunks, totalTokens,
                     embeddingProvider, embeddingDimensions, ..., indexDurationMs }
```

## 4. Hybrid retrieval — `HybridRetriever.retrieve(query, opts)`

```
retriever.retrieve(query, opts):                ← src/retriever.ts
  │
  ├─ mode = opts.mode ?? 'vector+bm25+graph'
  │  useVector = mode !== 'bm25'
  │  useBm25   = mode in {bm25, vector+bm25, vector+bm25+graph}
  │  useGraph  = mode in {vector+graph, vector+bm25+graph}
  │
  ├─ classification = classifyQuery(query)        ← src/query-classifier.ts
  │     identifier|path|error-code|natural-language|mixed → adaptive weights
  │
  ├─ filterRepos = opts.repoFilter ?? opts.repos
  │      ?? (queryRouter ? await queryRouter.route(query).repos : undefined)
  │  filter = `repoName IN (...)` SQL fragment
  │
  ├─ Phase 1 — parallel retrieval (each fetches 50)
  │     queryEmbedding = useVector
  │       ? (cache hit ? cached : await embedder.embedSingle(query); cache.set)
  │       : null
  │     [vec, bm25] = await Promise.all([
  │       useVector ? store.vectorSearch(emb, { limit:50, filter }) : []
  │       useBm25   ? store.fullTextSearch(query, 50)               : []
  │     ])
  │
  ├─ if mode === 'vector' or 'bm25':
  │       packWithinBudget(results, maxTokens, maxChunks); return
  │
  ├─ Phase 2 — RRF fusion (with adaptive or default weights)
  │     wV = adaptiveWeights.vector ?? config.hybridWeights.vector
  │     wB = adaptiveWeights.bm25   ?? config.hybridWeights.bm25
  │     fused = reciprocalRankFusion([vec, bm25], [wV, wB])
  │             score(doc) = Σ_stream weight / (k + rank)
  │
  ├─ Phase 3 — AST tripartite expansion (skipped if !useGraph || !graph)
  │     seedNodeIds = resolveFusedSeeds(fused, 5)
  │           ├─ pick top fused chunks, one per file (diversify)
  │           └─ resolve <repo>::<file>::<entity> → graph node id
  │     expandedIds = tripartiteExpand(seedNodeIds)
  │           ├─ outgoing edges (deps) with confidence ≥ 0.7
  │           ├─ incoming edges (dependents) with confidence ≥ 0.7
  │           └─ exclude 'contains' relation
  │     astChunks = await store.getChunksByEntity(parsedLookups)
  │
  ├─ Phase 4 — Cross-encoder rerank
  │     candidatePool = dedupeById([...fused.slice(0,15), ...astChunks])
  │     if reranker && candidatePool.length > 1:
  │       try ranked = await reranker.rerank(query, docs, maxChunks)
  │       finalChunks = ranked.map(...)
  │       catch:    finalChunks = candidatePool   ← fall back to RRF order
  │     else finalChunks = candidatePool
  │
  └─ selected = packWithinBudget(finalChunks, maxTokens, maxChunks)
     graphContext = useGraph ? graph.exportForPrompt(2000) : ''
     return { chunks: selected, graphContext, totalTokens, query }
```

## 5. Repo profiling — `profileProject(project, repos, opts)`

```
profileProject(project, repos, opts):              ← src/repo-profiler.ts
  │
  ├─ basePath = getKnowledgeBasePath(project)
  │
  └─ runWithConcurrencyLimit(repos, MAX_CONCURRENT=3, async repo => {
        │
        ├─ fingerprint = build RepoFingerprint
        │     read signal-dense files: README, package.json, go.mod, etc.
        │     truncate to MAX_FINGERPRINT_CHARS=6000
        │     fingerprintHash = sha256(joined contents)
        │
        ├─ existing = readProfile(<basePath>/<repo>/profile.json)
        ├─ if !opts.force && existing.fingerprintHash === current.fingerprintHash:
        │      return cached
        │
        ├─ rawJson = await runLLM(userPrompt, PROFILER_SYSTEM_PROMPT, opts)
        │             ↑ shims to @anvil/agent-core single-shot
        │
        ├─ profile = parse + validate against RepoProfile schema
        │     profile.profiledAt = ISO now
        │     profile.profiledBy = model id
        │     profile.fingerprintHash = current.fingerprintHash
        │
        └─ write <basePath>/<repo>/profile.json
     })

returns RepoProfile[]
```

## 6. Service mesh inference — `inferServiceMesh(profiles, opts)`

```
inferServiceMesh(profiles, opts):                  ← src/service-mesh-inferrer.ts
  │
  ├─ Phase A — deterministic matching
  │     for consumer in profiles:
  │       for endpoint in consumer.consumes:
  │         normalizedC = normalizeIdentifier(endpoint.identifier)
  │              lowercase + collapse separators + strip version + normalize path params
  │         for producer in profiles - consumer:
  │           for produced in producer.exposes:
  │             if normalizedC === normalizeIdentifier(produced.identifier)
  │                && type-compatible (kafka-producer ↔ kafka-consumer, etc.):
  │                emit CrossRepoEdge {
  │                  sourceRepo: consumer.name,
  │                  targetRepo: producer.name,
  │                  edgeType: type-derived,
  │                  evidence: identifier,
  │                  confidence: 0.9
  │                }
  │
  ├─ Phase B — LLM gap-fill for orphans
  │     orphans = profiles.filter(p => no edges touch it)
  │     if orphans.length > 0:
  │       runLLM(buildOrphanPrompt(profiles, orphans), GAPFILL_SYSTEM)
  │       parse JSON → CrossRepoEdge[] (edgeType: 'llm-inferred', confidence: 0.5)
  │
  └─ return [...phaseAEdges, ...phaseBEdges]
```

## 7. Cross-repo edge detection — `detectCrossRepoEdges(repos, ws)`

```
detectCrossRepoEdges(repos, workspaceMaps?)        ← src/cross-repo-detector.ts
  │
  └─ unionAll(detectors):
       sharedTypes        → walkFiles per repo for type defs, match across
       kafkaTopics        → KafkaJS / sarama / spring patterns
       httpEndpoints      → routes per repo, match against fetch/axios calls
       grpcServices       → .proto files + service registrations
       databaseTables     → migrations + ORM models
       envVars            → process.env / os.Getenv references
       npmDeps            → package.json dependencies
       workspaceDeps      → from workspaceMaps
       workspaceImports   → static imports resolved through workspace aliases
       sharedConstants    → exact string match across repos for known patterns
       redis              → redis client config + key prefixes
       s3                 → bucket names
       proto              → shared proto file imports
       dockerCompose      → service references
       k8sService         → service.yaml manifests

each detector → CrossRepoEdge { sourceRepo, sourceNode, targetRepo, targetNode,
                                 edgeType, evidence, confidence }

walkFiles(dir, predicate, maxFiles=5000) bounds the per-detector work.
```

## 8. AST graph construction — `buildAstGraph(repoPath, opts)`

```
buildAstGraph(repoPath, { workspaceMap? })          ← src/ast-graph-builder.ts
  │
  ├─ Phase 0: Workspace nodes
  │     if workspaceMap: add a node per package
  │
  ├─ Phase 1: Walk + entity extraction
  │     for file in walkDir(repoPath):
  │       try tree-sitter (await ensureTreeSitter)
  │             parseFile(filePath, content, langFromExt)
  │             yields TreeSitterEntity[] (functions, classes, methods, types)
  │       fall back to regex when tree-sitter language unsupported
  │       add nodes: <repoName>::<filePath>::<entity>
  │
  ├─ Phase 2: Import resolution
  │     for each import:
  │       resolve relative ('./foo')        → file id
  │       resolve module path ('@org/pkg')  → workspace package node
  │       extractNamedImports → entity-level 'uses' edges
  │
  ├─ Phase 3: Type reference edges
  │     scan entity bodies for type refs in signatures
  │
  ├─ Phase 4: Call disambiguation
  │     resolve callee names against importGraph + symbolToIds (multi-candidate)
  │
  ├─ Phase 5: Inheritance resolution
  │     class extends / implements → edges
  │
  ├─ Phase 6: Package → file 'contains' edges
  │
  └─ return GraphifyOutput { nodes, links }
       each edge carries 'confidence' (0..1) for weighted retrieval BFS

incrementalGraphUpdate(existingGraph, changedFiles, deletedFiles, repoPath, opts):
  ├─ drop nodes whose file is in deletedFiles or changedFiles
  ├─ drop edges touching dropped nodes
  ├─ buildAstGraph subset for changedFiles (re-parse only those)
  └─ merge new nodes + edges back in
```

## 9. Project graph LLM build — `buildProjectGraph(project, opts)`

```
buildProjectGraph(project, opts):                   ← src/project-graph-builder.ts
  │
  ├─ context = assemble:
  │     factory.yaml summary
  │     <repo>/GRAPH_REPORT.md per repo
  │     cross-repo edges from system_graph_v2.json
  │
  ├─ result = await runLLM(promptFromContext, PROJECT_GRAPH_SYSTEM)
  │             ↑ shims to @anvil/agent-core
  │
  ├─ projectGraph: ProjectGraph = parse JSON
  │     { meta { generatedAt, model, provider, costUsd, durationMs },
  │       architectureSummary, repoRoles, communityLabels,
  │       relationships, keyFlows }
  │
  ├─ write <KB>/PROJECT_GRAPH.json
  └─ write <KB>/PROJECT_SUMMARY.md  (markdown summary for humans)

loadProjectGraph(project)         → ProjectGraph | null
loadProjectSummary(project)       → string | null
getProjectGraphStatus(project)    → { exists, generatedAt, model, costUsd }
estimateProjectGraphCost(project) → tokens + USD estimate (no LLM call)
```

## 10. Single-shot LLM runner — `runLLM(prompt, system, opts)`

```
runLLM / runClaude / runGemini / isLlmAvailable / resetLlmConfig
  │
  └─ re-export from @anvil/agent-core (src/single-shot.ts)
       │
       ├─ Mode resolution:
       │     ANVIL_LLM_MODE='cli' → spawn claude --output-format stream-json
       │                             (legacy alias: CODE_SEARCH_LLM_MODE)
       │     ANVIL_LLM_MODE='api' → fetch Anthropic /v1/messages or OpenAI compat
       │     ANVIL_LLM_MODE='none' → throw
       │     unset:
       │       API key present?    → 'api'
       │       claude on PATH?     → 'cli'
       │       else                → 'none'
       │
       ├─ withInvokeSpan opens gen_ai.invoke OTel span
       └─ returns ClaudeResult { result, costUsd, inputTokens, outputTokens, durationMs }

Used by:
  src/repo-profiler.ts             — RepoProfile generation
  src/service-mesh-inferrer.ts     — Phase B gap-fill
  src/rag-evaluator.ts             — answer + judge
  src/project-graph-builder.ts     — project graph generation
  src/indexer.ts                   — isLlmAvailable() guards Steps 2 + 8
```

## 11. Vector store I/O — write, read, delete

```
VectorStore.init():
  ├─ lancedb.connect(dbPath)
  ├─ try openTable('chunks') → ensureFtsIndex on contextualizedContent
  └─ catch → table created on first write

VectorStore.upsertChunks(chunks) / addChunks(chunks):
  └─ table.add(chunks.map(({embedding, ...rest}) => ({...rest, vector: embedding})))

VectorStore.vectorSearch(embedding, { limit, filter? }):
  └─ table.search(embedding).limit(limit).where(filter)
       returns ScoredChunk[] with source: 'vector'

VectorStore.fullTextSearch(query, limit):
  └─ table.search(query, 'fts').limit(limit)
       returns ScoredChunk[] with source: 'bm25'

VectorStore.getChunksByEntity(lookups):
  └─ for each {repoName, filePath, entityName?}:
       build WHERE clause matching all three columns
       union the result sets

VectorStore.deleteFileChunks(project, repoName, filePaths):
  └─ table.delete(`project='${project}' AND repoName='${repoName}'
                    AND filePath IN (${filePaths.map(quote).join(',')})`)
```

## 12. Embedder + reranker fallbacks

```
createEmbeddingProvider(config):
  switch config.provider:
    'codestral'|'mistral'   → CodestralEmbedder
    'voyage'                → VoyageEmbedder
    'openai'                → OpenAIEmbedder
    'ollama'                → OllamaEmbedder
    'gemini-oauth'|'gemini' → GeminiOAuthEmbedder
    'openai-compatible'|'custom' → OpenAICompatibleEmbedder
    'auto'                  → see "auto" decision tree above
    default                 → throw with provider list

createReranker(provider):
  switch provider:
    'ollama'                → OllamaReranker (qwen3:0.6b @ localhost:11434)
    'cohere'                → CohereReranker
    'voyage'                → VoyageReranker
    'openai-compatible'|'custom' → OpenAICompatibleReranker
    'none'                  → null
    default:
      CODE_SEARCH_RERANKER_BASE_URL set? → OpenAICompatibleReranker
      else                                → OllamaReranker

Reranker failures inside HybridRetriever.retrieve:
  try reranker.rerank(...)
  catch → finalChunks = candidatePool   ← graceful RRF-order fallback
                                         (Ollama down, network timeout, etc.)
```
