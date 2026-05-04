/**
 * Micro-test generator for claims with an explicit expected value.
 * Parses "should be X" / "expected Y" out of the finding message and emits
 * a tiny probe asserting equality.
 */
import type { MicroTest, VerifierLanguage } from '../review-verifier-types.js';
export interface ParsedExpectation {
    raw: string;
    normalized: string;
}
export declare function parseExpectation(message: string | undefined): ParsedExpectation | null;
export declare function generateAssertionTest(finding: unknown, language: VerifierLanguage, functionName: string, expectation: ParsedExpectation): MicroTest | null;
//# sourceMappingURL=assertion.d.ts.map