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
  tier?: 'fast' | 'balanced' | 'powerful';  // rough performance tier
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

  // OpenAI
  const openaiAvailable = hasEnv('OPENAI_API_KEY');
  providers.push({
    name: 'openai',
    displayName: 'OpenAI',
    type: 'api',
    available: openaiAvailable,
    envVar: 'OPENAI_API_KEY',
    capabilities: ['chat', 'embedding'],
    setupHint: 'Set OPENAI_API_KEY environment variable',
    models: [
      { id: 'gpt-4o', displayName: 'GPT-4o', provider: 'openai', capabilities: ['chat'], tier: 'powerful' },
      { id: 'gpt-4o-mini', displayName: 'GPT-4o Mini', provider: 'openai', capabilities: ['chat'], tier: 'fast' },
      { id: 'o3-mini', displayName: 'o3-mini', provider: 'openai', capabilities: ['chat'], tier: 'balanced' },
    ],
  });

  // Gemini API
  const geminiApiAvailable = hasEnv('GOOGLE_API_KEY', 'GEMINI_API_KEY');
  providers.push({
    name: 'gemini-api',
    displayName: 'Gemini API',
    type: 'api',
    available: geminiApiAvailable,
    envVar: 'GOOGLE_API_KEY',
    capabilities: ['chat', 'embedding'],
    setupHint: 'Set GOOGLE_API_KEY or GEMINI_API_KEY environment variable',
    models: [
      { id: 'gemini-2.5-pro-preview-05-06', displayName: 'Gemini 2.5 Pro', provider: 'gemini-api', capabilities: ['chat'], tier: 'powerful' },
      { id: 'gemini-2.5-flash-preview-05-20', displayName: 'Gemini 2.5 Flash', provider: 'gemini-api', capabilities: ['chat'], tier: 'fast' },
    ],
  });

  // OpenRouter
  const openrouterAvailable = hasEnv('OPENROUTER_API_KEY');
  providers.push({
    name: 'openrouter',
    displayName: 'OpenRouter',
    type: 'api',
    available: openrouterAvailable,
    envVar: 'OPENROUTER_API_KEY',
    capabilities: ['chat'],
    setupHint: 'Set OPENROUTER_API_KEY environment variable',
    models: [
      { id: 'anthropic/claude-sonnet-4', displayName: 'Claude Sonnet 4 (via OR)', provider: 'openrouter', capabilities: ['chat'], tier: 'balanced' },
      { id: 'openai/gpt-4o', displayName: 'GPT-4o (via OR)', provider: 'openrouter', capabilities: ['chat'], tier: 'powerful' },
      { id: 'google/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro (via OR)', provider: 'openrouter', capabilities: ['chat'], tier: 'powerful' },
    ],
  });

  // Ollama (local)
  providers.push({
    name: 'ollama',
    displayName: 'Ollama (Local)',
    type: 'api',
    available: false,  // will be updated async
    capabilities: ['chat', 'embedding', 'reranking'],
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
      return {
        id: name,
        displayName: name,
        provider: 'ollama',
        capabilities: caps,
        tier: 'balanced' as const,
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
