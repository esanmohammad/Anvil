/**
 * `McpClientPool` — workspace-scoped, session-lifetime pool of
 * `McpAgentClient`s.
 *
 * Lifecycle owned by `AgentProcess` so resume turns reuse already-connected
 * servers instead of re-paying the 250–1000 ms connect cost per turn. Each
 * client is lazy-connected on first need; failures are logged + that server
 * is dropped from the pool (not propagated as a spawn failure — one sick
 * MCP shouldn't poison the run).
 *
 * Reconnect-on-EOF: if a stdio server crashes mid-session, the next tool
 * call attempts to reconnect once before surfacing the error to the model.
 */
import { McpAgentClient, type McpToolDescriptor, type McpProgressEvent } from './client.js';
import { loadMcpServers, type LoadMcpServersOptions } from './config-loader.js';
import type { McpServerConfig } from './types.js';

export interface McpClientPoolOpts {
  /** Workspace root used to resolve `mcp.json` discovery. */
  workspaceRoot?: string;
  /** Pre-resolved server configs — bypasses `loadMcpServers`. Test seam. */
  servers?: McpServerConfig[];
  /** Per-call deadline for `connect()` on each server. Defaults to 5 s. */
  connectTimeoutMs?: number;
  /** Optional run id forwarded to each client for stderr log naming. */
  runId?: string;
  /** Forwarded to every client constructed by the pool. */
  onProgress?: (ev: McpProgressEvent) => void;
  /** Test seam — override the loader. */
  loader?: typeof loadMcpServers;
}

export class McpClientPool {
  private readonly opts: McpClientPoolOpts;
  private readonly clients = new Map<string, McpAgentClient>();
  /** Tools discovered + cached. Refreshed on first call after reconnect. */
  private toolsCache: McpToolDescriptor[] | null = null;
  private discovering: Promise<McpToolDescriptor[]> | null = null;
  private closed = false;
  /** Names of servers that failed to connect + the reason — surfaced to
   *  diagnostics so the dashboard activity panel can show "github-mcp
   *  failed to connect: ECONNREFUSED". */
  readonly failures: Array<{ server: string; reason: string }> = [];

  constructor(opts: McpClientPoolOpts) {
    this.opts = opts;
    const servers = opts.servers ?? this.loadConfig();
    for (const cfg of servers) {
      this.clients.set(
        cfg.name,
        new McpAgentClient(cfg, {
          runId: opts.runId,
          onProgress: opts.onProgress,
        }),
      );
    }
  }

  private loadConfig(): McpServerConfig[] {
    const loaderOpts: LoadMcpServersOptions = { workspaceRoot: this.opts.workspaceRoot };
    const fn = this.opts.loader ?? loadMcpServers;
    try {
      return fn(loaderOpts);
    } catch (err) {
      this.failures.push({ server: '<config>', reason: (err as Error).message });
      return [];
    }
  }

  /** True iff at least one server is configured (regardless of liveness). */
  hasServers(): boolean {
    return this.clients.size > 0;
  }

  /**
   * Connect every configured server in parallel, with a per-server
   * timeout. Servers that fail to connect are removed from the pool and
   * recorded in `failures` — they cannot serve tools but the run continues.
   * Returns the union of tool descriptors from connected servers.
   */
  async discoverTools(): Promise<McpToolDescriptor[]> {
    if (this.closed) return [];
    if (this.toolsCache) return this.toolsCache;
    if (this.discovering) return this.discovering;
    this.discovering = this._discoverTools().finally(() => { this.discovering = null; });
    return this.discovering;
  }

  private async _discoverTools(): Promise<McpToolDescriptor[]> {
    const timeout = this.opts.connectTimeoutMs ?? 5000;
    const results = await Promise.allSettled(
      Array.from(this.clients.entries()).map(async ([name, client]) => {
        try {
          await Promise.race([
            client.connect(),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error(`connect timed out after ${timeout}ms`)), timeout),
            ),
          ]);
          return await client.listTools();
        } catch (err) {
          this.failures.push({ server: name, reason: (err as Error).message });
          // Drop the client — it's unusable. listTools() may throw because
          // the connect failed too.
          this.clients.delete(name);
          try { await client.close(); } catch { /* ok */ }
          return [];
        }
      }),
    );
    const tools: McpToolDescriptor[] = [];
    for (const r of results) {
      if (r.status === 'fulfilled') tools.push(...r.value);
    }
    this.toolsCache = tools;
    return tools;
  }

  /**
   * Dispatch a namespaced (`mcp__<server>__<tool>`) call. Returns the
   * SDK's raw result for the merged executor to flatten. Throws when the
   * server isn't connected and reconnect fails — caller wraps as a tool
   * error so the model can recover.
   */
  async callTool(
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.closed) throw new Error('McpClientPool is closed');
    const owner = this.findOwner(toolName);
    if (!owner) throw new Error(`No MCP server owns "${toolName}"`);
    const client = this.clients.get(owner);
    if (!client) throw new Error(`MCP server "${owner}" is unavailable`);
    try {
      return await client.callTool(toolName, args, signal);
    } catch (err) {
      // EOF on stdio = server died. Try to reconnect once + replay.
      const msg = (err as Error).message ?? '';
      if (/closed|EPIPE|ECONNRESET|connection.*lost|EOF/i.test(msg)) {
        try {
          await client.close();
          await client.connect();
          this.toolsCache = null; // tool list may have changed
          return await client.callTool(toolName, args, signal);
        } catch (reconnectErr) {
          this.failures.push({
            server: owner,
            reason: `reconnect failed: ${(reconnectErr as Error).message}`,
          });
          this.clients.delete(owner);
          throw reconnectErr;
        }
      }
      throw err;
    }
  }

  /** Abort every in-flight tool call across every client. */
  cancelInFlight(reason?: string): void {
    for (const c of this.clients.values()) {
      try { c.cancelInFlight(reason); } catch { /* ok */ }
    }
  }

  /** Close every client. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.cancelInFlight('pool closing');
    await Promise.allSettled(
      Array.from(this.clients.values()).map((c) => c.close()),
    );
    this.clients.clear();
    this.toolsCache = null;
  }

  /** Find the owning server name for a `mcp__<server>__<tool>` id. */
  private findOwner(toolName: string): string | undefined {
    // Format: mcp__<server>__<tool>. Server names may themselves contain
    // underscores so we resolve by longest matching prefix.
    if (!toolName.startsWith('mcp__')) return undefined;
    const candidates = Array.from(this.clients.keys()).sort((a, b) => b.length - a.length);
    for (const name of candidates) {
      if (toolName.startsWith(`mcp__${name}__`)) return name;
    }
    return undefined;
  }
}
