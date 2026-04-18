import type { AgentRunner } from '../types.js';

export type EscalationLevel = 'engineer' | 'lead' | 'architect' | 'analyst' | 'human';

export interface EscalationResult {
  level: EscalationLevel;
  resolved: boolean;
  output?: string;
}

const ESCALATION_PROMPTS: Record<Exclude<EscalationLevel, 'human'>, string> = {
  engineer: 'You are a senior engineer. Fix the following validation failure with minimal, targeted changes.',
  lead: 'You are a tech lead. Review this persistent failure and propose a broader fix strategy, then implement it.',
  architect: 'You are a project architect. This failure has resisted multiple fix attempts. Analyze the root cause and implement a structural fix.',
  analyst: 'You are a projects analyst. Analyze this intractable failure across all prior attempts and determine if the approach is fundamentally flawed.',
};

/**
 * Escalation chain that tries progressively more senior personas
 * to resolve a persistent failure.
 */
export class EscalationChain {
  private levels: EscalationLevel[] = ['engineer', 'lead', 'architect', 'analyst', 'human'];
  private currentLevel: number = 0;
  private history: Array<{ level: EscalationLevel; output: string }> = [];

  async escalate(
    failure: string,
    agentRunner: AgentRunner,
    context: string,
  ): Promise<EscalationResult> {
    const level = this.levels[this.currentLevel];

    if (level === 'human') {
      return {
        level: 'human',
        resolved: false,
        output: 'Escalated to human review. All automated fix attempts exhausted.',
      };
    }

    const historyContext = this.history
      .map((h) => `[${h.level}]: ${h.output}`)
      .join('\n\n');

    const projectPrompt = ESCALATION_PROMPTS[level];
    const userPrompt = [
      `Failure: ${failure}`,
      '',
      `Context: ${context}`,
      '',
      historyContext ? `Previous attempts:\n${historyContext}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    try {
      const result = await agentRunner.run({
        persona: level,
        projectPrompt,
        userPrompt,
        workingDir: '',
        stage: 'validate',
      });

      this.history.push({ level, output: result.output });
      this.currentLevel++;

      return {
        level,
        resolved: true,
        output: result.output,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.history.push({ level, output: `Error: ${errorMsg}` });
      this.currentLevel++;

      return {
        level,
        resolved: false,
        output: errorMsg,
      };
    }
  }

  getCurrentLevel(): EscalationLevel {
    return this.levels[this.currentLevel] ?? 'human';
  }

  getHistory(): Array<{ level: EscalationLevel; output: string }> {
    return [...this.history];
  }
}
