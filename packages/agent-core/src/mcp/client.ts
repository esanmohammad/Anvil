/**
 * `McpAgentClient` — wraps the official MCP TypeScript SDK with the lifecycle
 * Anvil's agent layer needs (lazy connect, tool listing with namespacing,
 * tool dispatch, clean close).
 *
 * One instance per configured MCP server. The agent's tool-call loop owns
 * close() so subprocesses don't leak between invocations.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ToolSchema } from '../types.js';
import type { McpServerConfig } from './types.js';
import { VERSION } from '../version.js';

const CLIENT_NAME = 'anvil-agent';

export class McpAgentClient {
  private client: Client;
  private connected = false;

  constructor(public readonly config: McpServerConfig) {
    this.client = new Client(
      { name: CLIENT_NAME, version: VERSION },
      { capabilities: {} },
    );
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.config.transport === 'stdio') {
      if (!this.config.command) {
        throw new Error(
          `MCP server "${this.config.name}" has stdio transport but no command`,
        );
      }
      const transport = new StdioClientTransport({
        command: this.config.command,
        args: this.config.args ?? [],
        env: this.config.env,
      });
      await this.client.connect(transport);
    } else {
      if (!this.config.url) {
        throw new Error(
          `MCP server "${this.config.name}" has streamable-http transport but no url`,
        );
      }
      const transport = new StreamableHTTPClientTransport(new URL(this.config.url), {
        requestInit: { headers: this.config.headers },
      });
      await this.client.connect(transport);
    }
    this.connected = true;
  }

  /**
   * Returns the server's tools, namespaced as `<serverName>/<toolName>` so
   * multiple MCP servers exposing identically-named tools don't collide in
   * the agent's flat tool registry.
   */
  async listTools(): Promise<ToolSchema[]> {
    if (!this.connected) await this.connect();
    const result = await this.client.listTools();
    return result.tools.map((t) => ({
      name: `${this.config.name}/${t.name}`,
      description: t.description ?? '',
      inputSchema: (t.inputSchema as Record<string, unknown>) ?? {},
    }));
  }

  /**
   * Dispatch a tool call. Accepts either the namespaced form
   * (`<server>/<tool>`) or the bare tool name; strips the server prefix
   * before forwarding to the SDK.
   */
  async callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.connected) await this.connect();
    const prefix = `${this.config.name}/`;
    const stripped = toolName.startsWith(prefix) ? toolName.slice(prefix.length) : toolName;
    const result = await this.client.callTool({
      name: stripped,
      arguments: args,
    });
    return result;
  }

  async close(): Promise<void> {
    if (!this.connected) return;
    try {
      await this.client.close();
    } finally {
      this.connected = false;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }
}
