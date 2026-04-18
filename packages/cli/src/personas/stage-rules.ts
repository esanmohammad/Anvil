import type { PersonaName, StageRule } from './types.js';

export const STAGE_RULES: Record<PersonaName, StageRule> = {
  clarifier: {
    canReadCode: false,
    canWriteCode: false,
    canModifyArchitecture: false,
    canCreateTasks: false,
    canRunTests: false,
  },
  analyst: {
    canReadCode: true,
    canWriteCode: false,
    canModifyArchitecture: false,
    canCreateTasks: false,
    canRunTests: false,
  },
  architect: {
    canReadCode: true,
    canWriteCode: false,
    canModifyArchitecture: true,
    canCreateTasks: false,
    canRunTests: false,
  },
  lead: {
    canReadCode: true,
    canWriteCode: false,
    canModifyArchitecture: false,
    canCreateTasks: true,
    canRunTests: false,
  },
  engineer: {
    canReadCode: true,
    canWriteCode: true,
    canModifyArchitecture: false,
    canCreateTasks: false,
    canRunTests: false,
    scopeConstraints: ['task-scoped'],
  },
  tester: {
    canReadCode: true,
    canWriteCode: false,
    canModifyArchitecture: false,
    canCreateTasks: false,
    canRunTests: true,
  },
};

export function getStageRules(persona: PersonaName): StageRule {
  return STAGE_RULES[persona];
}

export function formatRulesForPrompt(rules: StageRule): string {
  const lines: string[] = ['## Stage Rules\n'];
  lines.push(`- Read code: ${rules.canReadCode ? 'YES' : 'NO'}`);
  lines.push(`- Write code: ${rules.canWriteCode ? 'YES' : 'NO'}`);
  lines.push(`- Modify architecture: ${rules.canModifyArchitecture ? 'YES' : 'NO'}`);
  lines.push(`- Create tasks: ${rules.canCreateTasks ? 'YES' : 'NO'}`);
  lines.push(`- Run tests: ${rules.canRunTests ? 'YES' : 'NO'}`);
  if (rules.scopeConstraints?.length) {
    lines.push(`- Scope: ${rules.scopeConstraints.join(', ')}`);
  }
  return lines.join('\n');
}
