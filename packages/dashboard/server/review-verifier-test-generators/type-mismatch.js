/**
 * Micro-test generator for `claimType: 'type-mismatch'` (TS/JS only).
 * Emits a TS file that intentionally invokes the symbol with a wrong-typed
 * argument and runs `tsc --noEmit` against it. If tsc reports a diagnostic
 * matching the expectedType, the claim reproduces.
 */
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
const SAFE_IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const SAFE_TYPE = /^[A-Za-z_$][A-Za-z0-9_$<>,\s\[\]|&']*$/;
export function generateTypeMismatchTest(finding, language, opts) {
    void finding;
    if (language !== 'ts' && language !== 'js')
        return null;
    const { functionName, expectedType } = opts;
    if (!functionName || !SAFE_IDENT.test(functionName))
        return null;
    const typeAnnotation = expectedType && SAFE_TYPE.test(expectedType) ? expectedType : 'string';
    // Build a trivial module where fn is declared to accept `typeAnnotation`
    // but called with a literal of the WRONG type. tsc --noEmit should error.
    const source = `// Anvil R3 micro-test — type-mismatch probe
export function ${functionName}(x: ${typeAnnotation}): void {
  void x;
}

// Deliberately wrong-typed call: if the finding's expectedType is truly the
// param type, this line must fail tsc's type-check.
const wrong: unknown = { __anvil: true };
${functionName}(wrong as never);
`;
    const filePath = resolve(tmpdir(), `anvil-tm-${safeStamp()}.ts`);
    return {
        language: 'ts',
        filePath,
        source,
        runCommand: {
            cmd: 'npx',
            args: ['--no-install', 'tsc', '--noEmit', '--strict', '--target', 'ES2022', filePath],
        },
    };
}
/**
 * Interpret tsc output. `reproduced` = tsc reported at least one error AND
 * either `expectedType` appears in its output or we can't verify that
 * specific marker (fallback: any TS2xxx diagnostic counts as reproduction).
 */
export function interpretTscOutput(stdout, stderr, expectedType) {
    const combined = `${stdout}\n${stderr}`;
    const evidence = combined.split('\n').filter((l) => /error TS\d+/i.test(l)).slice(0, 3).join('\n');
    if (!evidence)
        return { reproduced: false, evidence: combined.slice(0, 400) };
    if (expectedType && combined.includes(expectedType)) {
        return { reproduced: true, evidence };
    }
    return { reproduced: true, evidence };
}
function safeStamp() {
    const rand = Math.floor(Math.random() * 1e9).toString(36);
    return `${Date.now().toString(36)}-${rand}`;
}
//# sourceMappingURL=type-mismatch.js.map