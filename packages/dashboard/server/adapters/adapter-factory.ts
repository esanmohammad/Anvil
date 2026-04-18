/**
 * Adapter factory — routes model ID to the correct provider adapter.
 *
 * Resolution order:
 *   1. Look up model in provider registry cache
 *   2. Apply naming heuristics (gemini-* → gemini-cli, gpt-* → openai, etc.)
 *   3. Fall back to Claude (safest default)
 */

import { execSync } from 'node:child_process';
import { BaseAdapter, type AdapterConfig } from './base-adapter.js';
import { ClaudeAdapter } from './claude-adapter.js';
import { GeminiCliAdapter } from './gemini-cli-adapter.js';
import { ApiAdapter } from './api-adapter.js';

/**
 * Resolve which provider a model ID belongs to.
 *
 * Uses the provider registry cache if available, otherwise
 * falls back to naming heuristics.
 */
/**
 * Resolve which provider a model ID belongs to.
 * Uses heuristics based on model naming conventions.
 */
export function resolveProvider(modelId: string): string {
  return resolveProviderByHeuristic(modelId);
}

/** Naming-convention-based provider resolution */
export function resolveProviderByHeuristic(modelId: string): string {
  // Gemini models
  if (modelId.startsWith('gemini-')) {
    // Check if Gemini CLI is available, otherwise use API
    try {
      execSync('which gemini', { stdio: 'pipe', timeout: 2000 });
      return 'gemini-cli';
    } catch {
      return 'gemini-api';
    }
  }

  // OpenAI models
  if (modelId.startsWith('gpt-') || modelId.startsWith('o1') || modelId.startsWith('o3')) {
    return 'openai';
  }

  // OpenRouter models (contain a slash: org/model)
  if (modelId.includes('/')) {
    return 'openrouter';
  }

  // Claude models (default)
  if (modelId.startsWith('claude-')) {
    return 'claude';
  }

  // Unknown — default to claude
  return 'claude';
}

/**
 * Create the appropriate adapter for a given config.
 * The model field in the config determines which provider to use.
 */
export function createAdapter(config: AdapterConfig): BaseAdapter {
  const provider = resolveProvider(config.model);

  switch (provider) {
    case 'claude':
      return new ClaudeAdapter(config);

    case 'gemini-cli':
      return new GeminiCliAdapter(config);

    case 'openai':
      return new ApiAdapter(config, 'openai');

    case 'gemini-api':
      return new ApiAdapter(config, 'gemini-api');

    case 'openrouter':
      return new ApiAdapter(config, 'openrouter');

    case 'ollama':
      return new ApiAdapter(config, 'ollama');

    default:
      // Safe fallback — Claude handles most things
      return new ClaudeAdapter(config);
  }
}
