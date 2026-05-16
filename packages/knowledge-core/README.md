# @anvil/knowledge-core

**Your codebase, retrievable.**

A code-aware knowledge stack — AST-level chunking, hybrid retrieval,
project graphs, and cross-repo edge detection. Built so agents see
the *whole* codebase, not just the file you happened to open.

---

## The problem with grep + embeddings

Code search works one of two ways: lexical (grep, fast, dumb) or
embedding-based (vector DB, slow on edits, blind to structure). Both
miss the same thing: code has *graph* structure. A function isn't
just a chunk of text — it imports things, gets called by things,
implements things, lives in a package, talks to other repos.

**knowledge-core treats the codebase like a graph and a corpus at
the same time.** Tree-sitter parses every supported language into
AST chunks. A vector store + BM25 + a project graph all answer the
same query, fused into one ranked list. The retriever knows when
you're asking about an identifier vs an error code vs a natural-
language question and weights the signals accordingly.

```ts
import {
  indexFromPath,
  getRetriever,
  loadKnowledgeConfig,
} from '@esankhan3/anvil-knowledge-core';

// Build a fully-resolved KnowledgeConfig: YAML at
// ~/.anvil/projects/<project>/factory.yaml, overlaid by CODE_SEARCH_*
// env vars. Or hand-construct one — the indexer accepts any shape.
const config = loadKnowledgeConfig('space-tourism');

// Index once — incremental thereafter. Pass config explicitly so
// CODE_SEARCH_* env vars (provider, model, dims, API key, base URL)
// actually reach the embedder — pre-P1 they were silently ignored.
await indexFromPath('space-tourism', '/path/to/workspace', { config });

// Retrieve — vector + BM25 + 1-hop graph + cross-encoder rerank.
// Pass the same config so query-time embedder matches the index.
// getRetriever() also hard-errors on vector-space mismatch (P2) so
// silent provider drift is impossible.
const retriever = await getRetriever('space-tourism', config);
const result = await retriever.retrieve(
  'where do we validate booking seat tiers?',
);

console.log(result.chunks.length, 'chunks');     // ranked, deduped
console.log(result.graphContext);                // related symbols
console.log(result.totalTokens);                 // budgeted
```

---

## What you get

### AST-aware chunking
`tree-sitter` WASM parses TypeScript, JavaScript, TSX, Go, Python,
Rust, Java, and PHP into proper function / class / method
boundaries. No more chunks that cut a function in half. Regex
fallback for languages without a grammar so nothing is unindexed.

### Incremental by default
The indexer reads `git rev-parse HEAD`, diffs against the last
indexed SHA, and re-chunks only what changed. Deleted files get
removed from the vector store. Embedding is independently
incremental — it diffs new chunk IDs against LanceDB and only
embeds the deltas. Big repos stay fast forever.

### Hybrid retrieval, four phases
1. **Vector ⫽ BM25 in parallel** — semantic recall + lexical recall.
2. **Reciprocal Rank Fusion** — combine without one dominating.
3. **AST tripartite expansion** — pull in callers, callees, and
   type references via the project graph.
4. **Cross-encoder rerank** — Qwen3-Reranker by default; Cohere /
   Voyage / OpenAI-compatible swappable.

The query classifier picks adaptive weights — identifiers lean
BM25, natural-language leans vector, error codes lean both.

### Six embedding providers, four rerankers
**Embed:** Codestral / Mistral · Voyage · OpenAI · Ollama · Gemini OAuth
(auto-refreshes expired access tokens via `refresh_token`) ·
OpenAI-compatible / Custom · `auto` (picks based on what's configured).
**Rerank:** Ollama (default `qwen2.5-coder:7b` — qwen3:0.6b was a
silent no-op and was dropped) · Cohere · Voyage · OpenAI-compatible.
Plug in whatever fits your cost/quality/latency curve.

### Explicit config + env-override
`KnowledgeConfig` is the single contract. `EmbeddingProviderConfig`
takes `{provider, model?, dimensions?, apiKey?, baseUrl?, ollamaHost?}`;
`RerankerProviderConfig` takes `{provider, model?, apiKey?, baseUrl?,
timeoutMs?}`. `loadKnowledgeConfig(project)` reads the project YAML
then overlays `CODE_SEARCH_*` env vars (`EMBEDDING_PROVIDER` /
`_MODEL` / `_DIMENSIONS` / `_API_KEY` / `_BASE_URL` / `OLLAMA_HOST` /
`RERANKER_PROVIDER` / `_MODEL` / `_API_KEY` / `_BASE_URL` /
`RETRIEVAL_MAX_CHUNKS` / `_MAX_TOKENS` / `AUTO_INDEX`). Provider
classes still read documented vendor env vars (`MISTRAL_API_KEY`,
`OPENAI_API_KEY`, ...) as a deprecated fallback — every first read
emits a one-shot stderr warning; library env reads are removed in 1.0.

### Vector-space safety
`getRetriever(project, config?)` reads each repo's `index_meta.json`
on open. If the recorded `embeddingProvider` doesn't match the
current config, it throws a hard error — never returns garbage
vectors from a config drift. (Pre-P2, silent space mismatch was the
canonical "results are useless and there's no error" bug.)

### Project graph
A `graphology` directed multi-graph stitches every repo together.
Nodes are entities (functions, classes, types, modules), edges are
imports / calls / inheritance / contains / type-refs. Louvain
community detection clusters semantically related code so retrieval
can surface "the auth subsystem" rather than four scattered files.

### Cross-repo edge detection
Fourteen strategies covering shared types, Kafka topics, HTTP
endpoints, gRPC, databases, env vars, npm/workspace deps, k8s,
docker-compose, proto definitions, Redis, S3, and shared constants.
Plus an LLM-inferred semantic edge layer for the cases regex can't
catch.

### LLM-driven where it matters
Repo profiling (fingerprint files → LLM → typed `RepoProfile`,
cached by fingerprint hash), semantic edge inference, project
summary generation, RAG quality evaluation. All routed through
`@anvil/agent-core` so the same router, retries, and cost ledger
that power the agent stack power knowledge ingestion.

### Structural hashing
`computeStructuralHash` canonicalizes source — strips comments,
collapses whitespace, normalizes identifiers — and SHA-256s the
result. Used for chunk dedup *and* shared with `@anvil/memory-core`
so memory drift detection and chunk dedup speak the same language.

---

## Architecture at a glance

```
   git repo(s)
       │
       ▼
   ┌─────────────────────────────────────────────────────────┐
   │  Indexing                                               │
   │   walk + git diff → tree-sitter chunks → AST graph      │
   │           │              │            │                 │
   │           ▼              ▼            ▼                 │
   │     LanceDB         BM25 (FTS)    project graph         │
   │     (vectors)                     + cross-repo edges    │
   └─────────────────────────────────────────────────────────┘
                                │
                                ▼
   ┌─────────────────────────────────────────────────────────┐
   │  HybridRetriever                                        │
   │   query classifier ─▶ adaptive weights                  │
   │   vector ⫽ BM25  →  RRF  →  AST expansion  →  rerank    │
   └─────────────────────────────────────────────────────────┘
                                │
                                ▼
                       ranked chunks + graph context
```

Two consumers, one stack: `@esankhan3/anvil-cli` indexes via
`anvil index` and retrieves during pipelines;
`@esankhan3/code-search-mcp` exposes the same retriever as MCP
tools that any agent can call.

---

## Storage layout

```
~/.anvil/knowledge-base/<project>/
  chunks.json                    # canonical chunks (consumed by embedder)
  deleted_files.json             # incremental embed cleanup
  system_graph_v2.json           # merged project graph
  PROJECT_GRAPH.json             # LLM-generated semantic graph
  PROJECT_SUMMARY.md             # human-readable companion
  lancedb/                       # vector store
  <repo>/
    profile.json                 # cached RepoProfile
    graph.json                   # per-repo AST graph
    GRAPH_REPORT.md              # quality report
    index_meta.json              # { lastIndexedSha, files, chunkCount }
```

Everything is on disk, inspectable, git-friendly where it makes
sense (project graph + summary).

---

## Philosophy

**Chunks should follow code shape, not byte count.** AST boundaries
keep functions whole. Retrieval quality starts at the chunker.

**No single retrieval signal is enough.** Vector misses identifiers.
BM25 misses paraphrases. Graph misses everything text-shaped.
Hybrid + adaptive weighting is the only honest answer.

**Incremental or nothing.** Anvil indexes on every pipeline run.
A full re-index isn't acceptable; the engine treats the previous
SHA as a load-bearing input.

**No vendor lock-in.** LanceDB on disk. `graphology` in-process.
Pluggable embedders + rerankers. Swap any layer without rewriting
the rest.

**Two surfaces, one engine.** CLI users get retrieval through
pipelines; MCP users get it through tool calls. The retrieval
pipeline is the same code path.

---

## Status

Stable: chunking, AST graph, hybrid retrieval, incremental
indexing, six embedders, four rerankers, fourteen cross-repo
strategies, project graph, structural hashing. In flight: richer
graph queries and a deeper RAG-eval harness.

---

## Part of [Anvil](../../) — the AI development pipeline.
