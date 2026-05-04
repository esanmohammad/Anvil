/**
 * `scrub` — orchestrator for PII/secret scrubbing (Phase 7 — ADR §M6).
 *
 * Default behavior (`ANVIL_MEMORY_SCRUB=1` or unset): regex rules from
 * `regex-rules.ts` are applied to the input string. Anything matching a
 * `'credential'`-class rule sets `hardReject = true` so the caller can
 * refuse the write entirely. PII patterns are redacted in place.
 *
 * `ANVIL_MEMORY_SCRUB=0` disables the scrubber (input passed through
 * unchanged). Documented as unsafe — callers must opt in explicitly.
 *
 * `ANVIL_MEMORY_SCRUB=llm` is reserved for the optional LLM classifier
 * (plan §7.2.2). Stubbed in this phase: the env var is recognized but
 * the classifier itself lands when the agent-core LanguageModel registry
 * is wired into memory-core (deferred — flagged in ADR §8 Phase 7).
 */

import { SCRUB_RULES, type ScrubCategory, type ScrubRule } from './regex-rules.js';

export interface ScrubRedaction {
  rule: string;
  category: ScrubCategory;
  count: number;
}

export interface ScrubResult {
  cleaned: string;
  redactions: ScrubRedaction[];
  /**
   * Set when at least one credential-class rule matched and the
   * scrubber is configured to hard-reject (default true). Callers
   * MUST refuse the write when this is set.
   */
  hardReject: boolean;
  /** What ANVIL_MEMORY_SCRUB resolved to for this call. */
  mode: 'off' | 'regex' | 'llm';
}

export interface ScrubOptions {
  /**
   * Override the env-derived mode. Useful for tests and for callers
   * that want to scrub without honoring the global switch.
   */
  mode?: 'off' | 'regex' | 'llm';
  /**
   * If false, credential matches are redacted (not hard-rejected).
   * Default true — credential leaks in durable memory are too costly
   * to soft-handle.
   */
  hardRejectOnCredential?: boolean;
  /** Override the rule set (tests). */
  rules?: ScrubRule[];
}

export function resolveScrubMode(env: NodeJS.ProcessEnv = process.env): 'off' | 'regex' | 'llm' {
  const v = env.ANVIL_MEMORY_SCRUB;
  if (v === '0' || v === 'off' || v === 'false') return 'off';
  if (v === 'llm') return 'llm';
  return 'regex';
}

export function scrub(input: string, opts: ScrubOptions = {}): ScrubResult {
  const mode = opts.mode ?? resolveScrubMode();
  if (mode === 'off') {
    return { cleaned: input, redactions: [], hardReject: false, mode: 'off' };
  }

  const hardRejectOnCredential = opts.hardRejectOnCredential ?? true;
  const rules = opts.rules ?? SCRUB_RULES;
  const counts = new Map<string, ScrubRedaction>();
  let cleaned = input;
  let hardReject = false;

  for (const rule of rules) {
    rule.pattern.lastIndex = 0;
    let matchCount = 0;
    cleaned = cleaned.replace(rule.pattern, () => {
      matchCount += 1;
      return rule.placeholder;
    });
    if (matchCount > 0) {
      counts.set(rule.name, {
        rule: rule.name,
        category: rule.category,
        count: matchCount,
      });
      if (rule.category === 'credential' && hardRejectOnCredential) {
        hardReject = true;
      }
    }
  }

  return {
    cleaned,
    redactions: Array.from(counts.values()),
    hardReject,
    mode: mode === 'llm' ? 'llm' : 'regex',
  };
}

export class HardRejectError extends Error {
  readonly redactions: ScrubRedaction[];
  constructor(message: string, redactions: ScrubRedaction[]) {
    super(message);
    this.name = 'HardRejectError';
    this.redactions = redactions;
  }
}
