/**
 * Default `AgentAdapterFactory` for `AgentManager`.
 *
 * Resolves a `SpawnConfig`'s model field to an `@anvil/agent-core`
 * `ModelAdapter` via `ProviderRegistry`, then wraps it in a
 * `LanguageModelBridge` so `AgentProcess` can drive it through the 5-event
 * `AgentAdapter` surface.
 *
 * Provider resolution heuristic:
 *   - `gemini-*` prefers the Gemini CLI when the binary is on PATH; if not,
 *     falls back to the HTTP API adapter (`gemini`).
 *   - Model ids containing `/` route to OpenRouter.
 *   - Otherwise we delegate to `ProviderRegistry.resolveFromModelId` which
 *     covers Claude / OpenAI / Gemini-API.
 */

import { execSync } from 'node:child_process';
import { trace } from '@opentelemetry/api';
import { ProviderRegistry } from '../../registry.js';
import { loadModelRegistry, type ModelRegistry } from '../../router/model-registry.js';
import type { ModelAdapter, ProviderName } from '../../types.js';
import type {
  AdapterRequest,
  AgentAdapter,
  AgentAdapterFactory,
} from './adapter.js';
import { LanguageModelBridge } from './language-model-bridge.js';
import { composeSkillContext } from '../../skills/index.js';
import { findMcpConfigPath, loadMcpServers } from '../../mcp/index.js';

// ── Provider resolution ──────────────────────────────────────────────────

export function resolveProvider(modelId: string): ProviderName {
  // User registry wins over heuristics. If models.yaml declares
  // `provider: gemini` for `gemini-2.5-flash`, honor that — don't
  // silently route to gemini-cli just because the binary is on PATH.
  const declared = lookupDeclaredProvider(modelId);
  if (declared) return declared;

  const id = modelId.toLowerCase();

  // Ollama: explicit `ollama:` prefix or `:tag` suffix common to local models
  // (e.g. `qwen2.5-coder:7b`, `llama3.1:8b`).
  if (id.startsWith('ollama:')) return 'ollama';

  // Gemini: route to the CLI when the binary is on PATH (matches user
  // intent of running `gemini` interactively). Otherwise fall through to
  // the registry's claude default — the bare HTTP `gemini` adapter is
  // `tier: function-calling` (no agentic loop) so callers must opt in
  // explicitly via `adk:gemini-…` for agentic Gemini, or use
  // `single-shot.runGemini` for the CLI single-shot path.
  if (id.startsWith('gemini-')) {
    if (geminiCliAvailable()) return 'gemini-cli';
    // No silent fallback to non-agentic gemini HTTP — fall through.
  }

  // OpenAI patterns
  if (
    id.startsWith('gpt-') ||
    id.startsWith('o1') ||
    id.startsWith('o3') ||
    id.startsWith('o4') ||
    id.startsWith('chatgpt-')
  ) {
    return 'openai';
  }

  // OpenCode Go: registry uses `opencode/<model>` to disambiguate from
  // OpenRouter's slug format. Must come BEFORE the generic slash-check.
  if (id.startsWith('opencode/')) return 'opencode';

  // Google ADK: explicit `adk:<model>` prefix (e.g. `adk:claude-sonnet-4-6`,
  // `adk:gemini-2.5-flash`). The adapter strips the prefix before
  // handing the bare model id to ADK's LLMRegistry.
  if (id.startsWith('adk:')) return 'adk';

  // OpenRouter uses `org/model` format
  if (id.includes('/')) {
    return 'openrouter';
  }

  // Local Ollama models often look like `<family>:<size>` (no slash, with tag).
  // Route through Ollama only when the daemon is reachable; otherwise fall
  // back to Claude so misconfigured runs don't break.
  if (/^[a-z0-9_.-]+:[a-z0-9_.-]+$/.test(id) && id !== 'claude' && !id.startsWith('claude-')) {
    return 'ollama';
  }

  // Claude (default)
  return 'claude';
}

// Cache the parsed user registry so repeated factory calls don't re-read +
// re-parse models.yaml from disk. Set ANVIL_MODELS_RELOAD=1 in the env to
// bypass the cache (useful when iterating on the yaml during a long-lived
// dashboard session).
let modelRegistryCache: ModelRegistry | null = null;
function lookupDeclaredProvider(modelId: string): ProviderName | null {
  if (process.env.ANVIL_MODELS_RELOAD === '1') modelRegistryCache = null;
  if (modelRegistryCache === null) {
    try {
      modelRegistryCache = loadModelRegistry();
    } catch {
      modelRegistryCache = { models: [], walker: { liveness_ttl_ms: 30000, max_attempts: 5 } };
    }
  }
  const match = modelRegistryCache.models.find((m) => m.id === modelId);
  return match?.provider ?? null;
}

// Cache the CLI probe so repeated factory calls don't fork a shell each time.
let geminiCliCached: boolean | null = null;
function geminiCliAvailable(): boolean {
  if (geminiCliCached !== null) return geminiCliCached;
  try {
    execSync('which gemini', { stdio: 'pipe', timeout: 2000 });
    geminiCliCached = true;
  } catch {
    geminiCliCached = false;
  }
  return geminiCliCached;
}

// ── Factory ──────────────────────────────────────────────────────────────

/**
 * Default factory used by `AgentManager` when no `adapterFactory` is
 * passed to its constructor. Resolves a `LanguageModelBridge` for the
 * given request via `ProviderRegistry`.
 *
 * Returned adapter is always a `LanguageModelBridge` — `AgentProcess`
 * sees the 5-event `AgentAdapter` surface; agent-core handles the actual
 * call via the registered `ModelAdapter`.
 */
export function defaultAdapterFactory(request: AdapterRequest): AgentAdapter {
  const registry = ProviderRegistry.getInstance();
  const provider = resolveProvider(request.model);
  const resolved = resolveAdapterOrFallback(registry, provider);
  // Default workspaceDir to cwd when the spawn caller didn't set one. This
  // makes skills + MCP first-class for every spawn site — dashboard, cli,
  // eval — without each caller having to opt in. Per AGENT-PROCESS-
  // CONSOLIDATION-ADR §C4 + Phase 4. Callers can explicitly pass
  // `workspaceDir: ''` (empty string is falsy) to opt out, e.g. from tests.
  const requestWithDefaults: AdapterRequest = request.workspaceDir === undefined
    ? { ...request, workspaceDir: request.cwd }
    : request;
  const enriched = enrichRequestWithWorkspace(requestWithDefaults, resolved.provider);
  return new LanguageModelBridge(enriched, resolved.adapter, resolved.provider);
}

/**
 * When `request.workspaceDir` is set, enrich the request with workspace-
 * rooted artefacts:
 *   - Non-Claude paths: compose skill context (system prompt + allowed-
 *     tools narrowing) into the request's `projectPrompt` / `allowedTools`.
 *   - Claude path: resolve the canonical `mcp.json` path so the adapter
 *     can pass `--mcp-config <path>` to claude-cli.
 *
 * Skills are NOT injected into the system prompt for the Claude path
 * because claude-cli auto-loads `.claude/skills/` itself; double-loading
 * would duplicate the bullet list. Per AGENT-PROCESS-CONSOLIDATION-ADR
 * §C5.
 *
 * Pure: returns a new `AdapterRequest` (or the original when no enrichment
 * applies).
 */
export function enrichRequestWithWorkspace(
  request: AdapterRequest,
  provider: ProviderName,
): AdapterRequest {
  if (!request.workspaceDir) return request;

  if (provider === 'claude') {
    const mcpPath = findMcpConfigPath({ workspaceRoot: request.workspaceDir });
    if (!mcpPath) return request;
    // Phase 6: surface MCP discovery on the active session span. claude-cli
    // owns the actual server connections, so we only know servers exist —
    // not how many tools they advertise.
    annotateSpanWithMcp(request.workspaceDir, { tools: undefined });
    return { ...request, claudeMcpConfigPath: mcpPath };
  }

  // Non-Claude path: inject skill block into projectPrompt + reconcile
  // allowed-tools. composeSkillContext is a no-op when no skills exist.
  const ctx = composeSkillContext(request.projectPrompt ?? '', {
    workspaceRoot: request.workspaceDir,
    allowedTools: request.allowedTools,
  });

  // Phase 6: surface skill + MCP discovery on the active session span.
  annotateSpanWithSkills(ctx.activated.skills.map((s) => s.frontmatter.name));
  annotateSpanWithMcp(request.workspaceDir, { tools: undefined });

  if (ctx.activated.skills.length === 0 && !ctx.toolsConstrained) {
    return request;
  }
  return {
    ...request,
    projectPrompt: ctx.systemPrompt || undefined,
    allowedTools: ctx.allowedTools,
  };
}

/**
 * Set `anvil.skills.activated.count` + `anvil.skills.activated.names` on
 * the active OTel span (the `anvil.agent.session` span when called from
 * inside `AgentProcess.start()`'s session context). Absence-stays-absent
 * per observability ADR §O7: when no skills load, no attribute is emitted.
 */
function annotateSpanWithSkills(activatedNames: string[]): void {
  if (activatedNames.length === 0) return;
  const span = trace.getActiveSpan();
  if (!span) return;
  span.setAttribute('anvil.skills.activated.count', activatedNames.length);
  span.setAttribute('anvil.skills.activated.names', activatedNames.join(','));
}

/**
 * Set `anvil.mcp.servers.count` (and `anvil.mcp.tools.count` when known)
 * on the active OTel span. We resolve mcp.json once here — the file read
 * is cheap, and this is the only place that knows whether MCP discovery
 * found anything for the workspace.
 */
function annotateSpanWithMcp(
  workspaceDir: string,
  meta: { tools?: number | undefined },
): void {
  const servers = loadMcpServers({ workspaceRoot: workspaceDir });
  if (servers.length === 0) return;
  const span = trace.getActiveSpan();
  if (!span) return;
  span.setAttribute('anvil.mcp.servers.count', servers.length);
  if (typeof meta.tools === 'number') {
    span.setAttribute('anvil.mcp.tools.count', meta.tools);
  }
}

/** Type alias matching `AgentAdapterFactory` — exported for explicit typing. */
export const defaultAdapterFactoryFn: AgentAdapterFactory = defaultAdapterFactory;

function resolveAdapterOrFallback(
  registry: ProviderRegistry,
  provider: ProviderName,
): { adapter: ModelAdapter; provider: ProviderName } {
  const direct = registry.get(provider);
  if (direct) return { adapter: direct, provider };

  // Claude is always registered by registerDefaults; treat as the safe fallback.
  const claude = registry.get('claude');
  if (claude) return { adapter: claude, provider: 'claude' };

  throw new Error(
    `No agent-core adapter available for provider "${provider}" and no "claude" fallback registered.`,
  );
}
