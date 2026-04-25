/**
 * generic-parser — parse a hand-pasted or free-form stack trace into a
 * `ParsedIncident`.
 *
 * The parser recognizes five common trace formats and picks the first
 * user-code frame (skipping frames obviously rooted in node_modules, the
 * standard library, or a test runner). `externalId` is a content hash so
 * re-pasting the exact same trace idempotently resolves to the same
 * incident record.
 *
 * No new dependencies — uses `node:crypto` (Node stdlib) and pure regex.
 */
import type { FailingSymbol } from '../incident-types.js';
import { type GenericInput, type ParsedIncident } from './types.js';
export declare function parseGenericStackTrace(input: GenericInput): ParsedIncident;
/**
 * Walk the trace, picking the first frame that looks like user code.
 * Supports Node/browser v8, Python, Go, Java, and Ruby formats.
 *
 * Returns `undefined` if no recognizable frame is found.
 */
export declare function extractFailingSymbol(stackTrace: string): FailingSymbol | undefined;
//# sourceMappingURL=generic-parser.d.ts.map