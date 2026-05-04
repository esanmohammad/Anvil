/**
 * Micro-test generator for `claimType: 'other'` where the finding message
 * asserts the code throws/raises/panics. Emits a minimal probe that calls
 * the function and asserts a throw.
 */
import type { MicroTest, VerifierLanguage } from '../review-verifier-types.js';
export declare function claimMentionsThrow(message: string | undefined): boolean;
export declare function generateThrowsTest(finding: unknown, language: VerifierLanguage, functionName: string): MicroTest | null;
//# sourceMappingURL=throws.d.ts.map