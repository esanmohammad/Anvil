/**
 * Validate step — Phase 6 per-stage adapter.
 * Lifts orchestrator.ts:Stage-6 logic with the validate-fix retry loop.
 */

import type { Step, StepContext } from '@anvil/core-pipeline';
import { APPROVAL_GATE_CHANNEL } from '@anvil/core-pipeline';
import { buildPersonaProjectPrompt } from '../persona-prompt.js';
import { runPostBuildGuards, hasValidationFailures } from '../post-build-guards.js';
import { sendPipelineNotification } from '../notifications.js';
import { updatePipelineStage, updateStageCost, updatePipelineCost } from '../state-file.js';
import { info, warn } from '../../logger.js';
import { estimateAgentCallCost } from '../cost-estimator.js';
import type { CliPipelineState } from '../cli-state.js';

export const VALIDATE_STEP_ID = 'validate' as const;
export const VALIDATION_ARTIFACT_ID = 'VALIDATION.md' as const;

const MAX_FIX_ATTEMPTS = 3;

export function createValidateStep(): Step<unknown, unknown> {
  return {
    id: VALIDATE_STEP_ID,
    name: 'Run validation checks + auto-fix retry loop',
    parallelism: 'serial',
    run: async (ctx: StepContext<unknown>) => {
      const state = ctx.shared as unknown as CliPipelineState;

      // Run post-build guards before validate
      runPostBuildGuards(state.repoPaths, state.workspaceDir, state.repoNames, state.project);

      updatePipelineStage(6, 'running');

      const validateProjectPrompt = await buildPersonaProjectPrompt(
        6, state.project, state.feature, state.featureSlug,
        state.projectYamlPath, state.workspaceDir, state.repoNames, state.memoryStore,
      );

      const failureCtx = (state.resumeFromStage === 6 && state.failureContext)
        ? `\n\nIMPORTANT — This is a RETRY. The previous run failed:\n${state.failureContext}\nFix the issues and proceed.`
        : '';

      const validateResult = await state.agentRunner.run({
        persona: 'tester',
        projectPrompt: validateProjectPrompt,
        userPrompt: `Feature: "${state.feature}"\n\nValidate the implementation. You MUST ensure the code is fully clean:\n\n1. Run the build (compile/type-check). Fix ALL errors.\n2. Run the linter. Fix ALL lint warnings and errors.\n3. Run the test suite. Fix ALL failing tests.\n4. Repeat steps 1-3 until everything passes with zero errors.\n5. Do NOT move on until build, lint, AND tests all pass.\n\nIf you cannot fix an issue after 5 attempts, document it as UNRESOLVED.\n\nAt the end, output a clear verdict:\n- VERDICT: PASS — if build, lint, and tests all pass\n- VERDICT: FAIL — if any issues remain unresolved\n\nDo NOT make git commits.${failureCtx}`,
        workingDir: state.workspaceDir,
        stage: 'validate',
      });

      let validateArtifact = validateResult.output;
      let totalTokens = validateResult.tokenEstimate;

      // Validate-fix loop — up to N retries
      let fixAttempts = 0;
      while (fixAttempts < MAX_FIX_ATTEMPTS && hasValidationFailures(validateArtifact)) {
        fixAttempts++;
        info(`Validation failed — fix attempt ${fixAttempts}/${MAX_FIX_ATTEMPTS}`);

        const fixProjectPrompt = await buildPersonaProjectPrompt(
          5, state.project, state.feature, state.featureSlug,
          state.projectYamlPath, state.workspaceDir, state.repoNames, state.memoryStore,
        );

        const fixResult = await state.agentRunner.run({
          persona: 'engineer',
          projectPrompt: fixProjectPrompt,
          userPrompt: `The validation stage found issues that need to be fixed (attempt ${fixAttempts}):\n\n${validateArtifact.slice(0, 6000)}\n\nFix ALL build errors, lint errors, and test failures listed above. You may run \`go build\`/\`go vet\`/\`tsc --noEmit\` and tests to verify compilation, but do NOT run linters — post-build guards will auto-fix formatting and the tester will re-validate. Do NOT make git commits.`,
          workingDir: state.workspaceDir,
          stage: `fix-${fixAttempts}`,
        });
        totalTokens += fixResult.tokenEstimate;

        runPostBuildGuards(state.repoPaths, state.workspaceDir, state.repoNames, state.project);

        const revalidateResult = await state.agentRunner.run({
          persona: 'tester',
          projectPrompt: validateProjectPrompt,
          userPrompt: `Feature: "${state.feature}"\n\nRe-validate after fix attempt ${fixAttempts}. Check build, lint, and tests. Output VERDICT: PASS or VERDICT: FAIL.\nDo NOT make git commits.`,
          workingDir: state.workspaceDir,
          stage: `revalidate-${fixAttempts}`,
        });
        validateArtifact = revalidateResult.output;
        totalTokens += revalidateResult.tokenEstimate;
      }

      if (hasValidationFailures(validateArtifact)) {
        warn(`Validation still failing after ${MAX_FIX_ATTEMPTS} fix attempts — proceeding anyway`);
        sendPipelineNotification(state.project, 'pipeline-fail', {
          project: state.project,
          feature: state.feature,
          error: `Validation failed after ${MAX_FIX_ATTEMPTS} fix attempts`,
          runId: state.runId,
        }).catch(() => undefined);
      }

      state.validationArtifact = validateArtifact;

      const { inputTokens, outputTokens, costUsd } = estimateAgentCallCost(totalTokens, state.model);
      ctx.emit(VALIDATION_ARTIFACT_ID, {
        artifact: validateArtifact,
        artifactName: VALIDATION_ARTIFACT_ID,
        tokenEstimate: totalTokens,
        costUsd,
      });
      state.stageCosts.set(6, { inputTokens, outputTokens, estimatedCost: costUsd });
      updateStageCost(6, costUsd);
      updatePipelineCost(aggregateCost(state));
      updatePipelineStage(6, 'completed');

      if (state.approvalRequired) {
        const decision = await ctx.bus.request<unknown, 'approved' | 'rejected'>(
          APPROVAL_GATE_CHANNEL,
          { stepId: VALIDATE_STEP_ID, stageIndex: 6 },
        );
        if (decision === 'rejected') throw new Error('Stage 6 rejected by user');
      }

      return validateArtifact;
    },
  };
}

function aggregateCost(state: CliPipelineState): { inputTokens: number; outputTokens: number; estimatedCost: number } {
  let estimatedCost = 0, inputTokens = 0, outputTokens = 0;
  for (const c of state.stageCosts.values()) {
    estimatedCost += c.estimatedCost;
    inputTokens += c.inputTokens;
    outputTokens += c.outputTokens;
  }
  return { estimatedCost, inputTokens, outputTokens };
}
