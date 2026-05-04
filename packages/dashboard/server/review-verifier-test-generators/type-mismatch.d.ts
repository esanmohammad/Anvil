/**
 * Micro-test generator for `claimType: 'type-mismatch'` (TS/JS only).
 * Emits a TS file that intentionally invokes the symbol with a wrong-typed
 * argument and runs `tsc --noEmit` against it. If tsc reports a diagnostic
 * matching the expectedType, the claim reproduces.
 */
import type { MicroTest, VerifierLanguage } from '../review-verifier-types.js';
export interface TypeMismatchOpts {
    functionName: string;
    expectedType?: string;
}
export declare function generateTypeMismatchTest(finding: unknown, language: VerifierLanguage, opts: TypeMismatchOpts): MicroTest | null;
/**
 * Interpret tsc output. `reproduced` = tsc reported at least one error AND
 * either `expectedType` appears in its output or we can't verify that
 * specific marker (fallback: any TS2xxx diagnostic counts as reproduction).
 */
export declare function interpretTscOutput(stdout: string, stderr: string, expectedType?: string): {
    reproduced: boolean;
    evidence: string;
};
//# sourceMappingURL=type-mismatch.d.ts.map