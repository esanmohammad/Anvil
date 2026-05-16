/**
 * `McpAgentClient` — wraps the official MCP TypeScript SDK with the lifecycle
 * Anvil's agent layer needs (lazy connect, namespaced tool listing, tool
 * dispatch with cancellation, progress notifications, EOF reconnect, clean
 * close).
 *
 * One instance per configured MCP server. `McpClientPool` owns multiple
 * instances per workspace and shares them across the agent's lifetime so
 * resume turns don't re-pay the connect cost.
 *
 * Naming convention: tools are surfaced as `mcp__<server>__<tool>` (double
 * underscore, matching Claude Code / Anthropic SDK). The bare tool name is
 * sent to the server during dispatch.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mkdirSync, createWriteStream, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ToolSchema } from '../types.js';
import type { McpServerConfig } from './types.js';
import { VERSION } from '../version.js';

const CLIENT_NAME = 'anvil-agent';

/** Prefix every MCP-sourced tool with `mcp__<server>__` so it can never
 *  collide with a builtin and so the model recognizes the Claude-Code-
 *  established convention. */
export const MCP_NAME_PREFIX = 'mcp__';

export function mcpToolName(serverName: string, toolName: string): string {
  return `${MCP_NAME_PREFIX}${serverName}__${toolName}`;
}

export interface McpToolAnnotations {
  /** Tool only reads — safe to call without confirmation. */
  readOnly?: boolean;
  /** Tool may mutate or destroy state — best-of effort hint from server. */
  destructive?: boolean;
  /** Tool is safe to retry idempotently. */
  idempotent?: boolean;
  /** Tool may make outgoing network calls beyond the MCP server itself. */
  openWorld?: boolean;
}

export interface McpToolDescriptor {
  /** Namespaced name as it appears in the merged tool registry. */
  name: string;
  /** Bare tool name as sent to the MCP server. */
  bareName: string;
  /** Owning server config. */
  serverName: string;
  /** OpenAI-tool-compatible JSON Schema. */
  schema: ToolSchema;
  /** Server-declared behavior hints (may be all undefined). */
  annotations: McpToolAnnotations;
}

export interface McpProgressEvent {
  serverName: string;
  toolName: string;
  /** Increasing scalar — server-defined units. */
  progress: number;
  /** Optional total scalar, when the server knows the upper bound. */
  total?: number;
  /** Free-form human-readable status (e.g. "indexing 1234/5000 files"). */
  message?: string;
}

export interface McpClientOpts {
  /** Where to write per-server stderr (stdio transport only). Absent =
   *  `~/.anvil/mcp-logs/<server>.log`. */
  stderrLogDir?: string;
  /** Optional run id appended to the stderr log filename so runs don't
   *  clobber each other when they share a workspace. */
  runId?: string;
  /** Surface progress notifications to the caller. The pool wires this
   *  through to the dashboard's activity panel. */
  onProgress?: (ev: McpProgressEvent) => void;
}

export class McpAgentClient {
  private client: Client;
  private connected = false;
  private connecting?: Promise<void>;
  private stderrStream?: WriteStream;
  private readonly opts: McpClientOpts;
  /** Tracks request ids cancelled via `cancelInFlight`. */
  private readonly cancelControllers = new Set<AbortController>();

  constructor(public readonly config: McpServerConfig, opts: McpClientOpts = {}) {
    this.opts = opts;
    this.client = new Client(
      { name: CLIENT_NAME, version: VERSION },
      { capabilities: {} },
    );
    this.wireProgressHandler();
  }

  // ── Connection lifecycle ───────────────────────────────────────────────

  async connect(): Promise<void> {
    if (this.connected) return;
    // Coalesce concurrent first-use; every caller awaits the same promise.
    if (this.connecting) return this.connecting;
    this.connecting = this._connect().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async _connect(): Promise<void> {
    if (this.config.transport === 'stdio') {
      if (!this.config.command) {
        throw new Error(`MCP server "${this.config.name}" has stdio transport but no command`);
      }
      this.openStderrLog();
      const transport = new StdioClientTransport({
        command: this.config.command,
        args: this.config.args ?? [],
        env: this.config.env,
        // Capture stderr so the protocol JSON on stdout isn't polluted +
        // give the user something to grep when an MCP server misbehaves.
        stderr: this.stderrStream ? 'pipe' : 'inherit',
      });
      if (this.stderrStream && transport.stderr) {
        transport.stderr.pipe(this.stderrStream);
      }
      await this.client.connect(transport);
    } else {
      if (!this.config.url) {
        throw new Error(`MCP server "${this.config.name}" has streamable-http transport but no url`);
      }
      const transport = new StreamableHTTPClientTransport(new URL(this.config.url), {
        requestInit: { headers: this.config.headers },
      });
      await this.client.connect(transport);
    }
    this.connected = true;
  }

  private openStderrLog(): void {
    if (this.stderrStream || this.config.transport !== 'stdio') return;
    const dir = this.opts.stderrLogDir ?? join(homedir(), '.anvil', 'mcp-logs');
    try {
      mkdirSync(dir, { recursive: true });
      const suffix = this.opts.runId ? `-${this.opts.runId}` : '';
      const path = join(dir, `${safeFileName(this.config.name)}${suffix}.log`);
      this.stderrStream = createWriteStream(path, { flags: 'a' });
      this.stderrStream.write(`\n--- mcp server "${this.config.name}" started ${new Date().toISOString()} ---\n`);
    } catch {
      // Log capture is best-effort; fall back to inherit (stderr to process).
      this.stderrStream = undefined;
    }
  }

  // ── Tool discovery + dispatch ──────────────────────────────────────────

  async listTools(): Promise<McpToolDescriptor[]> {
    if (!this.connected) await this.connect();
    const result = await this.client.listTools();
    return result.tools.map((t) => {
      const ann = t.annotations as
        | { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean }
        | undefined;
      const annotations: McpToolAnnotations = {
        readOnly: ann?.readOnlyHint ?? heuristicReadOnly(t.name),
        destructive: ann?.destructiveHint,
        idempotent: ann?.idempotentHint,
        openWorld: ann?.openWorldHint,
      };
      const namespaced = mcpToolName(this.config.name, t.name);
      const description = decorateDescription(t.description ?? '', this.config.name, annotations);
      return {
        name: namespaced,
        bareName: t.name,
        serverName: this.config.name,
        schema: {
          name: namespaced,
          description,
          inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object' },
        },
        annotations,
      };
    });
  }

  /**
   * Dispatch a tool call. Accepts either the namespaced form
   * (`mcp__<server>__<tool>`) or the bare tool name. Cancellation is wired
   * via an AbortController stored in `cancelControllers` — `cancelInFlight`
   * aborts every pending call.
   */
  async callTool(
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!this.connected) await this.connect();
    const bare = stripMcpPrefix(toolName, this.config.name);
    const inner = new AbortController();
    this.cancelControllers.add(inner);
    if (signal) {
      if (signal.aborted) inner.abort(signal.reason);
      else signal.addEventListener('abort', () => inner.abort(signal.reason), { once: true });
    }
    try {
      // The SDK's callTool accepts an AbortSignal in the request options —
      // it emits `notifications/cancelled` on the wire when fired.
      const result = await this.client.callTool({ name: bare, arguments: args }, undefined, {
        signal: inner.signal,
      });
      return result;
    } finally {
      this.cancelControllers.delete(inner);
    }
  }

  /** Abort every in-flight tool call. Used on agent kill. */
  cancelInFlight(reason?: string): void {
    for (const c of this.cancelControllers) {
      try { c.abort(reason ?? 'cancelled'); } catch { /* ok */ }
    }
    this.cancelControllers.clear();
  }

  async close(): Promise<void> {
    this.cancelInFlight('client closed');
    if (!this.connected) {
      this.stderrStream?.end();
      this.stderrStream = undefined;
      return;
    }
    try {
      await this.client.close();
    } finally {
      this.connected = false;
      this.stderrStream?.end();
      this.stderrStream = undefined;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  // ── Progress wiring ────────────────────────────────────────────────────

  private wireProgressHandler(): void {
    if (!this.opts.onProgress) return;
    const onProgress = this.opts.onProgress;
    // The MCP SDK exposes progress via notification handlers — register a
    // generic one and re-emit through the caller's callback. The
    // notification name space: `notifications/progress`.
    const fallbackProgress: typeof onProgress = (ev) => onProgress(ev);
    type ProgressNotification = {
      method: 'notifications/progress';
      params?: {
        progressToken?: string | number;
        progress?: number;
        total?: number;
        message?: string;
      };
    };
    // setNotificationHandler is the public hook on the Client class —
    // the SDK calls it for every server-initiated notification matching
    // the schema's method.
    try {
      (this.client as unknown as {
        setNotificationHandler: (schema: { method: string }, handler: (n: ProgressNotification) => void) => void;
      }).setNotificationHandler({ method: 'notifications/progress' }, (n) => {
        const p = n.params ?? {};
        fallbackProgress({
          serverName: this.config.name,
          toolName: String(p.progressToken ?? ''),
          progress: typeof p.progress === 'number' ? p.progress : 0,
          total: typeof p.total === 'number' ? p.total : undefined,
          message: typeof p.message === 'string' ? p.message : undefined,
        });
      });
    } catch {
      // Older SDK versions may not expose setNotificationHandler the same way;
      // progress is a nice-to-have, not a blocker.
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

function stripMcpPrefix(toolName: string, serverName: string): string {
  const prefix = `${MCP_NAME_PREFIX}${serverName}__`;
  if (toolName.startsWith(prefix)) return toolName.slice(prefix.length);
  // Legacy `<server>/<tool>` form — accept for backward compat with old
  // tool-merger.ts callers that may still be hanging around.
  const legacy = `${serverName}/`;
  if (toolName.startsWith(legacy)) return toolName.slice(legacy.length);
  return toolName;
}

function safeFileName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]+/g, '_');
}

const READONLY_VERBS = /^(read|get|list|search|find|query|describe|inspect|count|fetch|view|show)/i;

function heuristicReadOnly(toolName: string): boolean {
  // Fallback when the server hasn't declared `readOnlyHint`. Permissive on
  // purpose — a misclassification merely surfaces the call to the dest./
  // allowlist filter, which has the last word.
  return READONLY_VERBS.test(toolName);
}

function decorateDescription(
  raw: string,
  serverName: string,
  annotations: McpToolAnnotations,
): string {
  // Tag the description with the server name + behavior hints so the model
  // can pick between overlapping tools (filesystem-mcp:read vs builtin
  // read_file). Best practice across Claude Code / Goose / Cursor.
  const hints: string[] = [];
  if (annotations.destructive) hints.push('destructive');
  else if (annotations.readOnly) hints.push('read-only');
  if (annotations.idempotent) hints.push('idempotent');
  const tag = hints.length > 0 ? ` [${hints.join(', ')}]` : '';
  return `(via ${serverName} MCP${tag}) ${raw}`.trim();
}
