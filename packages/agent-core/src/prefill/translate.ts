/**
 * Tool-result + prefill shape translation (v2 ADR §2.3.2 / §2.3).
 *
 * The durable log stores tool results in a neutral shape
 * (`NeutralToolResult`). When a chain-fallback swap re-injects a prior
 * model's turn into a NEW provider, the adapter materializes that turn
 * into the target provider's wire format. This module owns that
 * translation.
 *
 *   - Anthropic native:
 *       tool_use  → { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] }
 *       result    → { role: 'user', content: [{ type: 'tool_result', tool_use_id, content, is_error }] }
 *   - OpenAI-compat (openrouter, opencode, openai, ollama):
 *       tool_use  → { role: 'assistant', tool_calls: [{ id, type:'function', function:{ name, arguments } }] }
 *       result    → { role: 'tool', tool_call_id, content: stringify }
 *   - ADK: materialized via Session.appendEvent inside the adk adapter
 *     (functionCall + functionResponse events) — NOT via this module.
 *
 * `materializePrefill` turns a `Prefill` into the ordered list of wire
 * messages to splice into the request BEFORE the continuation: for each
 * recorded tool use, an assistant(tool_call) + tool(result) pair, then
 * a trailing assistant message carrying the partial text the prior
 * model streamed. The target model continues from that trailing
 * assistant message (verified empirically — Anthropic + OpenAI-compat
 * both honor a trailing assistant message as a continuation prefix).
 */

import type { ProviderName } from '../types.js';
import type { NeutralToolResult, Prefill, PrefillTurn, PrefillToolUse } from '../turn-recorder/types.js';
import { isAnthropic } from './strip.js';

export interface TranslatedToolResult {
  /** Target-specific wire object the adapter appends to messages[]. */
  message: unknown;
}

function stringifyContent(content: unknown): string {
  return typeof content === 'string' ? content : JSON.stringify(content ?? null);
}

/** Convert a `NeutralToolResult` to the target provider's result message. */
export function translateToolResult(
  result: NeutralToolResult,
  target: ProviderName,
): TranslatedToolResult {
  // Defensive guard (review finding): an empty tool_use_id / tool_call_id
  // makes the upstream reject with "tool_use_id does not reference a known
  // tool_use". The ADK path can produce `id ?? ''`; fail loud here rather
  // than ship a malformed request.
  if (!result.toolUseId) {
    throw new Error('translateToolResult: NeutralToolResult.toolUseId is empty — cannot bind tool result to a tool_use');
  }
  if (isAnthropic(target)) {
    return {
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: result.toolUseId,
          content: stringifyContent(result.content),
          is_error: !result.ok,
        }],
      },
    };
  }
  // OpenAI-compatible default.
  return {
    message: {
      role: 'tool',
      tool_call_id: result.toolUseId,
      content: stringifyContent(result.content),
    },
  };
}

/** The assistant message that re-presents a recorded tool_use to the
 *  target so the following tool-result message is well-formed. */
function translateToolUseAssistant(
  use: { id: string; name: string; input: unknown },
  target: ProviderName,
): unknown {
  if (isAnthropic(target)) {
    return {
      role: 'assistant',
      content: [{ type: 'tool_use', id: use.id, name: use.name, input: use.input ?? {} }],
    };
  }
  return {
    // Empty string, not null: an assistant message that only carries a
    // tool_call has no text preamble. While most OpenAI-compat upstreams
    // accept `content: null` here, `''` is universally valid and removes
    // any ambiguity across the openai/openrouter/opencode/ollama set.
    role: 'assistant',
    content: '',
    tool_calls: [{
      id: use.id,
      type: 'function',
      function: { name: use.name, arguments: JSON.stringify(use.input ?? {}) },
    }],
  };
}

/**
 * Build the ordered wire messages that re-present a `Prefill` to the
 * target provider. The caller splices these onto the end of its
 * `messages[]` (after system + user), then lets the model continue.
 *
 * Ordering: each recorded tool use becomes an assistant(tool_call) +
 * result pair, in recorded order; finally a trailing assistant message
 * carrying the partial text (only when non-empty — an empty trailing
 * assistant message is rejected by some providers).
 */
export function materializePrefill(prefill: Prefill, target: ProviderName): unknown[] {
  const out: unknown[] = [];
  for (const use of prefill.toolUses) {
    out.push(translateToolUseAssistant({ id: use.id, name: use.name, input: use.input }, target));
    out.push(translateToolResult(use.result, target).message);
  }
  if (prefill.text.length > 0) {
    out.push({ role: 'assistant', content: prefill.text });
  }
  return out;
}

/**
 * One COMPLETED prior turn as a single assistant message (text + tool_calls
 * combined) followed by its tool-result messages. UNLIKE `materializePrefill`
 * — which keeps the partial text as a separate TRAILING assistant message so
 * the live model continues from it — a completed turn's text and tool calls
 * belong to one wire message. Emitting them split would put a phase's
 * tool-loop turns back-to-back as consecutive assistant messages (no
 * intervening tool/user), which OpenAI-compat upstreams reject or silently
 * merge. The combined shape reproduces the exact tool-loop wire sequence:
 * assistant(text,tool_calls) → tool(result)* → (next turn).
 */
function combinedAssistantMessage(
  text: string,
  toolUses: PrefillToolUse[],
  target: ProviderName,
): unknown {
  if (isAnthropic(target)) {
    const content: unknown[] = [];
    if (text.length > 0) content.push({ type: 'text', text });
    for (const u of toolUses) {
      content.push({ type: 'tool_use', id: u.id, name: u.name, input: u.input ?? {} });
    }
    return { role: 'assistant', content };
  }
  // OpenAI-compat: text + tool_calls live on ONE assistant message.
  const msg: Record<string, unknown> = { role: 'assistant', content: text };
  if (toolUses.length > 0) {
    msg.tool_calls = toolUses.map((u) => ({
      id: u.id,
      type: 'function',
      function: { name: u.name, arguments: JSON.stringify(u.input ?? {}) },
    }));
  }
  return msg;
}

/**
 * §Tier 2 — materialize a list of COMPLETED prior turns into the target
 * provider's wire format, spliced BEFORE the new user message so a stateful
 * (non-claude) session resume re-presents the full conversation. Each turn
 * emits, in order: its opening user message (when `userPrompt` is set — the
 * first turn of a phase), then one combined assistant(text+tool_calls), then
 * its tool results. Empty list → [] (START phase / no prior turns).
 */
export function materializePriorTurns(turns: PrefillTurn[], target: ProviderName): unknown[] {
  const out: unknown[] = [];
  for (const turn of turns) {
    if (typeof turn.userPrompt === 'string' && turn.userPrompt.length > 0) {
      out.push({ role: 'user', content: turn.userPrompt });
    }
    // A completed turn always carries text and/or tools; guard the empty case.
    if (turn.text.length > 0 || turn.toolUses.length > 0) {
      out.push(combinedAssistantMessage(turn.text, turn.toolUses, target));
    }
    for (const use of turn.toolUses) {
      out.push(translateToolResult(use.result, target).message);
    }
  }
  return out;
}
