// Byte-budget enforcer for agent prompt sections — guards against context regressions.

import { heuristicTokenCount, heuristicTokenCountFromBytes } from './token-util.js';

export interface PromptSection {
  /** Stable identifier — used for trace logging. */
  id: string;
  /** Section content. */
  text: string;
  /**
   * Priority rank: higher = more important, kept first when over budget.
   * Sections with the SAME priority are kept/dropped together — see below.
   */
  priority: number;
  /** When over budget, prefer truncating this section before dropping it. Default false. */
  truncatable?: boolean;
}

export interface BudgetOptions {
  /** Hard cap on total bytes across all sections. */
  maxBytes: number;
  /**
   * Optional minimum bytes a `truncatable` section must keep when truncated.
   * Defaults to 1000. Sections shorter than this are dropped, not truncated.
   */
  minTruncatedBytes?: number;
  /**
   * When dropping/truncating, append a marker line for traceability.
   * Default true.
   */
  emitMarkers?: boolean;
}

export interface BudgetDecision {
  id: string;
  action: 'kept' | 'truncated' | 'dropped';
  originalBytes: number;
  finalBytes: number;
}

export interface BudgetResult {
  /** Final concatenated string, sections separated by `\n\n`. */
  text: string;
  /** Bytes of `text` (UTF-8). */
  bytes: number;
  /** Whether any section was dropped or truncated. */
  trimmed: boolean;
  /** Per-section status, in input order. */
  decisions: BudgetDecision[];
}

const SEPARATOR = '\n\n';
const TEXT_ENCODER = new TextEncoder();

function byteLen(s: string): number {
  return TEXT_ENCODER.encode(s).length;
}

function droppedMarker(id: string): string {
  return `\n[section "${id}" omitted — over budget]\n`;
}

function truncationMarker(remaining: number): string {
  return `\n... [truncated, ${remaining} more bytes]`;
}

/**
 * Truncate `text` so that the resulting string + truncation marker fits in `budget` bytes.
 * Returns the truncated string (already including the marker when emitMarker=true).
 */
function truncateToBudget(text: string, budget: number, emitMarker: boolean): string {
  const totalBytes = byteLen(text);
  if (totalBytes <= budget) return text;

  // Binary search the largest prefix length (in chars) that fits, leaving room for the marker.
  // We measure in chars then check bytes since UTF-8 chars can be 1-4 bytes.
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    const prefix = text.slice(0, mid);
    const remaining = totalBytes - byteLen(prefix);
    const marker = emitMarker ? truncationMarker(remaining) : '';
    if (byteLen(prefix) + byteLen(marker) <= budget) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  const prefix = text.slice(0, lo);
  const remaining = totalBytes - byteLen(prefix);
  return emitMarker ? prefix + truncationMarker(remaining) : prefix;
}

export function enforceBudget(sections: PromptSection[], opts: BudgetOptions): BudgetResult {
  const minTruncatedBytes = opts.minTruncatedBytes ?? 1000;
  const emitMarkers = opts.emitMarkers ?? true;

  const originalBytes = sections.map((s) => byteLen(s.text));
  const separatorBytes = sections.length > 0 ? (sections.length - 1) * byteLen(SEPARATOR) : 0;
  const total = originalBytes.reduce((sum, n) => sum + n, 0) + separatorBytes;

  if (total <= opts.maxBytes) {
    const decisions: BudgetDecision[] = sections.map((s, i) => ({
      id: s.id,
      action: 'kept',
      originalBytes: originalBytes[i],
      finalBytes: originalBytes[i],
    }));
    return {
      text: sections.map((s) => s.text).join(SEPARATOR),
      bytes: total,
      trimmed: false,
      decisions,
    };
  }

  // Sort indices by priority DESC, input order as tiebreaker.
  const order = sections.map((_, i) => i);
  order.sort((a, b) => {
    const dp = sections[b].priority - sections[a].priority;
    return dp !== 0 ? dp : a - b;
  });

  const finalText = new Array<string | null>(sections.length).fill(null);
  const actions = new Array<'kept' | 'truncated' | 'dropped'>(sections.length).fill('dropped');
  let usedBytes = 0;
  let stoppedKeeping = false;

  for (const i of order) {
    const sep = usedBytes > 0 ? byteLen(SEPARATOR) : 0;
    const size = originalBytes[i];
    const remainingBudget = opts.maxBytes - usedBytes - sep;

    if (!stoppedKeeping && size <= remainingBudget) {
      finalText[i] = sections[i].text;
      actions[i] = 'kept';
      usedBytes += sep + size;
      continue;
    }

    if (!stoppedKeeping && sections[i].truncatable && remainingBudget >= minTruncatedBytes) {
      const truncated = truncateToBudget(sections[i].text, remainingBudget, emitMarkers);
      finalText[i] = truncated;
      actions[i] = 'truncated';
      usedBytes += sep + byteLen(truncated);
      stoppedKeeping = true;
      continue;
    }

    actions[i] = 'dropped';
    stoppedKeeping = true;
  }

  // Re-emit in input order.
  const parts: string[] = [];
  const decisions: BudgetDecision[] = [];
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    if (actions[i] === 'dropped') {
      decisions.push({
        id: s.id,
        action: 'dropped',
        originalBytes: originalBytes[i],
        finalBytes: 0,
      });
      if (emitMarkers) parts.push(droppedMarker(s.id));
      continue;
    }
    const piece = finalText[i] as string;
    parts.push(piece);
    decisions.push({
      id: s.id,
      action: actions[i],
      originalBytes: originalBytes[i],
      finalBytes: byteLen(piece),
    });
  }

  const text = parts.join(SEPARATOR);
  return {
    text,
    bytes: byteLen(text),
    trimmed: true,
    decisions,
  };
}

/**
 * Convenience: estimate token count using the heuristic in `token-util`.
 *
 * NOTE: `prompt-budget` works in BYTES (UTF-8) and uses byte-length here so
 * the result is consistent with the rest of this module's accounting.
 * Callers with an active adapter should use `countTokens(adapter, text)`
 * directly for higher accuracy.
 */
export function estimateBudgetTokens(text: string): number {
  if (!text) return heuristicTokenCount('');
  return heuristicTokenCountFromBytes(byteLen(text));
}
