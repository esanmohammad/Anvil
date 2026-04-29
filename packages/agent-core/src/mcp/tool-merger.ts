/**
 * `buildAgentToolset` — merge built-in tools with MCP-discovered tools into a
 * single `ToolSchema[]` registered with the LLM provider, plus a dispatch
 * map from namespaced tool name → owning MCP client.
 *
 * Per ADR §H7, the provider doesn't know MCP exists; the agent layer routes
 * tool calls based on whether the name is in `mcpDispatch`.
 */

import type { ToolSchema } from '../types.js';
import type { McpAgentClient } from './client.js';

export interface AgentToolset {
  /** Flat list of tools to pass to `LanguageModel.invokeStream({ tools })`. */
  tools: ToolSchema[];
  /** Maps namespaced tool name to the MCP client that owns it. */
  mcpDispatch: Map<string, McpAgentClient>;
}

export async function buildAgentToolset(
  builtIn: ToolSchema[],
  mcpClients: McpAgentClient[],
): Promise<AgentToolset> {
  const tools: ToolSchema[] = [...builtIn];
  const mcpDispatch = new Map<string, McpAgentClient>();
  const seen = new Set(builtIn.map((t) => t.name));

  for (const client of mcpClients) {
    let mcpTools: ToolSchema[];
    try {
      mcpTools = await client.listTools();
    } catch (err) {
      process.stderr.write(
        `[anvil-mcp] WARN: server "${client.config.name}" listTools failed: ${(err as Error).message}\n`,
      );
      continue;
    }
    for (const t of mcpTools) {
      if (seen.has(t.name)) {
        process.stderr.write(
          `[anvil-mcp] WARN: tool name collision "${t.name}"; ignoring duplicate from "${client.config.name}"\n`,
        );
        continue;
      }
      tools.push(t);
      mcpDispatch.set(t.name, client);
      seen.add(t.name);
    }
  }
  return { tools, mcpDispatch };
}
