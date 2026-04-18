// Pipeline cost estimator — estimates cost before running, supports all providers

import { PIPELINE_STAGES } from './types.js';

export interface StageEstimate {
  name: string;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedCost: number;
}

export interface CostEstimate {
  stages: StageEstimate[];
  totalEstimatedCost: number;
  totalEstimatedCostHigh: number;
  model: string;
  confidence: 'low' | 'medium' | 'high';
}

// Model pricing per 1M tokens: [input, output]
const MODEL_PRICING: Record<string, [number, number]> = {
  // Claude
  'sonnet': [3.0, 15.0],
  'claude-sonnet-4-6': [3.0, 15.0],
  'claude-sonnet-4-20250514': [3.0, 15.0],
  'opus': [15.0, 75.0],
  'claude-opus-4-6': [15.0, 75.0],
  'claude-opus-4-20250514': [15.0, 75.0],
  'haiku': [0.25, 1.25],
  'claude-haiku-4-5-20251001': [0.25, 1.25],
  // OpenAI
  'gpt-4o': [2.5, 10.0],
  'gpt-4o-mini': [0.15, 0.6],
  'gpt-4-turbo': [10.0, 30.0],
  'o1': [15.0, 60.0],
  'o3': [10.0, 40.0],
  'o3-mini': [1.1, 4.4],
  'o4-mini': [1.1, 4.4],
  // Gemini
  'gemini-2.5-pro': [1.25, 10.0],
  'gemini-2.5-flash': [0.30, 2.50],
  'gemini-2.5-flash-lite': [0.10, 0.40],
  'gemini-2.0-flash': [0.10, 0.40],
  // OpenRouter (common models)
  'anthropic/claude-sonnet-4': [3.0, 15.0],
  'openai/gpt-4o': [2.5, 10.0],
  'google/gemini-2.5-flash': [0.30, 2.50],
  'meta-llama/llama-3-70b-instruct': [0.59, 0.79],
};

function getModelPricing(model: string): [number, number] {
  // Direct match
  if (MODEL_PRICING[model]) return MODEL_PRICING[model];

  // Substring matching for common patterns
  if (model.includes('opus')) return MODEL_PRICING['opus'];
  if (model.includes('haiku')) return MODEL_PRICING['haiku'];
  if (model.includes('sonnet')) return MODEL_PRICING['sonnet'];
  if (model.includes('gpt-4o-mini')) return MODEL_PRICING['gpt-4o-mini'];
  if (model.includes('gpt-4o')) return MODEL_PRICING['gpt-4o'];
  if (model.includes('o3-mini') || model.includes('o4-mini')) return MODEL_PRICING['o3-mini'];
  if (model.includes('gemini-2.5-pro')) return MODEL_PRICING['gemini-2.5-pro'];
  if (model.includes('gemini-2.5-flash-lite')) return MODEL_PRICING['gemini-2.5-flash-lite'];
  if (model.includes('gemini-2.5-flash')) return MODEL_PRICING['gemini-2.5-flash'];
  if (model.includes('gemini')) return MODEL_PRICING['gemini-2.5-flash'];

  // Local models are free
  if (model.includes('llama') || model.includes('mistral') || model.includes('deepseek')) {
    return [0, 0];
  }

  // Default to sonnet
  return MODEL_PRICING['sonnet'];
}

// Base token estimates per stage (from historical averages)
// [inputTokens, outputTokens, isPerRepo]
const STAGE_TOKEN_ESTIMATES: Record<string, [number, number, boolean]> = {
  'clarify':              [2000, 1000, false],
  'requirements':         [5000, 3000, false],
  'project-requirements':  [4000, 2500, true],
  'specs':                [6000, 4000, true],
  'tasks':                [4000, 2500, true],
  'build':                [10000, 8000, true],
  'validate':             [8000, 5000, true],
  'ship':                 [3000, 2000, false],
};

export function estimatePipelineCost(config: {
  project: string;
  feature: string;
  repoCount: number;
  kbSize: number;
  model: string;
  skipClarify?: boolean;
  skipShip?: boolean;
  /** Per-stage model overrides (from factory.yaml pipeline.models) */
  stageModels?: Record<string, string>;
}): CostEstimate {
  const defaultPricing = getModelPricing(config.model);
  const stages: StageEstimate[] = [];
  let totalLow = 0;

  for (const stage of PIPELINE_STAGES) {
    const estimate = STAGE_TOKEN_ESTIMATES[stage.name];
    if (!estimate) continue;

    // Skip stages if configured
    if (stage.name === 'clarify' && config.skipClarify) continue;
    if (stage.name === 'ship' && config.skipShip) continue;

    let [inputTokens, outputTokens, isPerRepo] = estimate;

    // Add KB context to input tokens
    if (config.kbSize > 0) {
      inputTokens += Math.min(config.kbSize, 10000);
    }

    // Multiply per-repo stages by repo count
    const multiplier = isPerRepo ? Math.max(config.repoCount, 1) : 1;
    inputTokens *= multiplier;
    outputTokens *= multiplier;

    // Use per-stage model pricing if configured
    const stageModel = config.stageModels?.[stage.name];
    const [inputRate, outputRate] = stageModel ? getModelPricing(stageModel) : defaultPricing;

    const cost = (inputTokens * inputRate + outputTokens * outputRate) / 1_000_000;
    stages.push({
      name: stage.name,
      estimatedInputTokens: inputTokens,
      estimatedOutputTokens: outputTokens,
      estimatedCost: cost,
    });
    totalLow += cost;
  }

  // High estimate is ~2x for variance
  const totalHigh = totalLow * 2;

  // Confidence based on inputs
  let confidence: 'low' | 'medium' | 'high' = 'medium';
  if (config.repoCount <= 1 && config.kbSize > 0) confidence = 'high';
  if (config.repoCount > 3 || config.kbSize === 0) confidence = 'low';

  return {
    stages,
    totalEstimatedCost: totalLow,
    totalEstimatedCostHigh: totalHigh,
    model: config.model,
    confidence,
  };
}

export function formatCostEstimate(estimate: CostEstimate): string {
  const low = estimate.totalEstimatedCost.toFixed(2);
  const high = estimate.totalEstimatedCostHigh.toFixed(2);
  return `~$${low}-$${high} (${estimate.model}, confidence: ${estimate.confidence})`;
}
