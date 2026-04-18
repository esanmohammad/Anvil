// Section E — Convention Types (hooks-specific)

export type EnforcementLevel = 'error' | 'warning' | 'info' | 'off';

export interface DenyPattern {
  name: string;
  pattern: string;
  flags?: string;
  message?: string;
  level: EnforcementLevel;
}

export interface RequirePattern {
  name: string;
  pattern: string;
  flags?: string;
  message?: string;
  level: EnforcementLevel;
  /** Only enforce when at least this many lines are added */
  minLines?: number;
}

export interface ConventionRules {
  deny: DenyPattern[];
  require: RequirePattern[];
  /** Glob patterns for files this rule set applies to */
  filePatterns: string[];
  /** Language scope */
  language?: string;
}

export interface ConventionViolation {
  ruleName: string;
  level: EnforcementLevel;
  message: string;
  filePath: string;
  line?: number;
  matchedText?: string;
}
