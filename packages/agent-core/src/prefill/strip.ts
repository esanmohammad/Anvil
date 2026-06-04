/**
 * Cross-provider strip policy (v2 ADR §2.3.1).
 *
 * Vendor-specific message blocks DO NOT survive a chain-fallback swap
 * across providers. `stripForTarget` removes fields the target provider
 * would reject (or silently misinterpret) when the conversation
 * originated on a different vendor.
 *
 * The matrix (§2.3.1):
 *   - reasoning_details[] / reasoning  — OpenRouter reasoning models;
 *     strip when source !== target (Anthropic + OpenAI reject them).
 *   - cache_control                    — Anthropic; strip when target is non-Anthropic.
 *   - prompt_cache_key                 — OpenAI; strip when target is non-OpenAI.
 *
 * Same-vendor swaps short-circuit: nothing is stripped (hot path), and
 * they additionally qualify for the §5.1 prefix-cache fast-path.
 *
 * The function is shape-agnostic: it walks each message object and
 * deletes the known vendor keys (including inside content-block arrays
 * for Anthropic's `cache_control`). It never mutates the input — every
 * message is shallow-cloned before a key is removed.
 */

import type { ProviderName } from '../types.js';

export interface StripContext {
  sourceProvider: ProviderName;
  targetProvider: ProviderName;
}

/** Anthropic family: native `messages` API consumers.
 *
 * NOTE on 'adk': ADK is provider-agnostic at runtime (claude-via-adk =
 * Anthropic wire; gemini-via-adk = Google wire). Per ADR §2.8, ADK
 * prefill is materialized via `Session.appendEvent`, NOT through
 * `materializePrefill`/`stripForTarget` — so this predicate is NOT
 * exercised for ADK targets in the H2 path. When ADK is ported (H4),
 * its wire format must be detected from the underlying model id, not
 * assumed Anthropic here. Kept in the Anthropic bucket only so the
 * §5.1 same-vendor cache fast-path can recognise `claude`↔`claude`;
 * revisit when ADK joins the prefill path. */
function isAnthropic(p: ProviderName): boolean {
  return p === 'adk' || p === 'claude';
}

/** OpenAI-compatible chat-completions consumers. */
function isOpenAICompat(p: ProviderName): boolean {
  return p === 'openai' || p === 'openrouter' || p === 'opencode' || p === 'ollama';
}

type LooseMessage = Record<string, unknown>;

/**
 * Return a new message array safe to send to `targetProvider` given it
 * originated on `sourceProvider`. Same-vendor → returned as a shallow
 * copy untouched.
 */
export function stripForTarget(messages: readonly unknown[], ctx: StripContext): unknown[] {
  if (ctx.sourceProvider === ctx.targetProvider) {
    return messages.slice();
  }

  const dropReasoning = !isOpenRouterFamily(ctx.targetProvider);
  const dropCacheControl = !isAnthropic(ctx.targetProvider);
  const dropPromptCacheKey = !isOpenAIExact(ctx.targetProvider);

  return messages.map((raw) => {
    if (!raw || typeof raw !== 'object') return raw;
    const msg = { ...(raw as LooseMessage) };

    if (dropReasoning) {
      delete msg.reasoning;
      delete msg.reasoning_details;
    }
    if (dropPromptCacheKey) {
      delete msg.prompt_cache_key;
    }
    if (dropCacheControl) {
      // top-level marker
      delete msg.cache_control;
      // Anthropic puts cache_control inside content-block arrays.
      if (Array.isArray(msg.content)) {
        msg.content = (msg.content as unknown[]).map((block) => {
          if (block && typeof block === 'object' && 'cache_control' in (block as object)) {
            const clone = { ...(block as Record<string, unknown>) };
            delete clone.cache_control;
            return clone;
          }
          return block;
        });
      }
    }
    return msg;
  });
}

/** OpenRouter (and OpenCode, which proxies OpenRouter-style models) are
 *  the only consumers that accept echoed reasoning_details. */
function isOpenRouterFamily(p: ProviderName): boolean {
  return p === 'openrouter' || p === 'opencode';
}

/** Exact OpenAI — the only consumer that honors `prompt_cache_key`. */
function isOpenAIExact(p: ProviderName): boolean {
  return p === 'openai';
}

// Re-export the family predicates for the translate layer + tests.
export { isAnthropic, isOpenAICompat };
