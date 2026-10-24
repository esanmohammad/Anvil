# CLAUDE.md — `@esankhan3/anvil-knowledge-core`

Guidance for Claude Code when working inside `packages/knowledge-core/`. The
shared knowledge stack consumed by `@esankhan3/anvil-cli` and
`@esankhan3/code-search-mcp`. Owns chunking, AST parsing, embeddings, vector
store, hybrid retrieval, project graph, structural hashing, repo profiling.

## What this package owns

### Chunking + walking + AST
- `chunkRepo` / `chunkChangedFiles` (`src/chunker.ts`) — code chunking with
  language-specific regex boundary patterns (no tree-sitter). Splits at
  function/class/method boundaries.
- `walkDir` / `langFromExt` / `extractImports` / `extractNamedImports`
  (`src/file-walker.ts`) — directory walker, language detection, import
  extraction.
- `initTreeSitter` / `parseFile` / `supportedLanguages`
  (`src/tree-sitter-parser.ts`) — `web-tree-sitter` WASM parsing for TS,
  JS, TSX, Go, Python, Rust, Java, PHP.
- `getAllChanges` / `getChangedFilesList` / `getDeletedFilesList`
  (`src/git-diff.ts`) — `git diff --name-status` parsing for incremental
  indexing. Returns `{ added, modified, deleted, renamed, fallbackToFull }`.

### Graph
- `buildAstGraph` / `incrementalGraphUpdate` / `generateGraphReport`
  (`src/ast-graph-builder.ts`) — per-repo entity + import graph with
  6-phase build (workspace nodes, entity extraction, import resolution,
  type refs, call disambiguation, inheritance, contains edges).
- `createSystemGraphSqliteWriter` / `openSystemGraphStore`
  (`src/graph-store.ts`) + `getGraphStore` (`src/storage/resolve.ts`) — the
  merged system graph. `buildKB` streams each repo's nodes/edges and the
  cross-repo edges into `system_graph.sqlite` (better-sqlite3, else
  `node:sqlite`); `GraphStore` serves slice queries (callers, dependencies,
  dependents, cross-repo edges, neighbors) to the retriever's graph expansion
  and the MCP graph tools. Edges keep `type` + `confidence`; cross-repo
  `evidence` is not stored.
- `ProjectGraphBuilder` (`src/project-graph-builder-core.ts`) — in-memory
  `graphology` directed multi-graph with Louvain communities; namespaces
  nodes as `<repo>::<id>`. `buildKB` uses it only when no SQLite driver
  loads (then writes `system_graph_v2.json`).
- `buildProjectGraph` / `loadProjectGraph` / `loadProjectSummary` /
  `getProjectGraphStatus` / `estimateProjectGraphCost`
  (`src/project-graph-builder.ts`) — LLM-powered semantic project graph,
  built only by the CLI `graph` command. Its cross-repo edge input comes
  from `system_graph_v2.json`, which the SQLite path doesn't write.
- `detectCrossRepoEdges` (`src/cross-repo-detector.ts`) — 14 strategies,
  split into `extractCrossRepoSignals(repoPath)` (per-repo tree scan, runs in
  the worker while the clone exists, persisted as `<repo>/signals.json`) +
  `correlateCrossRepoEdges(signals, workspaceMaps)` (pure data join — partial
  cycles correlate stored signals without cloning unchanged repos)
  for inter-repo edges (npm/workspace deps, shared types, env vars, shared
  events/topics, HTTP routes, gRPC services, DB schemas, Redis keys, S3
  buckets, OpenAPI contracts, docker-compose + k8s service refs — both
  emitted as `http` — and shared constants).
- `detectSemanticEdges` (`src/semantic-edge-detector.ts`) — LLM-inferred
  edges between repos. Exported only; `buildKB` doesn't call it.
- `findRelatedNodes` + helpers (`src/graph-query.ts`) — graph traversal.
- `graph-metrics.ts` — quality reports.

### Workspace + structural
- `detectWorkspace` / `detectTsconfigAliases` (`src/workspace-detector.ts`)
  — universal monorepo discovery via declarative manifest registry. Adds
  one ecosystem = one entry.
- `computeStructuralHash` / `computeStructuralHashes` /
  `deduplicateByStructure` (`src/structural-hasher.ts`) — canonicalize
  source (strip comments, collapse whitespace, normalize identifiers),
  SHA-256 the result. Used for dedup AND for `@anvil/memory-core` drift
  detection.

### Retrieval
- `HybridRetriever` (`src/retriever.ts`) — vector ⫽ BM25 ⫽ literal tiers
  (entityName exact/substring for bare identifiers, exact phrase for
  multi-token queries) → weighted RRF (`CODE_SEARCH_RRF_K`, default 10) +
  exact-symbol pin + dedupe + per-file cap → one-hop AST expansion →
  optional cross-encoder rerank. Expansion runs only when a reranker is
  configured or the fused pool can't fill `maxChunks`; its chunks are
  appended after the fused pool.
- `VectorStore` (`src/vector-store.ts`) — LanceDB-backed; supports
  vector + FTS search, file-level deletes, FTS index rebuild, IVF vector
  index build / in-place retrain (`ensureVectorIndex`), `vectorIndexState`.
- `maintainVectorIndex` / `planVectorIndex` / `readVectorIndexHealth`
  (`src/vector-index-maintenance.ts`) — write-path vector-index lifecycle:
  build at `minRows`, retrain once rows written since the last training
  reach `trainedRows × CODE_SEARCH_VECTOR_RETRAIN_RATIO` (default 1; 0
  disables), on an index-type config change, or once for an index with no
  training record; then `optimize()`. Records training + health
  (unindexed rows) in `vector_index.json`, surfaced via `getStats().vectorIndex`.
- `createEmbeddingProvider` (`src/embedder.ts`) — 6 providers:
  `codestral` / `voyage` / `openai` / `ollama` / `gemini-oauth` /
  `openai-compatible`, plus `auto`.
- `createReranker` (`src/reranker.ts`) — 4 providers: `ollama` (default,
  model `qwen2.5-coder:7b`), `cohere`, `voyage`, `openai-compatible`.
  `none` → `null`.
- `classifyQuery` (`src/query-classifier.ts`) — `identifier` / `path` /
  `error-code` / `natural-language` / `mixed`; returns adaptive
  `{ vector, bm25, graph }` weights (the retriever reads `vector` / `bm25`;
  `graph` is unused).
- `QueryRouter` / `createQueryRouter` (`src/query-router.ts`) — embeds
  repo profiles + query, picks `'all'` or `'filtered'` strategy. The
  retriever consults it only when `CODE_SEARCH_AUTO_ROUTE=1` (off by
  default: its hard repo pre-filter cost exact-symbol recall).

### LLM-driven
- `profileProject` / `loadProfile` / `loadAllProfiles` (`src/repo-profiler.ts`)
  — fingerprint files → LLM → `RepoProfile`. Cached by fingerprint hash.
  `buildKB` runs it only when `isLlmAvailable()`.
- `inferServiceMesh` (`src/service-mesh-inferrer.ts`) — Phase A
  deterministic endpoint matching (similarity-scored) + Phase B LLM
  gap-fill for orphan repos. `buildKB` runs it only when `isLlmAvailable()`.
- `runLLM` / `runClaude` / `runGemini` / `isLlmAvailable` /
  `resetLlmConfig` (`src/claude-runner.ts`) — **deprecated re-export**
  of `@anvil/agent-core`'s `single-shot.ts`. Kept so existing importers
  (repo-profiler, service-mesh-inferrer, rag-evaluator, indexer) keep
  working without rewrites.
- `rag-evaluator.ts` — generate answers from retrieved context, judge
  quality. Exported only; nothing in the repo calls it.

### Indexer entry points
- `KnowledgeIndexer` class (`src/indexer.ts`) — `buildKB` (chunks +
  graph + edges, no embedding) + `embedChunks` (incremental embedding)
  + `indexProject` (both).
- `discoverRepos(directoryPath)` — zero-config repo discovery (single
  git repo or scan-subdirs).
- `buildKBFromPath` / `embedFromPath` / `indexFromPath` — path-based
  facades. Each accepts an optional `config: KnowledgeConfig` in `opts`;
  when omitted, falls back to `loadKnowledgeConfig(project)`. Consumers
  (cli, dashboard, code-search-mcp) are expected to pass their fully-
  resolved config explicitly — see boundary rules in
  `docs/CODE-SEARCH-MCP-STANDALONE-PLAN.md`.
- `getRetriever(project, configOverride?)` — resolved `HybridRetriever`.
  On open, walks `<basePath>/<repo>/index_meta.json` and **hard-errors**
  if the recorded `embeddingProvider` doesn't match the resolved config's
  embedder. Pre-P2 this divergence silently returned garbage vectors.

### Config (P0–P2)
- **`KnowledgeConfig`** — typed config struct. `embedding` is a
  `EmbeddingProviderConfig` (`{provider, model?, dimensions?, apiKey?,
  baseUrl?, ollamaHost?}`), `retrieval.reranker` is a
  `RerankerProviderConfig` struct (`{provider, model?, apiKey?, baseUrl?,
  timeoutMs?}`) — back-compat: a bare string id is accepted and normalized
  via `normalizeRerankerConfig`. Provider unions
  (`EmbeddingProviderId`, `RerankerProviderId`) match the factory branches
  one-for-one (`provider-unions.test.ts` pins this).
- `loadKnowledgeConfig(project)` — yaml from
  `~/.anvil/projects/<project>/factory.yaml` (or `project.yaml`), then
  overlays `CODE_SEARCH_*` env vars via `applyEnvOverrides` (issue #6 fix,
  pinned by `env-overrides.test.ts`). Recognized env: `EMBEDDING_PROVIDER`,
  `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`, `EMBEDDING_API_KEY`,
  `EMBEDDING_BASE_URL`, `OLLAMA_HOST`, `RERANKER_PROVIDER`,
  `RERANKER_MODEL`, `RERANKER_API_KEY`, `RERANKER_BASE_URL`,
  `RETRIEVAL_MAX_CHUNKS`, `RETRIEVAL_MAX_TOKENS`, `AUTO_INDEX`.
- `cloneKnowledgeConfig(c)` — deep clone used by every override layer.
- `applyEnvOverrides(c)` — pure transformer, never mutates.
- `getKnowledgeBasePath(project)` — `CODE_SEARCH_DATA_DIR` →
  `ANVIL_HOME/knowledge-base` → `~/.anvil/knowledge-base`.
- `DEFAULT_CONFIG` — `embedding.provider='auto'`, `dimensions=1024`,
  `chunking.maxTokens=500`, `retrieval.maxChunks=8`, `maxTokens=12000`,
  `hybridWeights={vector:0.5, bm25:0.3, graph:0.2}`,
  `reranker={provider:'ollama'}` (now a struct), `autoIndex=true`.

### Provider classes — env reads are deprecated (P2)
Every embedder + reranker constructor takes `apiKey`/`baseUrl`/`ollamaHost`/
`timeoutMs` directly. The classes still fall back to documented env vars
(`MISTRAL_API_KEY`, `VOYAGE_API_KEY`, `OPENAI_API_KEY`, `COHERE_API_KEY`,
`OLLAMA_HOST`, `CODE_SEARCH_EMBEDDING_BASE_URL` / `_MODEL` / `_API_KEY`,
`CODE_SEARCH_RERANKER_BASE_URL` / `_MODEL` / `_API_KEY`,
`RERANKER_MODEL`) for one release cycle, but each first read emits a
one-shot `[knowledge-core] DEPRECATED:` stderr warning via
`deprecatedEnv()`. Library env reads are removed in 1.0; consumers must
pass credentials through the config struct.

### P6 retrieval primitives (exported, not wired)
- `bm25-tokenizers.ts` — `tokenizerFor(language)`; per-language
  tokenizers for `typescript` / `javascript` / `python` / `go` / `rust` /
  `java` / `php` capture lang-significant tokens
  (Rust `'static`, Python `__init__`, Go receivers, Java `@Annotation`,
  PHP `$variable`). Unknown languages fall through to `genericTokenize`.
- `query-expander.ts` — `expandQuery(query, classification, llm, opts)`
  returns `{queries, weights}`. HyDE-lite: skips `identifier`/`path`/
  `error-code` types unless `forceExpand`; LRU 128 / 10-min cache; uses
  any `LlmClient` adapter. `fuseRrf(rankings, weights, k=60)` merges
  expanded retrievals.
- `rerank-cache.ts` — `RerankCache` on-disk LRU keyed by
  SHA(query|chunkId|model). Default 50k entries, debounced 1s
  serialization.

None of the three is wired into `HybridRetriever` — the building blocks are
public so future surgery is local.

Public barrel: `src/index.ts`. Note: `tree-sitter-parser` re-exports are
explicit (not `*`) because it had a `computeStructuralHash` symbol that
collided with `structural-hasher`'s.

## Build + test

```sh
npm -w @esankhan3/anvil-knowledge-core run build   # tsc -b → dist/
npm -w @esankhan3/anvil-knowledge-core test        # tsc -b + node --test on dist/__tests__/
npm -w @esankhan3/anvil-knowledge-core run dev     # tsc -b --watch
```

Tests live in `src/__tests__/*.test.ts` and run from `dist/__tests__/`.

## Conventions

### Comment hygiene — delete stale comments when you touch code

Every comment must be true of the code **as it currently stands**. When a change makes a comment false, irrelevant, or obsolete, update or delete it **in the same edit** — this is not optional.
- Delete references to removed symbols / functions / files (e.g. a comment naming a deleted helper).
- Delete "this used to…", "for now / temporary", "Phase X pending", or "TODO (already done)" narration once it no longer matches reality.
- A comment describing a removed mechanism or a since-completed migration is **worse than no comment** — it actively misleads (humans and agents alike).
- History belongs in commit messages / ADRs, not in code comments. If a comment narrates the past instead of describing the present code, move it or delete it.

### Adding a new embedding provider

Implement `EmbeddingProvider` interface (`name`, `dimensions`, `embed`,
`embedSingle`) → add a class to `src/embedder.ts` → add a `case` to
`createEmbeddingProvider` → add the literal to `KnowledgeConfig.embedding.provider`.

### Adding a new reranker

Implement `Reranker` interface (`rerank`) → add a class to
`src/reranker.ts` → add a `case` to `createReranker`. Failures inside
the retriever are caught and fall back to RRF order.

### Adding a tree-sitter language

Update the WASM grammar list in `tree-sitter-parser.ts:initTreeSitter`,
add language detection to `langFromExt` in `file-walker.ts`, and
ideally add a structural-hasher comment-style entry to
`HASH_COMMENT_LANGS` / `SLASH_COMMENT_LANGS` in `structural-hasher.ts`.

### Adding a cross-repo edge type

Add an extract function (per-repo tree scan → field on `CrossRepoSignals`)
plus a correlate strategy (join over the persisted signals) inside
`cross-repo-detector.ts`. `CrossRepoEdge.edgeType` is a closed string
union — add the new value to `types.ts`.

### Incremental indexing path

`buildKB` consults `index_meta.json` for each repo. If `lastIndexedSha`
matches `git rev-parse HEAD` **and** (local checkouts) the uncommitted
working-tree state matches the `workingTree` snapshot indexed last time
(`getWorkingTreeState`: path → content hash of every file differing from
HEAD) → skip. Else, at an unchanged HEAD the change set is
`diffWorkingTreeStates(indexed, current)` (new/changed edits, plus reverted
ones re-chunked back to HEAD); after new commits it is
`getAllChanges(repo, prevSha)` plus indexed edits no longer dirty → if
non-fallback + non-empty → `chunkChangedFiles` + `incrementalGraphUpdate`;
else full re-chunk + full graph rebuild. Per-file metadata lives in
`fileIndex` inside `index_meta.json`.

`embedChunks` is independently incremental: it diffs `chunks.json`
against existing chunk IDs in LanceDB and only embeds the new ones.
Deleted and changed files are read from `deleted_files.json` (written by
`buildKB`) and their rows removed **before** the id diff — chunk ids are
`hash(filePath, startLine, endLine)`, so a changed file's unmoved chunks keep
their ids and must be wiped first to be re-embedded. The list is cleared once
an embed applies it; `buildKB` merges into a list not yet applied rather than
overwriting it. Every embed run — including one with nothing new to embed —
ends with `maintainVectorIndex` (build / due retrain / optimize); the
nothing-new path then bumps the index generation because optimize prunes old
dataset versions readers may still hold.

### Retrieval contract

`HybridRetriever.retrieve(query, opts?)`:

- `mode: 'vector'` / `'bm25'` — single-source shortcut, no fusion, no
  graph, no rerank. `'bm25'` (backs `search_exact`) puts the literal-tier
  hits ahead of the BM25 hits.
- `mode: 'vector+bm25'` / `'vector+graph'` / `'vector+bm25+graph'`
  (default) — fused pipeline; graph expansion only in the `+graph` modes.
- `repoFilter` (or `repos`) scopes the search. With neither, the query
  router filters repos only when `CODE_SEARCH_AUTO_ROUTE=1`.
- Query embedding cached for 10 min (LRU 128).
- Returns `{ chunks, graphContext, totalTokens, query }`. `graphContext`
  is always `''`.

### Project layout on disk

```
<basePath>/<project>/
  chunks.json                    # written by buildKB; consumed by embedChunks
  deleted_files.json             # incremental embed cleanup hints
  system_graph.sqlite            # merged system graph (GraphStore)
  system_graph_v2.json           # merged graph as JSON — only when no SQLite driver loads
  index_stats.json               # stats rollup read by getStats()
  index_generation               # bumped per writer run; readers reopen on change
  profile_embeddings.json        # QueryRouter cache of embedded profiles
  PROJECT_GRAPH.json             # LLM-generated semantic graph (CLI `graph` command)
  PROJECT_SUMMARY.md             # human-readable companion
  lancedb/                       # vector store
  vector_index.json              # vector-index training + health (writer-maintained)
  <repo>/
    profile.json                 # RepoProfile (cached by fingerprintHash)
    graph.json                   # per-repo AST graph
    signals.json                 # cross-repo signals, re-correlated on partial cycles
    GRAPH_REPORT.md              # quality report
    index_meta.json              # { lastIndexedSha, workingTree, lastIndexedAt, files, chunkCount, embeddingProvider }
```

## Things that don't exist (intentionally)

- No vendor LLM SDK — `runLLM` / `runClaude` / `runGemini` shim through
  to `@anvil/agent-core`'s `single-shot.ts`.
- No agentic LLM client inside knowledge-core. Anything LLM-driven
  (repo profiling, service mesh inference, RAG eval, project graph)
  goes through the deprecated `claude-runner.ts` shim → agent-core.
- No graph database server. The system graph is an embedded SQLite file
  (`system_graph.sqlite`) queried in-process; `graphology` + Louvain back
  only the no-SQLite fallback.
- No cli/mcp coupling — both consumers re-export this package's
  surface; the package itself doesn't depend on either.

## Where to look first

- Indexing flow end-to-end? `src/indexer.ts:KnowledgeIndexer.buildKB`
  is the step-by-step orchestrator.
- Retrieval end-to-end? `src/retriever.ts:HybridRetriever.retrieve` is
  the whole pipeline, ~200 LOC.
- Chunking strategy? `src/chunker.ts:chunkRepo` (regex boundary patterns
  per language).
- Cost / pricing for LLM-driven phases? Goes through agent-core's
  `cost.ts` via the runner shim.
- Provider auto-detect? `embedder.ts:createEmbeddingProvider` `case 'auto':`.

## Architecture + flow docs

- `ARCHITECTURE.md` — module map, type surface, layered design.
- `FLOW.md` — sequence diagrams: indexing, retrieval, profiling,
  service mesh, project graph generation.
