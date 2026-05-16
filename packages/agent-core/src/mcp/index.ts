/**
 * @esankhan3/anvil-agent-core/mcp — Model Context Protocol *client*-side helpers.
 *
 * Companion to `code-search-mcp` (which is the MCP *server* Anvil already
 * publishes). The client side lets Anvil's agent connect to OTHER MCP
 * servers configured per project — surfacing their tools to non-Claude
 * adapters too via `MergedToolExecutor`.
 */
export type {
  McpTransport,
  McpServerConfig,
  McpServerEntry,
  McpServersFile,
} from './types.js';
export {
  loadMcpServers,
  findMcpConfigPath,
  type LoadMcpServersOptions,
} from './config-loader.js';
export {
  McpAgentClient,
  mcpToolName,
  MCP_NAME_PREFIX,
  type McpClientOpts,
  type McpToolDescriptor,
  type McpToolAnnotations,
  type McpProgressEvent,
} from './client.js';
export {
  buildAgentToolset,
  type AgentToolset,
} from './tool-merger.js';
export {
  McpClientPool,
  type McpClientPoolOpts,
} from './pool.js';
export {
  MergedToolExecutor,
  type MergedToolExecutorOpts,
} from './merged-executor.js';
