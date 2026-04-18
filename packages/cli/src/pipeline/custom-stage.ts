// Custom pipeline stages — user-defined stages via factory.yaml

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StageDefinition } from './types.js';

export interface CustomStageDefinition {
  name: string;
  persona: string;
  promptFile: string;    // path to markdown prompt template
  after: string;         // which stage to insert after
  perRepo: boolean;
  timeout: number;
}

export interface CustomStageConfig {
  [name: string]: {
    persona?: string;
    prompt_file?: string;
    after?: string;
    per_repo?: boolean;
    timeout?: number;
  };
}

export function loadCustomStages(
  customStageConfig: CustomStageConfig | undefined,
  projectDir: string,
): CustomStageDefinition[] {
  if (!customStageConfig) return [];

  const definitions: CustomStageDefinition[] = [];

  for (const [name, config] of Object.entries(customStageConfig)) {
    const promptFile = config.prompt_file
      ? join(projectDir, config.prompt_file)
      : join(projectDir, '.anvil', 'stages', `${name}.md`);

    if (!existsSync(promptFile)) {
      console.error(`Warning: Custom stage "${name}" prompt file not found: ${promptFile}`);
      continue;
    }

    definitions.push({
      name,
      persona: config.persona ?? 'tester',
      promptFile,
      after: config.after ?? 'validate',
      perRepo: config.per_repo ?? false,
      timeout: config.timeout ?? 600000,
    });
  }

  return definitions;
}

export function loadCustomStagePrompt(definition: CustomStageDefinition): string {
  try {
    return readFileSync(definition.promptFile, 'utf-8');
  } catch {
    return `You are a ${definition.persona} running the custom "${definition.name}" stage.`;
  }
}

export function mergeStages(
  defaultStages: StageDefinition[],
  customStages: CustomStageDefinition[],
): StageDefinition[] {
  if (customStages.length === 0) return defaultStages;

  const result = [...defaultStages];

  for (const custom of customStages) {
    // Find insertion point
    const afterIndex = result.findIndex((s) => s.name === custom.after);
    const insertAt = afterIndex >= 0 ? afterIndex + 1 : result.length;

    const newStage: StageDefinition = {
      index: insertAt,
      name: custom.name,
      persona: custom.persona,
      parallelism: custom.perRepo ? 'parallel-per-project' : 'serial',
      timeout: custom.timeout,
      validationRequired: false,
    };

    result.splice(insertAt, 0, newStage);
  }

  // Re-index
  for (let i = 0; i < result.length; i++) {
    result[i] = { ...result[i], index: i };
  }

  return result;
}
