/**
 * `buildAgentToolset` — legacy helper that merges built-in tool schemas with
 * MCP-discovered tools into a single `ToolSchema[]` plus a dispatch map.
 *
 * Superseded by `MergedToolExecutor` for live agent paths — that class is
 * what the bridge wires into `ModelAdapterConfig.toolExecutor`. This
 * helper remains for callers that want the flat tools+dispatch shape (and
 * for backward compat with the existing test surface).
 *
 * Naming convention is `mcp__<server>__<tool>` (Claude Code convention).
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
    let mcpDescriptors;
    try {
      mcpDescriptors = await client.listTools();
    } catch (err) {
      process.stderr.write(
        `[anvil-mcp] WARN: server "${client.config.name}" listTools failed: ${(err as Error).message}\n`,
      );
      continue;
    }
    for (const desc of mcpDescriptors) {
      if (seen.has(desc.name)) {
        process.stderr.write(
          `[anvil-mcp] WARN: tool name collision "${desc.name}"; ignoring duplicate from "${client.config.name}"\n`,
        );
        continue;
      }
      tools.push(desc.schema);
      mcpDispatch.set(desc.name, client);
      seen.add(desc.name);
    }
  }
  return { tools, mcpDispatch };
}
