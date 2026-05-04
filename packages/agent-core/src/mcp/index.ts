/**
 * @anvil/agent-core/mcp — Model Context Protocol *client*-side helpers.
 *
 * Companion to `code-search-mcp` (which is the MCP *server* Anvil already
 * publishes). The client side lets Anvil's agent connect to OTHER MCP
 * servers configured per project.
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
export { McpAgentClient } from './client.js';
export {
  buildAgentToolset,
  type AgentToolset,
} from './tool-merger.js';
