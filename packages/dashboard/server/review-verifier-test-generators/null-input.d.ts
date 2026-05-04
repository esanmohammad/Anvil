/**
 * Micro-test generator for `claimType: 'null-deref'`. Emits a small program
 * that imports or references the claimed function and calls it with null
 * or undefined, expecting a throw.
 */
import type { MicroTest, VerifierLanguage } from '../review-verifier-types.js';
export declare function generateNullInputTest(finding: unknown, language: VerifierLanguage, functionName: string): MicroTest | null;
export declare const _unusedFindingSentinel: (finding: unknown) => unknown;
//# sourceMappingURL=null-input.d.ts.map