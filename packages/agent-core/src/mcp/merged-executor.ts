/**
 * `MergedToolExecutor` — a `ToolExecutor` that exposes both the seven
 * builtin tools and every tool advertised by an `McpClientPool`. The
 * non-Claude adapters (Ollama, OpenRouter, OpenCode, OpenAI, Gemini, ADK)
 * consume this as `config.toolExecutor` and gain MCP support transparently.
 *
 * Naming convention: builtins keep their bare names (`read_file`, `bash`);
 * MCP tools are `mcp__<server>__<tool>`. The dispatch chain in `execute`
 * routes by name.
 *
 * Per-stage `allowedTools` filtering supports two forms:
 *   - exact name: `"read_file"`, `"mcp__github__create_issue"`
 *   - per-server glob: `"mcp__github__*"` matches every tool from
 *     `github` server.
 *
 * Destructive-tier guard: if a MCP tool's annotations declare
 * `destructive: true` AND the stage's allowlist doesn't explicitly name it
 * (only matched by glob), it's hidden from `listSchemas`. Stages that need
 * a destructive MCP tool must list it by full name. Prevents the model
 * from being handed `mcp__filesystem__delete_file` just because the stage
 * had `mcp__filesystem__*`.
 */
import type { ToolCall, ToolSchema } from '../types.js';
import type { ExecCtx, ToolExecutor, ToolResult } from '../tools/types.js';
import { BuiltinToolExecutor } from '../tools/builtin.js';
import type { McpClientPool } from './pool.js';
import type { McpToolDescriptor } from './client.js';

export interface MergedToolExecutorOpts {
  builtin: BuiltinToolExecutor;
  pool?: McpClientPool;
  /** Stage-policy allow list. Pass-through of `req.allowedTools`. */
  allowedTools?: string[];
  /** Surface MCP call resolution onto telemetry / activity feed. */
  onMcpCallStart?: (info: { tool: string; serverName: string }) => void;
  onMcpCallEnd?: (info: { tool: string; serverName: string; durationMs: number; isError: boolean }) => void;
}

export class MergedToolExecutor implements ToolExecutor {
  private readonly builtin: BuiltinToolExecutor;
  private readonly pool?: McpClientPool;
  private readonly allowedExact: Set<string>;
  private readonly allowedGlobs: Array<{ serverName: string }>;
  private readonly allowAllBuiltins: boolean;
  private readonly onStart?: MergedToolExecutorOpts['onMcpCallStart'];
  private readonly onEnd?: MergedToolExecutorOpts['onMcpCallEnd'];
  /** Lazily populated by `listSchemas` once MCP discovery has run. */
  private mcpDescriptors: McpToolDescriptor[] | null = null;

  constructor(opts: MergedToolExecutorOpts) {
    this.builtin = opts.builtin;
    this.pool = opts.pool;
    this.onStart = opts.onMcpCallStart;
    this.onEnd = opts.onMcpCallEnd;
    const allowed = opts.allowedTools ?? [];
    this.allowedExact = new Set();
    this.allowedGlobs = [];
    this.allowAllBuiltins = allowed.length === 0;
    for (const name of allowed) {
      if (name.endsWith('__*') && name.startsWith('mcp__')) {
        const serverName = name.slice('mcp__'.length, -3);
        if (serverName.length > 0) this.allowedGlobs.push({ serverName });
      } else {
        this.allowedExact.add(name);
      }
    }
  }

  /**
   * Returns the union of builtin + MCP tool schemas, filtered by the
   * stage's allowlist. Builtin filtering is delegated to BuiltinToolExecutor
   * (which was already wired with `allowedTools`); MCP filtering happens
   * here.
   *
   * NOTE: synchronous; reads the pool's cached tool list. Callers MUST
   * call `prime()` once (awaitable) before the first `listSchemas` so MCP
   * discovery has completed. After that the cache is hot.
   */
  listSchemas(): ToolSchema[] {
    const out: ToolSchema[] = [...this.builtin.listSchemas()];
    if (!this.mcpDescriptors) return out;
    for (const desc of this.mcpDescriptors) {
      if (!this.allowedForListing(desc)) continue;
      out.push(desc.schema);
    }
    return out;
  }

  /** Warm the MCP tool cache so a later sync `listSchemas` is complete. */
  async prime(): Promise<void> {
    if (!this.pool || this.mcpDescriptors) return;
    this.mcpDescriptors = await this.pool.discoverTools();
  }

  async execute(call: ToolCall, ctx: ExecCtx): Promise<ToolResult> {
    if (!call.name.startsWith('mcp__')) {
      // Builtin path — BuiltinToolExecutor enforces its own allowlist.
      return this.builtin.execute(call, ctx);
    }
    if (!this.pool) {
      return {
        isError: true,
        content: `Tool "${call.name}" requires an MCP server but no pool is configured.`,
      };
    }
    if (!this.allowedForExec(call.name)) {
      return {
        isError: true,
        content: `Tool "${call.name}" is not permitted in this stage.`,
      };
    }
    const serverName = ownerFor(call.name);
    if (!serverName) {
      return { isError: true, content: `Cannot parse MCP server from "${call.name}".` };
    }
    const started = Date.now();
    this.onStart?.({ tool: call.name, serverName });
    try {
      const result = await this.pool.callTool(call.name, call.arguments ?? {}, ctx.abortSignal);
      const flattened = flattenMcpContent(result);
      this.onEnd?.({
        tool: call.name,
        serverName,
        durationMs: Date.now() - started,
        isError: flattened.isError,
      });
      return flattened;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.onEnd?.({
        tool: call.name,
        serverName,
        durationMs: Date.now() - started,
        isError: true,
      });
      return { isError: true, content: `MCP call failed: ${message}` };
    }
  }

  // ── Filter logic ───────────────────────────────────────────────────────

  /** Show this descriptor at schema time? Apply destructive guard. */
  private allowedForListing(desc: McpToolDescriptor): boolean {
    // Exact-match wins regardless of destructive flag.
    if (this.allowedExact.has(desc.name)) return true;
    if (this.allowAllBuiltins && !desc.annotations.destructive) {
      // Empty allowlist means read-only fallback per BuiltinToolExecutor;
      // mirror that for MCP tools so they aren't surfaced by default.
      return false;
    }
    const matchesGlob = this.allowedGlobs.some((g) => g.serverName === desc.serverName);
    if (!matchesGlob) return false;
    // Glob match: hide destructive tools unless the stage names them
    // explicitly.
    if (desc.annotations.destructive) return false;
    return true;
  }

  /** Allow this name at exec time? Defense-in-depth check vs listing. */
  private allowedForExec(name: string): boolean {
    if (this.allowAllBuiltins) {
      // Match the listing default for empty allowlist.
      return false;
    }
    if (this.allowedExact.has(name)) return true;
    const owner = ownerFor(name);
    if (!owner) return false;
    if (!this.allowedGlobs.some((g) => g.serverName === owner)) return false;
    // Glob path: re-fetch annotations to gate destructive tools.
    const desc = this.mcpDescriptors?.find((d) => d.name === name);
    if (desc?.annotations.destructive) return false;
    return true;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

function ownerFor(toolName: string): string | undefined {
  if (!toolName.startsWith('mcp__')) return undefined;
  // mcp__<server>__<tool>; server may contain underscores. We split on the
  // FIRST `__` after the prefix that's followed by a tool name with no
  // `__`. Simpler: match `mcp__([^_]+(?:_[^_]+)*)__`.
  const rest = toolName.slice('mcp__'.length);
  // Look for the LAST `__` so the server name eats the rest.
  const idx = rest.lastIndexOf('__');
  if (idx < 0) return undefined;
  return rest.slice(0, idx);
}

/**
 * Collapse the MCP SDK's structured `content[]` result into the
 * `ToolResult` shape the builtin executor uses. Text parts concatenate;
 * image / resource parts surface as `[image: <mime>]` placeholders so the
 * model isn't fed binary garbage.
 */
function flattenMcpContent(raw: unknown): ToolResult {
  if (!raw || typeof raw !== 'object') {
    return { isError: false, content: String(raw ?? '') };
  }
  const r = raw as {
    content?: Array<{ type?: string; text?: string; data?: string; mimeType?: string }>;
    isError?: boolean;
    structuredContent?: unknown;
  };
  const parts: string[] = [];
  if (Array.isArray(r.content)) {
    for (const block of r.content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      } else if (block.type === 'image') {
        parts.push(`[image: ${block.mimeType ?? 'unknown'}]`);
      } else if (block.type === 'resource') {
        parts.push(`[resource]`);
      } else {
        parts.push(`[${block.type ?? 'unknown'}]`);
      }
    }
  }
  if (parts.length === 0 && r.structuredContent !== undefined) {
    try { parts.push(JSON.stringify(r.structuredContent)); } catch { /* ok */ }
  }
  return {
    isError: r.isError === true,
    content: parts.join('\n').trim() || '(empty)',
  };
}
