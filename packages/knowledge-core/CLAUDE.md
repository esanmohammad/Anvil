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
  facades.
- `getRetriever(project)` — resolved `HybridRetriever` for a project.

### Config
- `loadKnowledgeConfig(project)` — minimal yaml parse from
  `~/.anvil/projects/<project>/factory.yaml` (or `project.yaml`).
- `getKnowledgeBasePath(project)` — `CODE_SEARCH_DATA_DIR` →
  `ANVIL_HOME/knowledge-base` → `~/.anvil/knowledge-base`.
- `DEFAULT_CONFIG` — `embedding.provider='auto'`, `dimensions=1024`,
  `chunking.maxTokens=500`, `retrieval.maxChunks=8`, `maxTokens=12000`,
  `hybridWeights={vector:0.5, bm25:0.3, graph:0.2}`, `reranker='ollama'`,
  `autoIndex=true`.

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
