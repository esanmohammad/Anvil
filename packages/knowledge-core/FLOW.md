# `@esankhan3/anvil-knowledge-core` — Flows

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
        └─ indexer.buildKB(project, repos, opts.config ?? loadKnowledgeConfig(project), opts)
              │
              ▼ (11 steps below)

embedFromPath(project, opts)
  └─ indexer.embedChunks(project, opts.config ?? loadKnowledgeConfig(project), opts)
        │
        ▼ (described in §3 below)
```

## 2. `KnowledgeIndexer.buildKB(...)` — 11 steps

```
buildKB(project, repos, config, opts):
  │
  ├─ basePath = getKnowledgeBasePath(project)
  │     └─ CODE_SEARCH_DATA_DIR > ANVIL_HOME/knowledge-base > ~/.anvil/...
  │
  ├─ Step 1 — SHA + working-tree skip check
  │     for repo in repos:
  │       sha = getRepoSha(repo.path)              ← git rev-parse HEAD (ls-remote for cloneUrl)
  │       meta = readRepoIndexMeta(<basePath>/<repo>/index_meta.json)
  │       tree = getWorkingTreeState(repo.path)    ← uncommitted edits (local checkouts)
  │       if !force && meta.lastIndexedSha === sha && tree === meta.workingTree
  │          && graph.json exists && signals.json.version === CROSS_REPO_SIGNALS_VERSION
  │          && meta.chunkIdVersion === CHUNK_ID_VERSION: skip
  │       else add to reposToIndex
  │     removedRepos = index_stats.json repos − current repos
  │     nothing to index && no removedRepos → return (no-op)
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
  │       diff = !meta?.lastIndexedSha ? null
  │              : HEAD === meta.lastIndexedSha
  │                ? diffWorkingTreeStates(meta.workingTree, tree)   ← edits since last index
  │                : getAllChanges(repo.path, meta.lastIndexedSha)   ← + indexed edits no longer dirty
  │       useIncremental = diff && !diff.fallbackToFull && (added+modified+deleted) > 0
  │       (meta on another CHUNK_ID_VERSION → treated as absent: full re-chunk)
  │       useIncremental
  │         ? chunkChangedFiles(repo, name, project, cfg, diff, write, meta.files)
  │         : chunkRepo(repo, name, project, cfg, meta?.files, write)
  │             └─ boundaries: tree-sitter definitions (regex fallback), each
  │                pulled up over its leading comments / decorators
  │       write → <repo>/chunks.shard.ndjson (local scratch, streamed)
  │       fileIndex = every file the repo has (incremental: cached − diffed + re-chunked)
  │
  │     Steps 3, 5 and 6 run together per repo (repo-pipeline.ts:processCheckout)
  │     in an adaptive worker pool, in-thread on fallback. Each repo:
  │       workspaceMap = detectWorkspace(repo.path)    ← Step 5
  │       chunk to the shard (above)
  │       graph = Step 6 (below); write graph.json + GRAPH_REPORT.md
  │       write <repo>/signals.json = extractCrossRepoSignals(repo.path, { ignorePatterns })
  │     As each repo finishes, the main thread streams its graph into
  │     system_graph.sqlite (graphWriter.addRepoGraph — nodes namespaced
  │     <repo>::<id>). Skipped repos are served from their stored graph.json.
  │
  ├─ Step 4 — Merge chunks (streamed)
  │     mergeShardsToChunks(shards, carryForward) → <basePath>/chunks.json
  │           ├─ fresh shards first, then the previous corpus filtered to
  │           │  skipped repos + unchanged files still in a partial repo's fileIndex
  │           └─ one chunk per id (no cross-file / cross-repo dedup)
  │
  ├─ Step 5 — Workspace detection (in the per-repo worker)
  │     detectWorkspace(repo.path)
  │           └─ run every ManifestDescriptor (one per ecosystem)
  │
  ├─ Step 6 — AST graph (in the per-repo worker)
  │     if useIncremental && graph.json exists:
  │       graph = await incrementalGraphUpdate(existingGraph,
  │                     changedFiles, deletedFiles, repo.path, { workspaceMap })
  │     else:
  │       graph = await buildAstGraph(repo.path, { workspaceMap, ignorePatterns })
  │           └─ 6 phases: ws nodes, entity extraction (tree-sitter, regex
  │              fallback), import resolution, type refs, call disambiguation,
  │              inheritance, contains — names resolve within a language family
  │
  ├─ Step 7 — Cross-repo edges (when repos.length > 1 or workspaces present)
  │     edges = correlateCrossRepoEdges(<repo>/signals.json for every repo, workspaceMaps)
  │           └─ 14 strategies (npm/workspace deps, shared types, env vars, shared
  │              events/topics, HTTP routes, gRPC services, DB schemas, Redis keys,
  │              S3 buckets, OpenAPI contracts, docker-compose + k8s refs → `http`,
  │              shared constants)
  │     graphWriter.addCrossRepoEdges(edges)
  │
  ├─ Step 8 — LLM service mesh (skipped if !isLlmAvailable())
  │     profiles = loadAllProfiles(project)
  │     meshEdges = await inferServiceMesh(profiles, opts)   ← see §6
  │     graphWriter.addCrossRepoEdges(meshEdges)
  │
  ├─ Step 9 — Persist the system graph
  │     graphWriter.finalize()                       ← backfill degrees, close
  │     upload system_graph.sqlite when the blob backend is remote
  │     (no SQLite driver: an in-memory ProjectGraphBuilder collects steps 3–8
  │      instead, runs Louvain, and writes system_graph_v2.json)
  │
  ├─ Step 10 — Save deleted files
  │     write <basePath>/deleted_files.json   ← changed + deleted files of previously
  │                                             indexed repos, merged into a list not yet applied
  │
  └─ Step 11 — Per-repo metadata
        for repo in reposToIndex:
          write <basePath>/<repo>/index_meta.json {
            lastIndexedSha, workingTree, lastIndexedAt, chunkCount, files: fileIndex,
            chunkIdVersion, embeddingProvider: 'pending',
            embeddingModel / embeddingDimensions: kept from the previous meta
          }
        for repo in removedRepos: delete <basePath>/<repo>/
        write index_stats.json { repos, totalChunks, crossRepoEdges, … }

returns BuildKBResult { project, repos, totalChunks, totalTokens,
                        crossRepoEdges, durationMs, chunksPath }
```

## 3. `KnowledgeIndexer.embedChunks(...)` — incremental embedding

```
embedChunks(project, config, opts):
  │
  ├─ store = storage.vectors; await init({ healCorrupt: true })
  ├─ crossRepoEdges = index_stats.json.crossRepoEdges     ← counted by buildKB
  │
  ├─ Apply deletes FIRST (ids are position-keyed — an unmoved chunk of a
  │  changed file keeps its id):
  │     deletedFiles = read(<basePath>/deleted_files.json) || []
  │     for [repoName, filePaths] in groupByRepo(deletedFiles):
  │       store.deleteFileChunks(project, repoName, filePaths)
  │
  ├─ existingIds = await store.getChunkIds(project)
  ├─ stream chunks.json (NDJSON): totals, listedIds, newChunkCount
  ├─ sweep: store.deleteChunksByIds(existingIds − listedIds)   ← skipped if chunks.json is empty
  │
  ├─ if newChunkCount === 0 && deletedFiles.length === 0:
  │      ensureFtsIndex + ensureScalarIndexes + maintainVectorIndex(rowsWritten 0)
  │      bump index_generation; return stats
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
  ├─ batchSize   = CODE_SEARCH_EMBEDDING_BATCH_SIZE  ?? (ollama ? 10 : 128)
  │  concurrency = ollama ? 1 : CODE_SEARCH_EMBEDDING_CONCURRENCY ?? 8
  │
  ├─ stream chunks.json again; new chunks → batches, `concurrency` in flight,
  │  each batch embedded into a buffer that store.addChunks appends once it
  │  holds 4,096 rows (and at the end) — one LanceDB commit per append;
  │  progress + ETA (no inter-batch delay — 429s back off inside the embedder)
  │
  ├─ ensureFtsIndex (when anything new; builds only if missing / older config)
  │  + ensureScalarIndexes + maintainVectorIndex(rowsWritten) — its optimize()
  │  folds this run's appends into the existing indexes
  ├─ clear deleted_files.json
  └─ for repoName in repoNames:
       update index_meta.json { embeddingProvider, embeddingModel,
                                embeddingDimensions, lastIndexedAt }

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
  │     (vector + bm25 used; the graph weight is unused)
  │
  ├─ filterRepos = opts.repoFilter ?? opts.repos
  │      ?? (CODE_SEARCH_AUTO_ROUTE=1 && queryRouter
  │            ? queryRouter.route(query) when strategy 'filtered'
  │            : none — search all repos)
  │  filter = `repoName IN (...)` SQL fragment
  │
  ├─ Phase 1 — parallel retrieval
  │     [vec, bm25, exact, phrase] = await Promise.all([
  │       useVector ? store.vectorSearch(emb, { limit:50, filter })  : []
  │                   └─ emb: query-embedding cache, else embedder.embedSingle
  │       useBm25   ? store.fullTextSearch(query, 50, filter)        : []
  │       bare identifier && mode !== 'vector'
  │         ? (≥3 chars ? store.searchByEntitySubstring(q, 20, filter)
  │                     : store.searchByEntityName([q], 20, filter)) : []
  │       multi-token && ≥8 chars && mode !== 'vector'
  │         ? store.phraseSearch(q, 20, filter)                       : []
  │     ])
  │
  ├─ if mode === 'vector': pack(diversifyByFile(vec)); return
  │  if mode === 'bm25':   pack(diversifyByFile(dedupe([...exact, ...phrase, ...bm25]))); return
  │
  ├─ Phase 2 — weighted RRF fusion
  │     wV = adaptiveWeights.vector ?? config.hybridWeights.vector
  │     wB = adaptiveWeights.bm25   ?? config.hybridWeights.bm25
  │     fused = reciprocalRankFusion([vec, bm25, exact, phrase], [wV, wB, 1, 1], k)
  │             score(doc) = Σ_stream weight / (k + rank);  k = CODE_SEARCH_RRF_K ?? 10
  │     fused = boostExactSymbol(fused)        ← exact entityName matches pinned first
  │     fusedPool = diversifyByFile(dedupeExactContent(fused)).slice(0, 15)
  │                 └─ ≤ CODE_SEARCH_MAX_PER_FILE (default 2) chunks per file
  │
  ├─ Phase 3 — AST expansion
  │     runs only if useGraph && graphStore && (reranker || fusedPool.length < maxChunks)
  │     seedNodeIds = resolveFusedSeeds(fused, 5)
  │           ├─ pick top fused chunks, one per file (diversify)
  │           └─ resolve <repo>::<file>::<entity> → graph node id
  │     expandedIds = tripartiteExpand(seedNodeIds)
  │           ├─ graphStore.neighborsOf(seed, 'both') — one hop, both directions,
  │           │  confidence ≥ 0.7, excluding 'contains'
  │           └─ drop module / package nodes
  │     astChunks = await store.getChunksByEntity(parsedLookups)
  │
  ├─ Phase 4 — Cross-encoder rerank
  │     candidatePool = diversifyByFile(dedupe([...fusedPool, ...astChunks]))
  │     if reranker && candidatePool.length > 1:
  │       try ranked = await reranker.rerank(query, docs, maxChunks)
  │       finalChunks = ranked.map(...)
  │       catch:    finalChunks = candidatePool   ← fall back to RRF order
  │     else finalChunks = candidatePool           ← AST chunks sit after the pool
  │
  └─ selected = packWithinBudget(finalChunks, maxTokens, maxChunks)
     return { chunks: selected, graphContext: '', totalTokens, query }
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
  ├─ Phase A — deterministic matching, per MATCH_RULE
  │     rules (edgeType / baseConfidence / threshold): kafka 0.95/0.8, http 0.85/0.6,
  │       grpc 0.95/0.8, database 0.8/0.8, redis 0.75/0.7, s3 0.8/0.8
  │     for repoA, repoB in profiles (A ≠ B; A < B for database/redis/s3):
  │       for exposed in repoA.exposes of the rule's producer type:
  │         for consumed in repoB.consumes of the consumer type
  │                         (+ repoB.exposes for database/redis/s3 — shared resources):
  │           similarity = identifierSimilarity(exposed, consumed)
  │                 └─ normalizeIdentifier: lowercase + collapse separators +
  │                    strip version + normalize path params; exact match = 1.0
  │           if similarity ≥ threshold:
  │             emit CrossRepoEdge {
  │               sourceRepo: repoA.name,        ← the exposing repo
  │               targetRepo: repoB.name,
  │               edgeType: rule.edgeType,
  │               evidence: "<A> exposes … matched with <B> … (similarity: …)",
  │               confidence: baseConfidence × similarity
  │             }
  │
  ├─ Phase B — LLM gap-fill for orphans
  │     orphans = profiles with no Phase A edge
  │     if orphans.length > 0:
  │       runLLM(orphans + their domain neighbours, SYSTEM_PROMPT)
  │       keep inferred edges with confidence ≥ 0.6 between known, distinct repos
  │       edgeType = http|kafka|grpc|database|redis|s3 when the LLM names one,
  │                  else 'llm-inferred'
  │
  └─ return [...phaseAEdges, ...phaseBEdges]
```

## 7. Cross-repo edge detection — `detectCrossRepoEdges(repos, ws)`

```
detectCrossRepoEdges(repos, workspaceMaps?)        ← src/cross-repo-detector.ts
  │
  ├─ signals = extractCrossRepoSignals(repo.path) per repo
  │     one bounded tree scan (walkFiles(dir, predicate, maxFiles=5000)) into a
  │     JSON-serializable CrossRepoSignals bundle. buildKB runs this half in the
  │     per-repo worker and persists it as <repo>/signals.json.
  │
  └─ correlateCrossRepoEdges(signals, workspaceMaps) — 14 join strategies:
       shared-npm-deps      → npm-dep
       shared-types         → shared-type
       env-var-correlation  → env-var
       event-schemas        → event-schema   (shared event / topic names)
       api-endpoints        → http           (routes ↔ HTTP clients)
       workspace-deps       → workspace-dep
       grpc-services        → grpc
       database-schemas     → database
       redis-key-patterns   → redis
       s3-buckets           → s3
       openapi-schemas      → api-contract
       docker-compose-links → http
       k8s-service-refs     → http
       shared-constants     → shared-constant

each strategy → CrossRepoEdge { sourceRepo, sourceNode, targetRepo, targetNode,
                                 edgeType, evidence, confidence }
A failing strategy is skipped; the others still run.
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
       each edge carries 'confidence' (0..1); retrieval expansion and
       trace_path follow only edges with confidence ≥ 0.7 (a flat filter)

incrementalGraphUpdate(existingGraph, changedFiles, deletedFiles, repoPath, opts):
  ├─ drop nodes whose file is in deletedFiles or changedFiles
  ├─ drop edges touching dropped nodes
  ├─ buildAstGraph subset for changedFiles (re-parse only those)
  └─ merge new nodes + edges back in
```

## 9. Project graph LLM build — `buildProjectGraph(project, opts)`

```
buildProjectGraph(project, opts):                   ← src/project-graph-builder.ts
  │                                                    (run by the CLI `graph` command)
  ├─ context = assemble:
  │     factory.yaml summary
  │     <repo>/GRAPH_REPORT.md per repo
  │     cross-repo edges (+ evidence, first 30) from the system graph store
  │       (storage.graph(): system_graph.sqlite, else system_graph_v2.json)
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
    'ollama'                → OllamaReranker (qwen2.5-coder:7b @ localhost:11434)
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
