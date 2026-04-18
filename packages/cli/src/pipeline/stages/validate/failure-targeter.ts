import type { AgentRunner } from '../types.js';
import type { ValidationCheck } from './runner.js';
import { stageAll, commit } from '../../../git/index.js';

export interface FailureFix {
  failure: string;
  status: 'fixed' | 'failed';
  changes: string[];
}

/**
 * Assembles minimal context about a failure and runs the engineer agent
 * scoped to just that fix.
 */
export async function targetFailure(
  failure: ValidationCheck,
  repoPath: string,
  agentRunner: AgentRunner,
): Promise<FailureFix> {
  const userPrompt = [
    `Fix this validation failure:`,
    `Check: ${failure.name}`,
    `Command: ${failure.command}`,
    `Output:`,
    failure.output,
    '',
    'Make the minimal changes needed to fix this failure.',
  ].join('\n');

  try {
    const result = await agentRunner.run({
      persona: 'engineer',
      projectPrompt: 'You are a senior engineer fixing a validation failure. Make minimal, targeted changes.',
      userPrompt,
      workingDir: repoPath,
      stage: 'validate',
    });

    // Stage and commit the fix
    await stageAll(repoPath);
    const sha = await commit(repoPath, `[anvil] fix: ${failure.name} validation failure`);

    return {
      failure: failure.name,
      status: 'fixed',
      changes: sha ? [sha] : [],
    };
  } catch (error) {
    return {
      failure: failure.name,
      status: 'failed',
      changes: [],
    };
  }
}
