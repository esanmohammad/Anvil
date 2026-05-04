// Feature Factory CLI — knowledge exports
// Only project-level graph and context assembly. Code search moved to @anvil-dev/code-search-mcp.

export * from '@anvil/knowledge-core';
export * from '@anvil/knowledge-core';
export { ProjectGraphBuilder } from '@anvil/knowledge-core';
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
} from '@anvil/knowledge-core';
export { walkDir, langFromExt, extractImports, extractNamedImports, SOURCE_EXTENSIONS, SKIP_DIRS } from '@anvil/knowledge-core';
