// @anvil/knowledge-core — shared knowledge stack public API.
//
// Phase 1: types.
// Phase 2: chunking, file-walking, AST parsing, BM25/graph primitives,
//          structural hashing, workspace detection.
// Deferred — `retriever.ts` and `graph-query.ts` stay in cli/mcp until their
//   structural deps (`vector-store`, `reranker`, `project-graph-builder`) move
//   in Phase 3 / Phase 5.

export * from './types.js';
export * from './config.js';
export * from './chunker.js';
export * from './cross-repo-detector.js';
export * from './file-walker.js';
export * from './git-diff.js';
export * from './graph-metrics.js';
export * from './query-classifier.js';
export * from './query-router.js';
export * from './semantic-edge-detector.js';
export * from './structural-hasher.js';
export * from './workspace-detector.js';

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
