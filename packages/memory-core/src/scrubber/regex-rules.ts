/**
 * Regex-based PII/secret patterns for the Phase 7 scrubber.
 *
 * Patterns are categorized as `'credential'` (hard-reject by default — a
 * leaked API key in long-term memory is unrecoverable) or `'pii'`
 * (redact in place). Order matters when redactions overlap; the
 * orchestrator iterates these top-down.
 *
 * Each pattern has an explicit `placeholder` so the cleaned output is
 * still readable to a future user who reviews their own memory.
 */

export type ScrubCategory = 'credential' | 'pii';

export interface ScrubRule {
  name: string;
  pattern: RegExp;
  placeholder: string;
  category: ScrubCategory;
}

export const SCRUB_RULES: ScrubRule[] = [
  // ── Credentials (hard-reject by default) ──────────────────────────────
  // Order matters: more-specific patterns must come first so they win
  // before the broader `sk-...` rule consumes them.
  {
    name: 'anthropic-api-key',
    pattern: /\bsk-ant-[A-Za-z0-9_\-]{20,}\b/g,
    placeholder: '[REDACTED:anthropic-api-key]',
    category: 'credential',
  },
  {
    name: 'openai-api-key',
    pattern: /\bsk-(?!ant-)[A-Za-z0-9_\-]{20,}\b/g,
    placeholder: '[REDACTED:openai-api-key]',
    category: 'credential',
  },
  {
    name: 'github-pat',
    pattern: /\bghp_[A-Za-z0-9]{20,}\b/g,
    placeholder: '[REDACTED:github-pat]',
    category: 'credential',
  },
  {
    name: 'github-fine-grained-pat',
    pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    placeholder: '[REDACTED:github-pat]',
    category: 'credential',
  },
  {
    name: 'slack-bot-token',
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    placeholder: '[REDACTED:slack-token]',
    category: 'credential',
  },
  {
    name: 'aws-access-key-id',
    pattern: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA|AKIA|ABIA|ACCA)[0-9A-Z]{16}\b/g,
    placeholder: '[REDACTED:aws-access-key-id]',
    category: 'credential',
  },
  {
    name: 'aws-secret-access-key',
    // Heuristic — 40 base64ish chars near "aws_secret" / "AWS_SECRET".
    pattern: /\baws_secret(?:_access)?_key\b\s*[:=]\s*['"]?[A-Za-z0-9/+=]{40}\b/gi,
    placeholder: 'aws_secret_access_key=[REDACTED:aws-secret]',
    category: 'credential',
  },
  {
    name: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b/g,
    placeholder: '[REDACTED:jwt]',
    category: 'credential',
  },
  {
    name: 'private-key-block',
    pattern:
      /-----BEGIN (?:RSA |OPENSSH |EC |DSA |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |OPENSSH |EC |DSA |PGP )?PRIVATE KEY-----/g,
    placeholder: '[REDACTED:private-key]',
    category: 'credential',
  },

  // ── PII (redact in place; not hard-reject) ────────────────────────────
  {
    name: 'email',
    pattern: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g,
    placeholder: '[REDACTED:email]',
    category: 'pii',
  },
  {
    name: 'us-ssn',
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    placeholder: '[REDACTED:ssn]',
    category: 'pii',
  },
  {
    name: 'phone',
    // Conservative: 7+ digits with separators or country code prefix.
    pattern: /(?<!\d)(?:\+?\d{1,3}[ \-]?)?(?:\(\d{3}\)|\d{3})[ \-]\d{3}[ \-]\d{4}(?!\d)/g,
    placeholder: '[REDACTED:phone]',
    category: 'pii',
  },
  {
    name: 'credit-card',
    // Visa / MC / Amex / Discover, with optional separators.
    pattern: /\b(?:\d[ \-]?){13,19}\b/g,
    placeholder: '[REDACTED:credit-card]',
    category: 'pii',
  },
];
