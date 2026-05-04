/**
 * Provider Registry — unified discovery of all available AI providers.
 *
 * Detects CLI tools (claude, gemini) and API-key providers (OpenAI, etc.)
 * Returns models tagged with capabilities so the UI can offer the right choices.
 */

import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ── Types ────────────────────────────────────────────────────────────────

export type ProviderType = 'cli' | 'api';
export type Capability = 'agentic' | 'chat' | 'embedding' | 'reranking';

export interface ProviderInfo {
  name: string;
  displayName: string;
  type: ProviderType;
  available: boolean;
  models: ModelInfo[];
  capabilities: Capability[];
  envVar?: string;        // for API providers — which env var to set
  binary?: string;        // for CLI providers — which binary to install
  version?: string;       // detected version if available
  setupHint?: string;     // human-readable setup instruction
}

export interface ModelInfo {
  id: string;             // e.g. 'claude-sonnet-4-6', 'gpt-4o'
  displayName: string;    // e.g. 'Claude Sonnet 4.6', 'GPT-4o'
  provider: string;       // provider name
  capabilities: Capability[];
  /**
   * Rough performance/cost tier. `'local'` is the Phase 5 zero-cost tier —
   * fully on-device (Ollama). Distinguished from `'fast'` so the resolver
   * can prefer it for clarify/ship without disturbing remote-fast routing.
   */
  tier?: 'fast' | 'balanced' | 'powerful' | 'local';
}

export interface DiscoveryResult {
  providers: ProviderInfo[];
  defaultModel: string;
  defaultProvider: string;
  models: ModelInfo[];     // flat list of all models across all providers
}

// ── Detection helpers ────────────────────────────────────────────────────

function tryExec(cmd: string): string | null {
  try {
    return execSync(cmd, { timeout: 5000, stdio: 'pipe' }).toString().trim();
  } catch {
    return null;
  }
}

function hasEnv(...vars: string[]): boolean {
  return vars.some(v => !!process.env[v]);
}

// ── Provider definitions ─────────────────────────────────────────────────

function detectProviders(): ProviderInfo[] {
  const providers: ProviderInfo[] = [];

  // ── CLI Providers (agentic — can run multi-turn agent loops) ──

  // Claude CLI
  const claudeVersion = tryExec('claude --version');
  const claudeCurrentModel = tryExec('claude model');  // e.g. "claude-opus-4-7[1m]"
  // Aliases are a stable Claude CLI contract — they always resolve to the
  // current latest version. Pinned model IDs come dynamically from:
  //   1. `claude model` — user's currently-active model (authoritative)
  //   2. Anthropic Models API (if ANTHROPIC_API_KEY set) — full account list
  //   3. ~/.anvil/models.json — user overrides
  // so new Claude releases appear without code changes.
  const claudeModels: ModelInfo[] = [
    { id: 'opus', displayName: 'Claude Opus (latest)', provider: 'claude', capabilities: ['agentic', 'chat'], tier: 'powerful' },
    { id: 'sonnet', displayName: 'Claude Sonnet (latest)', provider: 'claude', capabilities: ['agentic', 'chat'], tier: 'balanced' },
    { id: 'haiku', displayName: 'Claude Haiku (latest)', provider: 'claude', capabilities: ['agentic', 'chat'], tier: 'fast' },
  ];
  if (claudeCurrentModel) {
    claudeModels.push({
      id: claudeCurrentModel,
      displayName: `${claudeCurrentModel} (current)`,
      provider: 'claude',
      capabilities: ['agentic', 'chat'],
      tier: inferTier(claudeCurrentModel),
    });
  }
  providers.push({
    name: 'claude',
    displayName: 'Claude CLI',
    type: 'cli',
    available: !!claudeVersion,
    version: claudeVersion || undefined,
    binary: 'claude',
    capabilities: ['agentic', 'chat'],
    setupHint: 'Install: npm install -g @anthropic-ai/claude-code',
    models: claudeModels,
  });

  // Gemini CLI
  const geminiVersion = tryExec('gemini --version');
  providers.push({
    name: 'gemini-cli',
    displayName: 'Gemini CLI',
    type: 'cli',
    available: !!geminiVersion,
    version: geminiVersion || undefined,
    binary: 'gemini',
    capabilities: ['agentic', 'chat'],
    setupHint: 'Install: npm install -g @anthropic-ai/gemini-cli',
    models: [
      { id: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', provider: 'gemini-cli', capabilities: ['agentic', 'chat'], tier: 'powerful' },
      { id: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', provider: 'gemini-cli', capabilities: ['agentic', 'chat'], tier: 'fast' },
    ],
  });

  // ── API Providers (chat — single prompt/response via API key) ──

  // Anthropic (Claude API key — consumed by the Claude CLI subprocess
  // when auth'd via env, and by the adk adapter for the Claude path).
  const anthropicAvailable = hasEnv('ANTHROPIC_API_KEY');
  providers.push({
    name: 'anthropic',
    displayName: 'Anthropic API',
    type: 'api',
    available: anthropicAvailable,
    envVar: 'ANTHROPIC_API_KEY',
    capabilities: ['agentic', 'chat'],
    setupHint: 'Set ANTHROPIC_API_KEY environment variable',
    models: [
      { id: 'claude-opus-4-7',           displayName: 'Claude Opus 4.7',   provider: 'anthropic', capabilities: ['chat'], tier: 'powerful' },
      { id: 'claude-sonnet-4-6',         displayName: 'Claude Sonnet 4.6', provider: 'anthropic', capabilities: ['chat'], tier: 'balanced' },
      { id: 'claude-haiku-4-5-20251001', displayName: 'Claude Haiku 4.5',  provider: 'anthropic', capabilities: ['chat'], tier: 'fast' },
    ],
  });

  // OpenAI
  const openaiAvailable = hasEnv('OPENAI_API_KEY');
  providers.push({
    name: 'openai',
    displayName: 'OpenAI',
    type: 'api',
    available: openaiAvailable,
    envVar: 'OPENAI_API_KEY',
    capabilities: ['agentic', 'chat', 'embedding'],
    setupHint: 'Set OPENAI_API_KEY environment variable',
    models: [
      { id: 'gpt-5',      displayName: 'GPT-5',      provider: 'openai', capabilities: ['chat'], tier: 'powerful' },
      { id: 'gpt-5-mini', displayName: 'GPT-5 Mini', provider: 'openai', capabilities: ['chat'], tier: 'balanced' },
      { id: 'gpt-5-nano', displayName: 'GPT-5 Nano', provider: 'openai', capabilities: ['chat'], tier: 'fast' },
      { id: 'o4-mini',    displayName: 'o4-mini',    provider: 'openai', capabilities: ['chat'], tier: 'balanced' },
    ],
  });

  // Google ADK — agentic Gemini + Anthropic via Google's Agent
  // Development Kit. Replaces the standalone `gemini` HTTP adapter for
  // the pipeline path: ADK is `tier: agentic` (full tool loop), the
  // bare HTTP adapter is `tier: function-calling` (no loop). Lights up
  // when either ANTHROPIC_API_KEY or GEMINI_API_KEY is set since ADK
  // dispatches to either family.
  const adkAvailable = hasEnv('ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY');
  providers.push({
    name: 'adk',
    displayName: 'ADK (Anthropic + Gemini)',
    type: 'api',
    available: adkAvailable,
    envVar: 'GEMINI_API_KEY',
    capabilities: ['agentic', 'chat'],
    setupHint: 'Set GEMINI_API_KEY for Gemini path, ANTHROPIC_API_KEY for Claude-via-ADK path.',
    models: [
      { id: 'adk:gemini-2.5-pro',        displayName: 'Gemini 2.5 Pro (ADK)',        provider: 'adk', capabilities: ['agentic', 'chat'], tier: 'powerful' },
      { id: 'adk:gemini-2.5-flash',      displayName: 'Gemini 2.5 Flash (ADK)',      provider: 'adk', capabilities: ['agentic', 'chat'], tier: 'balanced' },
      { id: 'adk:gemini-2.5-flash-lite', displayName: 'Gemini 2.5 Flash Lite (ADK)', provider: 'adk', capabilities: ['agentic', 'chat'], tier: 'fast' },
      { id: 'adk:claude-sonnet-4-6',     displayName: 'Claude Sonnet 4.6 (ADK)',     provider: 'adk', capabilities: ['agentic', 'chat'], tier: 'balanced' },
      { id: 'adk:claude-opus-4-7',       displayName: 'Claude Opus 4.7 (ADK)',       provider: 'adk', capabilities: ['agentic', 'chat'], tier: 'powerful' },
    ],
  });

  // OpenRouter — model menu samples each major vendor; keep slugs current.
  const openrouterAvailable = hasEnv('OPENROUTER_API_KEY');
  providers.push({
    name: 'openrouter',
    displayName: 'OpenRouter',
    type: 'api',
    available: openrouterAvailable,
    envVar: 'OPENROUTER_API_KEY',
    capabilities: ['agentic', 'chat'],
    setupHint: 'Set OPENROUTER_API_KEY environment variable',
    models: [
      { id: 'anthropic/claude-opus-4.7',   displayName: 'Claude Opus 4.7 (via OR)',   provider: 'openrouter', capabilities: ['chat'], tier: 'powerful' },
      { id: 'anthropic/claude-sonnet-4.6', displayName: 'Claude Sonnet 4.6 (via OR)', provider: 'openrouter', capabilities: ['chat'], tier: 'balanced' },
      { id: 'openai/gpt-5',                displayName: 'GPT-5 (via OR)',             provider: 'openrouter', capabilities: ['chat'], tier: 'powerful' },
      { id: 'openai/gpt-5-mini',           displayName: 'GPT-5 Mini (via OR)',        provider: 'openrouter', capabilities: ['chat'], tier: 'balanced' },
      { id: 'google/gemini-2.5-pro',       displayName: 'Gemini 2.5 Pro (via OR)',    provider: 'openrouter', capabilities: ['chat'], tier: 'powerful' },
      { id: 'google/gemini-2.5-flash',     displayName: 'Gemini 2.5 Flash (via OR)',  provider: 'openrouter', capabilities: ['chat'], tier: 'balanced' },
    ],
  });

  // OpenCode Go — agentic local-tier replacement for Ollama. Hosted
  // open coding models behind https://opencode.ai/zen/go/v1.
  const opencodeAvailable = hasEnv('OPENCODE_API_KEY');
  providers.push({
    name: 'opencode',
    displayName: 'OpenCode Go',
    type: 'api',
    available: opencodeAvailable,
    envVar: 'OPENCODE_API_KEY',
    capabilities: ['agentic', 'chat'],
    setupHint: 'Subscribe at https://opencode.ai/zen and paste the API key here. Models inherited from the local tier in ~/.anvil/models.yaml.',
    models: [
      { id: 'opencode/qwen3.5-plus', displayName: 'Qwen3.5 Plus', provider: 'opencode', capabilities: ['chat'], tier: 'fast' },
      { id: 'opencode/qwen3.6-plus', displayName: 'Qwen3.6 Plus', provider: 'opencode', capabilities: ['chat'], tier: 'fast' },
      { id: 'opencode/kimi-k2.6', displayName: 'Kimi K2.6', provider: 'opencode', capabilities: ['chat'], tier: 'balanced' },
      { id: 'opencode/glm-5.1', displayName: 'GLM-5.1', provider: 'opencode', capabilities: ['chat'], tier: 'balanced' },
      { id: 'opencode/deepseek-v4-flash', displayName: 'DeepSeek V4 Flash', provider: 'opencode', capabilities: ['chat'], tier: 'fast' },
      { id: 'opencode/deepseek-v4-pro', displayName: 'DeepSeek V4 Pro', provider: 'opencode', capabilities: ['chat'], tier: 'balanced' },
      { id: 'opencode/glm-5', displayName: 'GLM-5', provider: 'opencode', capabilities: ['chat'], tier: 'fast' },
      { id: 'opencode/kimi-k2.5', displayName: 'Kimi K2.5', provider: 'opencode', capabilities: ['chat'], tier: 'fast' },
      { id: 'opencode/minimax-m2.7', displayName: 'MiniMax M2.7', provider: 'opencode', capabilities: ['chat'], tier: 'balanced' },
      { id: 'opencode/mimo-v2.5-pro', displayName: 'MiMo V2.5 Pro', provider: 'opencode', capabilities: ['chat'], tier: 'balanced' },
    ],
  });

  // Ollama (local)
  providers.push({
    name: 'ollama',
    displayName: 'Ollama (Local)',
    type: 'api',
    available: false,  // will be updated async
    capabilities: ['agentic', 'chat', 'embedding', 'reranking'],
    setupHint: 'Install Ollama from https://ollama.ai and run: ollama serve',
    models: [],  // will be populated async
  });

  return providers;
}

// ── Async Claude model discovery ─────────────────────────────────────────

/**
 * Fetch Claude models from the Anthropic Models API.
 * Authoritative: returns whatever the user's account actually has access to.
 * Docs: https://docs.claude.com/en/api/models-list
 */
async function fetchAnthropicModels(): Promise<ModelInfo[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return [];
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const res = await fetch('https://api.anthropic.com/v1/models?limit=50', {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return [];
    const data = await res.json() as { data?: Array<{ id: string; display_name?: string }> };
    return (data.data ?? []).map(m => ({
      id: m.id,
      displayName: m.display_name || m.id,
      provider: 'claude',
      capabilities: ['agentic', 'chat'] as Capability[],
      tier: inferTier(m.id),
    }));
  } catch {
    return [];
  }
}

/** Load user-defined model IDs from ~/.anvil/models.json (highest trust source). */
function loadUserModels(providerName: string): ModelInfo[] {
  const path = join(homedir(), '.anvil', 'models.json');
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as {
      [provider: string]: Array<{ id: string; displayName?: string; tier?: 'fast' | 'balanced' | 'powerful' }>;
    };
    const entries = raw[providerName] ?? [];
    return entries.map(e => ({
      id: e.id,
      displayName: e.displayName ?? e.id,
      provider: providerName,
      capabilities: ['agentic', 'chat'] as Capability[],
      tier: e.tier ?? inferTier(e.id),
    }));
  } catch {
    return [];
  }
}

function inferTier(id: string): 'fast' | 'balanced' | 'powerful' {
  if (/haiku|flash|mini/i.test(id)) return 'fast';
  if (/opus|pro/i.test(id)) return 'powerful';
  return 'balanced';
}

/** De-duplicate models by ID, preferring entries earlier in the list. */
function dedupeModels(models: ModelInfo[]): ModelInfo[] {
  const seen = new Set<string>();
  const out: ModelInfo[] = [];
  for (const m of models) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out;
}

// ── Async Ollama detection ───────────────────────────────────────────────

async function detectOllamaModels(): Promise<{ available: boolean; models: ModelInfo[] }> {
  try {
    const host = process.env.OLLAMA_HOST || 'http://localhost:11434';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${host}/api/tags`, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) return { available: false, models: [] };

    const data = await res.json() as { models?: Array<{ name: string }> };
    const models: ModelInfo[] = (data.models || []).map(m => {
      const name = m.name.replace(':latest', '');
      const caps: Capability[] = ['chat'];
      if (name.includes('embed') || name.includes('bge')) caps.push('embedding');
      if (name.includes('qwen') || name.includes('rerank')) caps.push('reranking');
      // Phase 5: Ollama models are the local tier. Anything served from
      // localhost is zero-cost and fastest-to-first-byte for short stages.
      return {
        id: name,
        displayName: name,
        provider: 'ollama',
        capabilities: caps,
        tier: 'local' as const,
      };
    });

    return { available: true, models };
  } catch {
    return { available: false, models: [] };
  }
}

// ── Public API ───────────────────────────────────────────────────────────

let cachedResult: DiscoveryResult | null = null;
let cacheTimestamp = 0;
const CACHE_TTL = 30_000;

export async function discoverProviders(): Promise<DiscoveryResult> {
  if (cachedResult && Date.now() - cacheTimestamp < CACHE_TTL) {
    return cachedResult;
  }

  const providers = detectProviders();

  // Async: enrich Claude, OpenAI, and Ollama model lists from live sources
  const [claudeApiModels, ollama] = await Promise.all([
    fetchAnthropicModels(),
    detectOllamaModels(),
  ]);

  const claudeIdx = providers.findIndex(p => p.name === 'claude');
  if (claudeIdx >= 0) {
    const userClaude = loadUserModels('claude');
    // Order: user overrides first, then API, then aliases (from detectProviders).
    providers[claudeIdx].models = dedupeModels([
      ...userClaude,
      ...claudeApiModels,
      ...providers[claudeIdx].models,
    ]);
  }

  // Also let users extend non-Claude providers via ~/.anvil/models.json
  for (const p of providers) {
    if (p.name === 'claude') continue;
    const extra = loadUserModels(p.name);
    if (extra.length > 0) p.models = dedupeModels([...extra, ...p.models]);
  }

  const ollamaIdx = providers.findIndex(p => p.name === 'ollama');
  if (ollamaIdx >= 0) {
    providers[ollamaIdx].available = ollama.available;
    providers[ollamaIdx].models = ollama.models;
  }

  // Build flat model list
  const models: ModelInfo[] = [];
  for (const p of providers) {
    for (const m of p.models) {
      models.push(m);
    }
  }

  // Determine defaults: prefer claude CLI > gemini CLI > first available API
  let defaultModel = 'sonnet';
  let defaultProvider = 'claude';

  const claude = providers.find(p => p.name === 'claude');
  if (claude?.available) {
    defaultModel = 'sonnet';
    defaultProvider = 'claude';
  } else {
    const gemini = providers.find(p => p.name === 'gemini-cli');
    if (gemini?.available) {
      defaultModel = 'gemini-2.5-pro';
      defaultProvider = 'gemini-cli';
    } else {
      // First available API provider's first model
      const firstApi = providers.find(p => p.available && p.models.length > 0);
      if (firstApi) {
        defaultModel = firstApi.models[0].id;
        defaultProvider = firstApi.name;
      }
    }
  }

  const result: DiscoveryResult = { providers, defaultModel, defaultProvider, models };
  cachedResult = result;
  cacheTimestamp = Date.now();
  return result;
}

/** Get models that support a specific capability */
export function getModelsForCapability(result: DiscoveryResult, capability: Capability): ModelInfo[] {
  return result.models.filter(m => m.capabilities.includes(capability));
}

/** Get available agentic providers (CLI-based, for pipeline execution) */
export function getAgenticProviders(result: DiscoveryResult): ProviderInfo[] {
  return result.providers.filter(p => p.available && p.capabilities.includes('agentic'));
}

/** Resolve which provider a model ID belongs to (sync, uses cache) */
export function resolveProviderForModel(modelId: string): string | null {
  if (cachedResult) {
    const model = cachedResult.models.find(m => m.id === modelId);
    if (model) return model.provider;
  }
  return null;
}

/** Invalidate the cache (e.g., after user configures a new API key) */
export function invalidateProviderCache(): void {
  cachedResult = null;
  cacheTimestamp = 0;
}
