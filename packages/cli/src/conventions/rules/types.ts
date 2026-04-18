// Convention rule types — Section E.1

export type RuleSeverity = 'error' | 'warning' | 'info';

export interface ConventionRule {
  id: string;
  name: string;
  description: string;
  severity: RuleSeverity;
  /** File glob pattern this rule applies to */
  filePattern: string;
  /** Regex pattern that must NOT appear (deny) */
  deny?: string;
  /** Regex pattern that MUST appear (require) */
  require?: string;
  /** Regex pattern that triggers a suggestion */
  trigger?: string;
  /** Suggestion message when triggered */
  message: string;
  /** Whether this rule is enabled */
  enabled: boolean;
}

export interface RuleSet {
  name: string;
  language: string;
  version: string;
  rules: ConventionRule[];
}

export interface RuleViolation {
  ruleId: string;
  ruleName: string;
  severity: RuleSeverity;
  message: string;
  filePath: string;
  line?: number;
  matchedText?: string;
}
