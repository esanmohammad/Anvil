// @esankhan3/anvil-knowledge-core — shared knowledge stack public API.
//
// Phase 1: types.
// Phase 2: chunking, file-walking, AST parsing, BM25/graph primitives,
//          structural hashing, workspace detection.
// Phase 3: embedders, vector store, reranker (mild-drift bucket — mcp was
//          canonical, both consumers gain the OpenAI-compatible / custom
//          provider classes).
// Deferred — `retriever.ts` and `graph-query.ts` stay in cli/mcp until
//   `project-graph-builder.ts` moves in Phase 5. (`vector-store` + `reranker`
//   landed here in Phase 3, removing two of the three blockers.)

export * from './types.js';
export * from './config.js';
export * from './chunker.js';
export * from './chunks-io.js';
export * from './cross-repo-detector.js';
export * from './file-walker.js';
export * from './git-diff.js';
export * from './graph-metrics.js';
export * from './query-classifier.js';
export * from './query-router.js';
export * from './query-expander.js';
export * from './bm25-tokenizers.js';
export * from './rerank-cache.js';
export * from './semantic-edge-detector.js';
export * from './structural-hasher.js';
export * from './workspace-detector.js';
export * from './embedder.js';
export * from './vector-store.js';
export * from './reranker.js';
export * from './claude-runner.js';
export * from './repo-profiler.js';
export * from './service-mesh-inferrer.js';
export * from './rag-evaluator.js';
export * from './ast-graph-builder.js';
// project-graph-builder.ts re-exports the class from project-graph-builder-core.ts,
// so a single barrel entry covers both modules without duplicate-name conflicts.
export * from './project-graph-builder.js';
export * from './retriever.js';
export * from './graph-query.js';
export * from './indexer.js';

// `tree-sitter-parser` exports a `computeStructuralHash` that collides with
// `structural-hasher`'s function of the same name (different signatures, used
// for different purposes). Re-export tree-sitter's public API explicitly to
// drop the colliding symbol; consumers needing it can import the file directly.
export {
  initTreeSitter,
  parseFile,
  parseFiles,
  supportedLanguages,
} from './tree-sitter-parser.js';
export type {
  TreeSitterEntity,
  TreeSitterImport,
  TreeSitterCallSite,
  FileParseResult,
} from './tree-sitter-parser.js';
