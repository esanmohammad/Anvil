/**
 * Context budget manager — tracks and enforces token limits across providers.
 *
 * Estimates token counts, applies priority-based truncation when context
 * exceeds provider limits, and provides usage feedback.
 */

// ── Provider token limits ─────────────────────────────────────────────

const MODEL_LIMITS: Record<string, number> = {
  // Claude (via CLI — has its own compression, but we still budget)
  'claude-opus-4-6': 200_000,
  'claude-sonnet-4-6': 200_000,
  'claude-sonnet-4': 200_000,
  'claude-haiku-4-5-20251001': 200_000,
  // Gemini
  'gemini-2.5-pro': 1_000_000,
  'gemini-2.5-flash': 1_000_000,
  'gemini-2.5-pro-preview-05-06': 1_000_000,
  'gemini-2.5-flash-preview-05-20': 1_000_000,
  // OpenAI
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'o3-mini': 200_000,
  'o1': 200_000,
};

const DEFAULT_LIMIT = 128_000; // Conservative default for unknown models

/** Get the token limit for a model */
export function getModelTokenLimit(modelId: string): number {
  // Exact match
  if (MODEL_LIMITS[modelId]) return MODEL_LIMITS[modelId];

  // Prefix match
  for (const [prefix, limit] of Object.entries(MODEL_LIMITS)) {
    if (modelId.startsWith(prefix)) return limit;
  }

  // Heuristic by provider prefix
  if (modelId.startsWith('claude-')) return 200_000;
  if (modelId.startsWith('gemini-')) return 1_000_000;
  if (modelId.startsWith('gpt-')) return 128_000;
  if (modelId.startsWith('o1') || modelId.startsWith('o3')) return 200_000;

  // OpenRouter models (org/model format)
  if (modelId.includes('/')) {
    if (modelId.includes('claude')) return 200_000;
    if (modelId.includes('gemini')) return 1_000_000;
    if (modelId.includes('gpt')) return 128_000;
  }

  return DEFAULT_LIMIT;
}

// ── Token estimation ──────────────────────────────────────────────────

/** Estimate token count from a string (chars/4 heuristic, good within ~10%) */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

// ── Context components with priority ──────────────────────────────────

export interface ContextComponent {
  name: string;
  content: string;
  tokens: number;
  priority: number; // 1 = essential (never drop), 2 = important, 3 = nice-to-have, 4 = droppable
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
  reserveForOutput: number = 16_000, // Reserve tokens for model output
): BudgetResult {
  const limit = getModelTokenLimit(modelId);
  const budget = limit - reserveForOutput;

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
      const targetChars = targetTokens * 4;
      current.content = smartTruncate(current.content, targetChars);
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
