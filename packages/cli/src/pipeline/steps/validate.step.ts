/**
 * Validate step — Phase 5 port.
 *
 * Wraps cli's existing `runFixLoop`. Today the validate stage runs
 * `validate → fix failures → re-validate` up to N iterations. Phase 7
 * generalizes this loop into typed `subSteps` so other stages (security
 * scan, contract tests) get retry composition for free.
 *
 * For Phase 5 the entire fix loop stays inside one Step's `run`.
 */

import type { Step, StepContext } from '@anvil/core-pipeline';
import { runFixLoop } from '../stages/validate/index.js';
import type { FixLoopResult } from '../stages/validate/index.js';
import type { AgentRunner } from '../stages/types.js';

export interface ValidateInput {
  repoPaths: Record<string, string>;
  languages: Record<string, 'typescript' | 'go' | 'unknown'>;
  agentRunner: AgentRunner;
  maxIterations?: number;
}

export type ValidateOutput = FixLoopResult;

export const VALIDATE_STEP_ID = 'validate' as const;
export const VALIDATION_ARTIFACT_ID = 'VALIDATION.md' as const;

export function createValidateStep(): Step<ValidateInput, ValidateOutput> {
  return {
    id: VALIDATE_STEP_ID,
    name: 'Run validation checks + auto-fix retry loop',
    parallelism: 'serial',
    run: async (ctx: StepContext<ValidateInput>): Promise<ValidateOutput> => {
      const result = await runFixLoop(
        ctx.input.repoPaths,
        ctx.input.languages,
        ctx.input.agentRunner,
        ctx.input.maxIterations ?? 5,
      );
      ctx.emit(VALIDATION_ARTIFACT_ID, {
        artifact: result.validationMd,
        allPassed: result.allPassed,
        iterations: result.iterations,
      });
      return result;
    },
  };
}
