// Feature Factory CLI — knowledge exports
// Only project-level graph and context assembly. Code search moved to @anvil-dev/code-search-mcp.

export * from './types.js';
export * from './config.js';
export { ProjectGraphBuilder } from './project-graph-builder.js';
export {
  assembleKnowledgeContext,
  assembleLayeredContext,
  assembleProjectIdentity,
  getContextLayerForStage,
  getTokenBudgetForLayer,
  formatChunkForPrompt,
} from './context-assembler.js';
export type { ContextLayer, LayeredContextConfig } from './context-assembler.js';
export {
  buildProjectGraph,
  loadProjectGraph,
  loadProjectSummary,
  getProjectGraphStatus,
  estimateProjectGraphCost,
  renderProjectSummary,
  formatProjectGraphForPrompt,
} from './project-graph-builder.js';
export { walkDir, langFromExt, extractImports, extractNamedImports, SOURCE_EXTENSIONS, SKIP_DIRS } from './file-walker.js';
