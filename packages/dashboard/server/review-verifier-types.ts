/**
 * Types for the R3 Review verifier: executable verification of findings via
 * generated micro-tests run in a sandboxed subprocess.
 */

export type VerifierLanguage = 'ts' | 'js' | 'py' | 'go' | 'unsupported';

export interface VerifierResult {
  /** The finding this result pertains to. Kept as `unknown` so the verifier
   * can operate on raw objects without importing EnrichedFinding. */
  finding: unknown;
  /** True if the verifier attempted to run and produced a definitive signal. */
  verified: boolean;
  /** Did the micro-test reproduce the claim? */
  reproduced: boolean;
  /** Snippet showing the reproduction (stderr / thrown message / tsc output). */
  evidence?: string;
  /** When the language is unsupported, tooling is missing, or no generator
   * applies, the finding is skipped (neither reproduced nor dropped). */
  skipped?: boolean;
  /** Free-form error string captured during generation or execution. */
  error?: string;
  /** Wall-clock duration spent on this finding. */
  durationMs: number;
}

export interface MicroTest {
  language: VerifierLanguage;
  /** Absolute path under an OS tmp dir where the generated source is written. */
  filePath: string;
  /** Generated test source. */
  source: string;
  /** Process to spawn in the sandbox. */
  runCommand: { cmd: string; args: string[] };
}

/**
 * Narrow helper: is `value` a non-null object that we can inspect for
 * extension fields without widening to `any`.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Safe string-field accessor for unknown finding shapes. */
export function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const v = value[key];
  return typeof v === 'string' ? v : undefined;
}
