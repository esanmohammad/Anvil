/**
 * Context budget manager — tracks and enforces token limits across providers.
 *
 * Estimates token counts, applies priority-based truncation when context
 * exceeds provider limits, and provides usage feedback.
 *
 * Token limits are resolved via `model-catalog.ts` (family rules + overrides +
 * env-var escape hatch), so new model versions work without code changes.
 */

import { getContextWindow, getMaxOutput } from './model-catalog.js';
import { heuristicTokenCount } from './token-util.js';
import { structurallyTruncate, looksLikeCode } from './structural-truncator.js';

/** Get the token limit for a model (input context window). */
export function getModelTokenLimit(modelId: string): number {
  return getContextWindow(modelId);
}

// ── Token estimation ──────────────────────────────────────────────────

/**
 * Estimate token count from a string. Routes through `token-util` so a
 * single seam owns the heuristic; callers with an active adapter should
 * prefer `countTokens(adapter, text)` directly.
 */
export function estimateTokens(text: string): number {
  return heuristicTokenCount(text);
}

// ── Context components with priority ──────────────────────────────────

export interface ContextComponent {
  name: string;
  content: string;
  tokens: number;
  priority: number; // 1 = essential (never drop), 2 = important, 3 = nice-to-have, 4 = droppable
  /**
   * Phase 4 — explicit code/prose hint so the truncator can pick the right
   * strategy. When omitted, `looksLikeCode` sniffs the content. Path/extension
   * hint (e.g. "user-service.ts") is used only to select the language.
   */
  kind?: 'code' | 'prose';
  languageHint?: string;
}

export interface BudgetResult {
  components: ContextComponent[];
  totalTokens: number;
  limit: number;
  truncated: string[];   // names of components that were truncated
  dropped: string[];     // names of components that were dropped entirely
  warning: string | null;
}

/**
 * Apply a context budget to a set of components.
 *
 * Priority rules:
 *   1 = Essential — never truncated (feature description, stage prompt)
 *   2 = Important — truncated last (knowledge base, prior artifacts)
 *   3 = Nice-to-have — truncated early (memory, project YAML)
 *   4 = Droppable — dropped first (secondary KB, verbose overrides)
 *
 * Returns the components (possibly truncated) that fit within the budget.
 */
export function applyBudget(
  components: ContextComponent[],
  modelId: string,
  reserveForOutput?: number, // Reserve tokens for model output; defaults to model's max_output
): BudgetResult {
  const limit = getModelTokenLimit(modelId);
  const reserve = reserveForOutput ?? Math.min(getMaxOutput(modelId), Math.floor(limit * 0.1));
  const budget = limit - reserve;

  // Calculate total
  let totalTokens = components.reduce((sum, c) => sum + c.tokens, 0);

  const truncated: string[] = [];
  const dropped: string[] = [];

  if (totalTokens <= budget) {
    return {
      components,
      totalTokens,
      limit,
      truncated: [],
      dropped: [],
      warning: null,
    };
  }

  // Need to trim. Work on a mutable copy sorted by priority (highest number = lowest priority = trim first)
  const sorted = [...components].sort((a, b) => b.priority - a.priority);
  const resultMap = new Map(components.map((c) => [c.name, { ...c }]));

  for (const comp of sorted) {
    if (totalTokens <= budget) break;

    const current = resultMap.get(comp.name)!;
    const excess = totalTokens - budget;

    if (comp.priority === 1) continue; // Never touch essential components

    if (comp.priority >= 4) {
      // Drop entirely
      totalTokens -= current.tokens;
      current.content = '';
      current.tokens = 0;
      dropped.push(comp.name);
      continue;
    }

    // Truncate to fit
    const targetTokens = Math.max(current.tokens - excess, Math.min(current.tokens, 500)); // Keep at least 500 tokens
    if (targetTokens < current.tokens) {
      current.content = truncateForBudget(current.content, targetTokens, comp);
      const oldTokens = current.tokens;
      current.tokens = estimateTokens(current.content);
      totalTokens -= (oldTokens - current.tokens);
      truncated.push(comp.name);
    }
  }

  const finalComponents = components.map((c) => resultMap.get(c.name)!);

  let warning: string | null = null;
  if (truncated.length > 0 || dropped.length > 0) {
    const parts: string[] = [];
    if (dropped.length > 0) parts.push(`Dropped: ${dropped.join(', ')}`);
    if (truncated.length > 0) parts.push(`Truncated: ${truncated.join(', ')}`);
    warning = `Context exceeded ${Math.round(budget / 1000)}K token budget for ${modelId}. ${parts.join('. ')}`;
  }

  return {
    components: finalComponents,
    totalTokens,
    limit,
    truncated,
    dropped,
    warning,
  };
}

// ── Smart truncation ──────────────────────────────────────────────────

/**
 * Routing wrapper — code goes through `structurallyTruncate` (preserves
 * imports + signatures), prose goes through middle-cut.
 */
function truncateForBudget(
  text: string,
  targetTokens: number,
  comp: Pick<ContextComponent, 'kind' | 'languageHint' | 'name'>,
): string {
  const explicit = comp.kind;
  const isCode = explicit === 'code'
    || (explicit === undefined && looksLikeCode(text, comp.languageHint ?? comp.name));

  if (isCode) {
    const out = structurallyTruncate(text, {
      budgetTokens: targetTokens,
      languageHint: comp.languageHint ?? comp.name,
    });
    // The truncator returns the input unchanged when it couldn't structure it
    // (unknown language, no boundaries) — fall through to middle-cut so we
    // still respect the budget.
    if (estimateTokens(out) <= targetTokens) return out;
  }
  return smartTruncate(text, targetTokens * 4);
}

/**
 * Truncate text intelligently:
 * - Keep the first 40% and last 20% of content
 * - Insert a marker in the middle showing what was removed
 * - Preserve section headers (lines starting with #)
 */
function smartTruncate(text: string, targetChars: number): string {
  if (text.length <= targetChars) return text;

  const headSize = Math.floor(targetChars * 0.4);
  const tailSize = Math.floor(targetChars * 0.2);
  const removedChars = text.length - headSize - tailSize;
  const removedTokens = Math.ceil(removedChars / 4);

  const head = text.slice(0, headSize);
  const tail = text.slice(-tailSize);
  const marker = `\n\n[... ${removedTokens} tokens truncated to fit context budget ...]\n\n`;

  return head + marker + tail;
}

// ── Convenience: build and budget a complete prompt ───────────────────

export interface PromptBudgetInput {
  featureDescription: string;
  stagePrompt: string;
  knowledgeBase: string;
  priorArtifacts: string;
  memory: string;
  projectYaml: string;
  overrides: string;
  modelId: string;
}

export interface PromptBudgetOutput {
  knowledgeBase: string;
  priorArtifacts: string;
  memory: string;
  projectYaml: string;
  overrides: string;
  totalTokens: number;
  limit: number;
  warning: string | null;
}

/**
 * Budget all context components for a pipeline stage prompt.
 * Returns the (possibly truncated) content for each component.
 */
export function budgetPromptContext(input: PromptBudgetInput): PromptBudgetOutput {
  const components: ContextComponent[] = [
    { name: 'feature', content: input.featureDescription, tokens: estimateTokens(input.featureDescription), priority: 1 },
    { name: 'stagePrompt', content: input.stagePrompt, tokens: estimateTokens(input.stagePrompt), priority: 1 },
    { name: 'knowledgeBase', content: input.knowledgeBase, tokens: estimateTokens(input.knowledgeBase), priority: 2 },
    { name: 'priorArtifacts', content: input.priorArtifacts, tokens: estimateTokens(input.priorArtifacts), priority: 2 },
    { name: 'memory', content: input.memory, tokens: estimateTokens(input.memory), priority: 3 },
    { name: 'projectYaml', content: input.projectYaml, tokens: estimateTokens(input.projectYaml), priority: 3 },
    { name: 'overrides', content: input.overrides, tokens: estimateTokens(input.overrides), priority: 4 },
  ];

  const result = applyBudget(components, input.modelId);

  const byName = new Map(result.components.map((c) => [c.name, c]));

  return {
    knowledgeBase: byName.get('knowledgeBase')?.content ?? '',
    priorArtifacts: byName.get('priorArtifacts')?.content ?? '',
    memory: byName.get('memory')?.content ?? '',
    projectYaml: byName.get('projectYaml')?.content ?? '',
    overrides: byName.get('overrides')?.content ?? '',
    totalTokens: result.totalTokens,
    limit: result.limit,
    warning: result.warning,
  };
}
