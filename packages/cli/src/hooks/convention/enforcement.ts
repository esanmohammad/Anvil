// Section E — Enforcement Configuration
import type { EnforcementLevel, ConventionRules } from './types.js';

export interface EnforcementOverride {
  ruleName: string;
  level: EnforcementLevel;
}

export interface EnforcementConfig {
  defaultLevel: EnforcementLevel;
  overrides: Map<string, EnforcementLevel>;
}

/**
 * Load enforcement configuration with per-rule level overrides.
 */
export function loadEnforcementConfig(
  overrides: EnforcementOverride[] = [],
  defaultLevel: EnforcementLevel = 'error',
): EnforcementConfig {
  const map = new Map<string, EnforcementLevel>();
  for (const o of overrides) {
    map.set(o.ruleName, o.level);
  }
  return { defaultLevel, overrides: map };
}

/**
 * Get the effective enforcement level for a rule.
 */
export function getEffectiveLevel(
  ruleName: string,
  config: EnforcementConfig,
): EnforcementLevel {
  return config.overrides.get(ruleName) ?? config.defaultLevel;
}

/**
 * Apply enforcement config to convention rules, adjusting levels.
 */
export function applyEnforcement(
  rules: ConventionRules,
  config: EnforcementConfig,
): ConventionRules {
  return {
    ...rules,
    deny: rules.deny.map((p) => ({
      ...p,
      level: getEffectiveLevel(p.name, config),
    })),
    require: rules.require.map((p) => ({
      ...p,
      level: getEffectiveLevel(p.name, config),
    })),
  };
}
