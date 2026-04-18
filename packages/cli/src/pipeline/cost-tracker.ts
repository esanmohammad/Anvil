// Pipeline cost tracker — dynamic pricing per model/provider

import type { CostEntry } from '../run/types.js';

// Model pricing per 1M tokens: [input, output]
const MODEL_PRICING: Record<string, [number, number]> = {
  // Claude
  'sonnet': [3.0, 15.0],
  'opus': [15.0, 75.0],
  'haiku': [0.25, 1.25],
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
  // Local
  'ollama': [0, 0],
};

function resolveModelPricing(model: string): [number, number] {
  // Direct match
  if (MODEL_PRICING[model]) return MODEL_PRICING[model];

  // Substring matching
  if (model.includes('opus')) return MODEL_PRICING['opus'];
  if (model.includes('haiku')) return MODEL_PRICING['haiku'];
  if (model.includes('sonnet')) return MODEL_PRICING['sonnet'];
  if (model.includes('gpt-4o-mini')) return MODEL_PRICING['gpt-4o-mini'];
  if (model.includes('gpt-4-turbo')) return MODEL_PRICING['gpt-4-turbo'];
  if (model.includes('gpt-4o')) return MODEL_PRICING['gpt-4o'];
  if (model.includes('o3-mini') || model.includes('o4-mini')) return MODEL_PRICING['o3-mini'];
  if (model.includes('gemini-2.5-pro')) return MODEL_PRICING['gemini-2.5-pro'];
  if (model.includes('gemini-2.5-flash-lite')) return MODEL_PRICING['gemini-2.5-flash-lite'];
  if (model.includes('gemini-2.5-flash')) return MODEL_PRICING['gemini-2.5-flash'];
  if (model.includes('gemini')) return MODEL_PRICING['gemini-2.5-flash'];

  // Default to sonnet pricing
  return MODEL_PRICING['sonnet'];
}

export class CostTracker {
  private stageCosts: Map<number, CostEntry> = new Map();

  addStageCost(
    stageIndex: number,
    inputTokens: number,
    outputTokens: number,
    options?: { model?: string; costUsd?: number },
  ): void {
    const existing = this.stageCosts.get(stageIndex);
    const prevInput = existing?.inputTokens ?? 0;
    const prevOutput = existing?.outputTokens ?? 0;

    const newInput = prevInput + inputTokens;
    const newOutput = prevOutput + outputTokens;

    let estimatedCost: number;
    if (options?.costUsd !== undefined && options.costUsd > 0) {
      // Provider-reported cost (e.g., Claude CLI's total_cost_usd)
      estimatedCost = (existing?.estimatedCost ?? 0) + options.costUsd;
    } else {
      // Calculate from tokens + model pricing
      const [inputRate, outputRate] = options?.model
        ? resolveModelPricing(options.model)
        : [3.0, 15.0];
      estimatedCost = (newInput * inputRate + newOutput * outputRate) / 1_000_000;
    }

    this.stageCosts.set(stageIndex, {
      inputTokens: newInput,
      outputTokens: newOutput,
      estimatedCost,
    });
  }

  getStageCost(stageIndex: number): CostEntry | null {
    return this.stageCosts.get(stageIndex) ?? null;
  }

  getTotalCost(): CostEntry {
    let inputTokens = 0;
    let outputTokens = 0;
    let estimatedCost = 0;

    for (const entry of this.stageCosts.values()) {
      inputTokens += entry.inputTokens;
      outputTokens += entry.outputTokens;
      estimatedCost += entry.estimatedCost;
    }

    return { inputTokens, outputTokens, estimatedCost };
  }

  getAllStageCosts(): Map<number, CostEntry> {
    return new Map(this.stageCosts);
  }

  toRunRecordFormat(): CostEntry {
    return this.getTotalCost();
  }
}
