export const PERSONA_NAMES = ['clarifier', 'analyst', 'architect', 'lead', 'engineer', 'tester'] as const;
export type PersonaName = typeof PERSONA_NAMES[number];

export interface StageRule {
  canReadCode: boolean;
  canWriteCode: boolean;
  canModifyArchitecture: boolean;
  canCreateTasks: boolean;
  canRunTests: boolean;
  scopeConstraints?: string[];
}

export interface OutputTemplate {
  filename: string;
  requiredSections: string[];
  validationRules?: string[];
}

export interface PluginAccess {
  required: string[];
  optional?: string[];
}

export interface PersonaConfig {
  name: PersonaName;
  role: string;
  description: string;
  stageRules: StageRule;
  outputTemplate: OutputTemplate;
  pluginAccess: PluginAccess;
  domainKnowledge: string[];
}

export function isValidPersonaName(name: string): name is PersonaName {
  return PERSONA_NAMES.includes(name as PersonaName);
}

export function validatePersonaConfig(config: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!config || typeof config !== 'object') {
    return { valid: false, errors: ['Config must be an object'] };
  }
  const c = config as Record<string, unknown>;
  if (!c.name || !isValidPersonaName(c.name as string)) errors.push('Invalid or missing persona name');
  if (!c.role || typeof c.role !== 'string') errors.push('Missing role');
  if (!c.description || typeof c.description !== 'string') errors.push('Missing description');
  if (!c.stageRules || typeof c.stageRules !== 'object') errors.push('Missing stageRules');
  if (!c.outputTemplate || typeof c.outputTemplate !== 'object') errors.push('Missing outputTemplate');
  if (!c.pluginAccess || typeof c.pluginAccess !== 'object') errors.push('Missing pluginAccess');
  return { valid: errors.length === 0, errors };
}
