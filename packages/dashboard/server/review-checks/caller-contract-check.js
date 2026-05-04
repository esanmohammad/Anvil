/**
 * caller-contract-check — for "assumption" claims, verify whether all callers
 * of the target symbol guarantee the assumed precondition. If they do, the
 * finding is dropped (the assumption is safe). Uses an optional AST graph;
 * skips gracefully when one isn't provided.
 */
function isAstGraphShape(v) {
    if (!v || typeof v !== 'object')
        return false;
    const maybe = v;
    return typeof maybe.callersOf === 'function';
}
function callerMatchesPrecondition(caller, precondition) {
    const hay = (caller.snippet ?? '').toLowerCase();
    const needle = precondition.toLowerCase();
    if (hay.length === 0 || needle.length === 0)
        return false;
    // Naive: substring of precondition or any of its non-trivial words.
    if (hay.includes(needle))
        return true;
    const words = needle.split(/[^a-z0-9_]+/i).filter((w) => w.length >= 4);
    if (words.length === 0)
        return false;
    // All significant words present in the caller snippet.
    return words.every((w) => hay.includes(w));
}
/**
 * For `claimType === 'assumption'`: asks the optional astGraph for callers of
 * `finding.targetSymbol`, then checks whether each caller's snippet contains
 * the stated `assumedPrecondition`. If every caller satisfies it, drop the
 * finding. If no graph is provided, skip (pass).
 */
export function checkCallerContract(finding, _repoLocalPath, astGraph) {
    if (finding.claimType !== 'assumption') {
        return { passed: true, detail: 'skipped: claim type is not assumption' };
    }
    if (astGraph === undefined || astGraph === null) {
        return { passed: true, detail: 'skipped: no astGraph provided' };
    }
    if (!isAstGraphShape(astGraph)) {
        return { passed: true, detail: 'skipped: astGraph missing callersOf()' };
    }
    const symbol = finding.targetSymbol;
    if (!symbol) {
        return { passed: true, detail: 'skipped: no targetSymbol to resolve callers' };
    }
    const precondition = finding.assumedPrecondition;
    if (!precondition) {
        return { passed: true, detail: 'skipped: no assumedPrecondition' };
    }
    let callers;
    try {
        callers = astGraph.callersOf?.(symbol);
    }
    catch {
        return { passed: true, detail: 'skipped: astGraph threw while resolving callers' };
    }
    if (!callers || callers.length === 0) {
        return { passed: true, detail: 'skipped: no callers resolved for symbol' };
    }
    const allGuaranteed = callers.every((c) => callerMatchesPrecondition(c, precondition));
    if (allGuaranteed) {
        return {
            passed: false,
            detail: `all ${callers.length} callers guarantee precondition`,
        };
    }
    return {
        passed: true,
        detail: `callers: ${callers.length}, some do not guarantee precondition`,
    };
}
//# sourceMappingURL=caller-contract-check.js.map