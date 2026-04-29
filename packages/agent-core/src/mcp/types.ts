/**
 * MCP client types — agent-layer abstractions over the official SDK's
 * stdio/streamable-http transports.
 *
 * See AGENT-HARNESS-ADR.md §4 for the locked mcp.json schema. Transport is
 * inferred from shape: `command` present → 'stdio'; `url` present →
 * 'streamable-http'; never both.
 */

export type McpTransport = 'stdio' | 'streamable-http';

export interface McpServerConfig {
  /** Logical name of the server (used to namespace tools as `<name>/<tool>`). */
  name: string;
  /** Inferred from {command, url} presence at parse time. */
  transport: McpTransport;
  /** stdio: spawn `command args[]` with `env`. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** streamable-http: POST to `url` with `headers`. */
  url?: string;
  headers?: Record<string, string>;
}

/** Raw shape of an `mcp.json` file. */
export interface McpServersFile {
  mcpServers: Record<string, McpServerEntry>;
}

/** Raw shape of one entry inside `mcpServers`. */
export interface McpServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}
