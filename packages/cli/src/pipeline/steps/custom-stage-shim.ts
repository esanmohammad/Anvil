/**
 * Custom-stage shim — Phase 6 strangler-fig adapter.
 *
 * Reads factory.yaml's `custom_stages:` block and registers each entry
 * as a `Step<unknown, unknown>` in the pipeline registry. Mirrors the
 * existing loader at `cli/src/pipeline/custom-stage.ts:loadCustomStages`
 * — same prompt-file discovery, same default values — but produces a
 * Step instead of a `StageDefinition`.
 *
 * Per ADR P6: factory.yaml's existing `after: <stage-name>` keeps
 * working unchanged. Two new optional fields override positioning:
 *   - `insertBefore: <step-id>` — register via StepRegistry.insertBefore
 *   - `insertAfter:  <step-id>` — register via StepRegistry.insertAfter
 *
 * Precedence at registration time:
 *   1. `insertBefore` (if set, insert before that step)
 *   2. `insertAfter`  (if set, insert after that step)
 *   3. legacy `after` (if set, insert after that step)
 *   4. neither — append to the end of the registry (matches today's
 *      default for entries with no `after`)
 *
 * The Step's `run()` is a thin wrapper that:
 *   - reads the prompt file (from `prompt_file` or `.anvil/stages/<name>.md`)
 *   - invokes the supplied `AgentRunner` with the persona + prompt
 *   - emits the artifact under `<custom-stage-name>.output`
 */

import { readFileSync } from 'node:fs';
import type { Step, StepContext, StepRegistry } from '@anvil/core-pipeline';
import {
  loadCustomStages,
  type CustomStageConfig,
  type CustomStageDefinition,
} from '../custom-stage.js';
import type { AgentRunner } from '../stages/types.js';

/**
 * Extension to {@link CustomStageConfig} entries: optional positional
 * fields that take precedence over the legacy `after`.
 */
export interface CustomStagePositionalFields {
  insertBefore?: string;
  insertAfter?: string;
}

/**
 * Combined custom-stage config: legacy `CustomStageConfig` entries +
 * the new optional positional fields. Backwards-compatible — entries
 * with neither `insertBefore`/`insertAfter` field fall through to the
 * legacy `after` semantics.
 */
export type CustomStageConfigV2 = CustomStageConfig & {
  [name: string]: (CustomStageConfig[string] & CustomStagePositionalFields) | undefined;
};

export interface CustomStageStepInput {
  /** Project name passed through to the agent runner. */
  project: string;
  /** Feature description passed through to the agent runner. */
  feature: string;
  /** Resolved agent runner — supplied by the caller. */
  agentRunner: AgentRunner;
  /** Optional extra context appended to the user prompt (e.g., upstream artifacts). */
  context?: string;
}

export interface CustomStageStepOutput {
  output: string;
  tokenEstimate: number;
}

export interface CustomStageRegistration {
  stepId: string;
  position: 'append' | 'insertBefore' | 'insertAfter';
  reference?: string;
}

/**
 * Translate factory.yaml's custom_stages config into Step registrations
 * on `registry`. Returns the per-entry registration record (useful for
 * tests + diagnostics). Side-effect: mutates `registry`.
 */
export function registerCustomStages(
  registry: StepRegistry,
  customStageConfig: CustomStageConfigV2 | undefined,
  projectDir: string,
): CustomStageRegistration[] {
  if (!customStageConfig) return [];

  const definitions = loadCustomStages(customStageConfig, projectDir);
  const records: CustomStageRegistration[] = [];

  for (const def of definitions) {
    const raw = customStageConfig[def.name];
    const insertBefore = raw?.insertBefore;
    const insertAfter = raw?.insertAfter ?? def.after;
    const step = createCustomStageStep(def);

    if (insertBefore && hasStep(registry, insertBefore)) {
      registry.insertBefore(insertBefore, step as Step<unknown, unknown>);
      records.push({ stepId: def.name, position: 'insertBefore', reference: insertBefore });
    } else if (insertAfter && hasStep(registry, insertAfter)) {
      registry.insertAfter(insertAfter, step as Step<unknown, unknown>);
      records.push({ stepId: def.name, position: 'insertAfter', reference: insertAfter });
    } else {
      registry.register(step as Step<unknown, unknown>);
      records.push({ stepId: def.name, position: 'append' });
    }
  }

  return records;
}

function createCustomStageStep(
  def: CustomStageDefinition,
): Step<CustomStageStepInput, CustomStageStepOutput> {
  return {
    id: def.name,
    name: `Custom stage: ${def.name} (persona=${def.persona})`,
    parallelism: def.perRepo ? 'per-project' : 'serial',
    run: async (ctx: StepContext<CustomStageStepInput>): Promise<CustomStageStepOutput> => {
      const promptBody = readPromptSafely(def);
      const result = await ctx.input.agentRunner.run({
        persona: def.persona,
        projectPrompt: promptBody,
        userPrompt: buildUserPrompt(ctx.input.feature, ctx.input.context),
        workingDir: ctx.workspaceDir,
        stage: def.name,
      });
      ctx.emit(`${def.name}.output`, {
        output: result.output,
        tokenEstimate: result.tokenEstimate,
      });
      return { output: result.output, tokenEstimate: result.tokenEstimate };
    },
  };
}

function buildUserPrompt(feature: string, context: string | undefined): string {
  const lines = [`# Feature\n\n${feature}`];
  if (context && context.trim().length > 0) {
    lines.push(`# Context\n\n${context}`);
  }
  return lines.join('\n\n');
}

function readPromptSafely(def: CustomStageDefinition): string {
  try {
    return readFileSync(def.promptFile, 'utf8');
  } catch {
    return `You are a ${def.persona} running the custom "${def.name}" stage.`;
  }
}

function hasStep(registry: StepRegistry, id: string): boolean {
  return registry.steps().some((s) => s.id === id);
}
