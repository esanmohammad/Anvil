/**
 * Security prepass — regex-based scan of added diff lines.
 *
 * Runs BEFORE the LLM reviewer so we catch cheap, high-signal issues
 * (hardcoded secrets, unsafe sinks, weak crypto, etc.) without burning
 * model tokens. Every finding carries persona:'security' and
 * category:'security'. Confidence reflects how much of a false-positive
 * risk the pattern has on its own.
 *
 * OWASP mapping is noted per-check. No I/O, no dependencies beyond the
 * standard library.
 */
import { type DiffInput, type ReviewFinding } from './helpers.js';
export declare function runSecurityPrepass(diff: DiffInput): ReviewFinding[];
//# sourceMappingURL=security-prepass.d.ts.map