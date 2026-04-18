// Rule merger — Section E.4

import type { RuleSet, ConventionRule } from './types.js';

/**
 * Deep merge two rule sets by rule ID.
 * Override rules replace default rules with the same ID.
 * New rules in overrides are appended.
 */
export function mergeRules(defaults: RuleSet, overrides: RuleSet): RuleSet {
  const overrideMap = new Map<string, ConventionRule>();
  for (const rule of overrides.rules) {
    overrideMap.set(rule.id, rule);
  }

  const mergedRules: ConventionRule[] = [];

  // Merge existing default rules with overrides
  for (const defaultRule of defaults.rules) {
    const override = overrideMap.get(defaultRule.id);
    if (override) {
      // Deep merge: override fields take precedence
      mergedRules.push({
        ...defaultRule,
        ...override,
        id: defaultRule.id, // preserve ID
      });
      overrideMap.delete(defaultRule.id);
    } else {
      mergedRules.push({ ...defaultRule });
    }
  }

  // Append remaining override rules that weren't in defaults
  for (const rule of overrideMap.values()) {
    mergedRules.push({ ...rule });
  }

  return {
    name: overrides.name || defaults.name,
    language: overrides.language || defaults.language,
    version: overrides.version || defaults.version,
    rules: mergedRules,
  };
}
