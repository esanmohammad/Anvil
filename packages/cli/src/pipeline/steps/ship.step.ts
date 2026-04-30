/**
 * Ship step — Phase 6 per-stage adapter.
 * Lifts orchestrator.ts:Stage-7 logic.
 */

import { execSync } from 'node:child_process';
import type { Step, StepContext } from '@anvil/core-pipeline';
import { buildPersonaProjectPrompt } from '../persona-prompt.js';
import { updatePipelineStage, updateStageCost, updatePipelineCost } from '../state-file.js';
import { warn } from '../../logger.js';
import { estimateAgentCallCost } from '../cost-estimator.js';
import type { CliPipelineState } from '../cli-state.js';

export const SHIP_STEP_ID = 'ship' as const;

export function createShipStep(): Step<unknown, unknown> {
  return {
    id: SHIP_STEP_ID,
    name: 'Commit, push feature branch, create PRs',
    parallelism: 'serial',
    run: async (ctx: StepContext<unknown>) => {
      const state = ctx.shared as unknown as CliPipelineState;

      if (state.skipShip) {
        updatePipelineStage(7, 'skipped');
        return null;
      }

      // Pre-check: gh CLI auth
      try {
        execSync('gh auth status', { stdio: 'pipe', timeout: 10_000 });
      } catch {
        warn('GitHub CLI is not authenticated. PRs will not be created.');
        warn('Run "gh auth login" to authenticate, then retry with "anvil resume".');
      }

      updatePipelineStage(7, 'running');

      const projectPrompt = await buildPersonaProjectPrompt(
        7, state.project, state.feature, state.featureSlug,
        state.projectYamlPath, state.workspaceDir, state.repoNames, state.memoryStore,
      );

      const branchName = `anvil/${state.featureSlug}`;
      const repoListStr = state.repoNames.length > 0 ? state.repoNames.join(', ') : '(workspace root)';

      const prLabels = ['anvil'];
      if (state.actionType === 'bugfix' || state.actionType === 'fix') prLabels.push('bug');
      else if (state.actionType === 'spike' || state.actionType === 'review') prLabels.push(state.actionType);
      else prLabels.push('enhancement');
      const labelFlags = prLabels.map((l) => `--label "${l}"`).join(' ');

      const shipResult = await state.agentRunner.run({
        persona: 'engineer',
        projectPrompt,
        userPrompt: `Feature: "${state.feature}"\nRepositories: ${repoListStr}\n\nShip the changes. The code is already on feature branch "${branchName}". The build, lint, and tests all pass.\n\nFor each repo with changes:\n1. Run a final quick check: build and lint to confirm everything is clean\n2. If ANY errors remain, fix them before proceeding\n3. Stage and commit all changes with a clear commit message: "[anvil] ${state.feature}"\n4. Push the feature branch to origin\n5. Create a PR from "${branchName}" to main with a description of the changes. Add these label flags to the gh pr create command: ${labelFlags}\n\nDo NOT merge to main. Only create PRs. Do NOT create a PR if the code has unfixed errors.`,
        workingDir: state.workspaceDir,
        stage: 'ship',
      });

      const prUrlPattern = /https:\/\/github\.com\/[^\s"')]+\/pull\/\d+/g;
      const extractedPrUrls = shipResult.output.match(prUrlPattern);
      if (extractedPrUrls) {
        state.prUrls = [...new Set(extractedPrUrls)];
      }

      const totalTokens = shipResult.tokenEstimate;
      const { inputTokens, outputTokens, costUsd } = estimateAgentCallCost(totalTokens, state.model);
      state.stageCosts.set(7, { inputTokens, outputTokens, estimatedCost: costUsd });
      updateStageCost(7, costUsd);
      updatePipelineCost(aggregateCost(state));
      updatePipelineStage(7, 'completed');

      return state.prUrls;
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
