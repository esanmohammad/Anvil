# CLAUDE.md — `@anvil/knowledge-core`

Guidance for Claude Code when working inside `packages/knowledge-core/`. The
shared knowledge stack consumed by `@esankhan3/anvil-cli` and
`@esankhan3/code-search-mcp`. Owns chunking, AST parsing, embeddings, vector
store, hybrid retrieval, project graph, structural hashing, repo profiling.

## What this package owns

### Chunking + walking + AST
- `chunkRepo` / `chunkChangedFiles` (`src/chunker.ts`) — AST-aware code
  chunking with regex fallback. Splits at function/class/method boundaries.
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
- `ProjectGraphBuilder` (`src/project-graph-builder-core.ts`) —
  `graphology` directed multi-graph; namespaces nodes as `<repo>::<id>`,
  detects communities via Louvain.
- `buildProjectGraph` / `loadProjectGraph` / `loadProjectSummary` /
  `getProjectGraphStatus` / `estimateProjectGraphCost`
  (`src/project-graph-builder.ts`) — LLM-powered semantic project graph.
- `detectCrossRepoEdges` (`src/cross-repo-detector.ts`) — 14 strategies
  for inter-repo edges (shared types, kafka, http, grpc, db, env vars,
  npm/workspace deps, k8s, docker-compose, proto, redis, s3, shared
  constants).
- `detectSemanticEdges` (`src/semantic-edge-detector.ts`) — LLM-inferred
  edges between repos.
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
- `HybridRetriever` (`src/retriever.ts`) — 4-phase: vector ⫽ BM25 → RRF
  fusion → AST tripartite expansion → cross-encoder rerank.
- `VectorStore` (`src/vector-store.ts`) — LanceDB-backed; supports
  vector + FTS search, file-level deletes, FTS index rebuild.
- `createEmbeddingProvider` (`src/embedder.ts`) — 6 providers:
  `codestral` / `voyage` / `openai` / `ollama` / `gemini-oauth` /
  `openai-compatible`, plus `auto`.
- `createReranker` (`src/reranker.ts`) — 4 providers: `ollama` (default,
  Qwen3-Reranker), `cohere`, `voyage`, `openai-compatible`. `none` →
  `null`.
- `classifyQuery` (`src/query-classifier.ts`) — `identifier` / `path` /
  `error-code` / `natural-language` / `mixed`; returns adaptive
  `{ vector, bm25, graph }` weights.
- `QueryRouter` / `createQueryRouter` (`src/query-router.ts`) — embeds
  repo profiles + query, picks `'all'` or `'filtered'` strategy.

### LLM-driven
- `profileProject` / `loadProfile` / `loadAllProfiles` (`src/repo-profiler.ts`)
  — fingerprint files → LLM → `RepoProfile`. Cached by fingerprint hash.
- `inferServiceMesh` (`src/service-mesh-inferrer.ts`) — Phase A
  deterministic endpoint matching + Phase B LLM gap-fill.
- `runLLM` / `runClaude` / `runGemini` / `isLlmAvailable` /
  `resetLlmConfig` (`src/claude-runner.ts`) — **deprecated re-export**
  of `@anvil/agent-core`'s `single-shot.ts`. Kept so existing importers
  (repo-profiler, service-mesh-inferrer, rag-evaluator, indexer) keep
  working without rewrites.
- `rag-evaluator.ts` — generate answers from retrieved context, judge
  quality.

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

### P6 retrieval primitives (opt-in)
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
  serialization. Wiring into `HybridRetriever` is intentionally deferred —
  the building blocks are public so future surgery is local.

Public barrel: `src/index.ts`. Note: `tree-sitter-parser` re-exports are
explicit (not `*`) because it had a `computeStructuralHash` symbol that
collided with `structural-hasher`'s.

## Build + test

```sh
npm -w @anvil/knowledge-core run build       # tsc -b → dist/
npm -w @anvil/knowledge-core test            # node --test on dist/__tests__/
npm -w @anvil/knowledge-core run dev         # tsc -b --watch
```

Tests at `src/__tests__/`: chunker, query-classifier, structural-hasher,
retriever-defaults.

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

Add a strategy function inside `cross-repo-detector.ts` and call it
from `detectCrossRepoEdges`. Edge types are an open string union in
`CrossRepoEdge.edgeType` — add the new value to `types.ts`.

### Incremental indexing path

`buildKB` consults `index_meta.json` for each repo. If `lastIndexedSha`
matches `git rev-parse HEAD` → skip. Else `getAllChanges(repo, prevSha)`
→ if non-fallback + non-empty → `chunkChangedFiles` + `incrementalGraphUpdate`;
else full re-chunk + full graph rebuild. Per-file metadata lives in
`fileIndex` inside `index_meta.json`.

`embedChunks` is independently incremental: it diffs `chunks.json`
against existing chunk IDs in LanceDB and only embeds the new ones.
Deleted files are read from `deleted_files.json` (written by `buildKB`)
and removed from the store.

### Retrieval contract

`HybridRetriever.retrieve(query, opts?)`:

- `mode: 'vector'` / `'bm25'` — single-source shortcut, no fusion, no
  graph, no rerank.
- `mode: 'vector+bm25'` / `'vector+graph'` / `'vector+bm25+graph'`
  (default) — full 4-phase pipeline.
- `repoFilter` (or `repos`) overrides the query router. Otherwise the
  router decides `'all'` vs `'filtered'`.
- Query embedding cached for 10 min (LRU 128).
- Returns `{ chunks, graphContext, totalTokens, query }`. `graphContext`
  is empty when `useGraph=false`.

### Project layout on disk

```
<basePath>/<project>/
  chunks.json                    # written by buildKB; consumed by embedChunks
  deleted_files.json             # incremental embed cleanup hints
  system_graph_v2.json           # merged project graph (Graphify format)
  PROJECT_GRAPH.json             # LLM-generated semantic graph
  PROJECT_SUMMARY.md             # human-readable companion
  lancedb/                       # vector store
  <repo>/
    profile.json                 # RepoProfile (cached by fingerprintHash)
    graph.json                   # per-repo AST graph
    GRAPH_REPORT.md              # quality report
    index_meta.json              # { lastIndexedSha, lastIndexedAt, files, chunkCount, embeddingProvider }
```

## Things that don't exist (intentionally)

- No vendor LLM SDK — `runLLM` / `runClaude` / `runGemini` shim through
  to `@anvil/agent-core`'s `single-shot.ts`.
- No agentic LLM client inside knowledge-core. Anything LLM-driven
  (repo profiling, service mesh inference, RAG eval, project graph)
  goes through the deprecated `claude-runner.ts` shim → agent-core.
- No graph database. `graphology` (in-process, JS-array-backed) handles
  the project graph. Louvain for communities.
- No cli/mcp coupling — both consumers re-export this package's
  surface; the package itself doesn't depend on either.

## Where to look first

- Indexing flow end-to-end? `src/indexer.ts:KnowledgeIndexer.buildKB`
  is the 12-step orchestrator.
- Retrieval end-to-end? `src/retriever.ts:HybridRetriever.retrieve` is
  the 4-phase pipeline, ~200 LOC.
- Chunking strategy? `src/chunker.ts:chunkRepo` (AST-aware with regex
  fallback per language).
- Cost / pricing for LLM-driven phases? Goes through agent-core's
  `cost.ts` via the runner shim.
- Provider auto-detect? `embedder.ts:createEmbeddingProvider` `case 'auto':`.

## Architecture + flow docs

- `ARCHITECTURE.md` — module map, type surface, layered design.
- `FLOW.md` — sequence diagrams: indexing, retrieval, profiling,
  service mesh, project graph generation.
