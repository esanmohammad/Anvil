/**
 * Pure JSON-extraction helpers (Phase 3 extraction from
 * `dashboard-server.ts`). Zero closure deps.
 *
 *   - `extractJsonBlock(text)` — multi-strategy JSON extraction over
 *     streamed LLM output. Used by every plan agent finalisation.
 *   - `largestBalancedSpan(text, open, close)` — find the widest
 *     balanced span (skipping string contents).
 *   - `extractJsonBlockFromText(text)` — simpler regex/heuristic
 *     variant used by the review agent finaliser.
 *   - `isValidParsedShape(parsed, section)` — gate the dispatch path
 *     against section-specific shape expectations.
 *   - `buildJsonCorrectionInput(badOutput, section)` — corrective
 *     prompt for the same-agent JSON-recovery turn.
 */
/**
 * Extract JSON from streamed agent output. Tries (in order):
 *   1. Direct parse of the trimmed output.
 *   2. Every fenced ```json / ``` block, longest first.
 *   3. Largest balanced `{...}` slice.
 *   4. Largest balanced `[...]` slice (for section regen of repos /
 *      contracts / risks where the section is an array).
 *   5. Same passes after stripping trailing commas, JS-style comments,
 *      smart quotes — common LLM artifacts that break strict JSON.parse.
 * Returns `unknown` (object / array / primitive parsed from JSON), or
 * `null` when every strategy fails.
 */
export function extractJsonBlock(text) {
    const tryParse = (s) => {
        try {
            return JSON.parse(s);
        }
        catch {
            return null;
        }
    };
    const sanitize = (s) => s
        .replace(/[\u201C\u201D]/g, '"') // smart double quotes → "
        .replace(/[\u2018\u2019]/g, "'") // smart single quotes → '
        .replace(/\/\/[^\n]*/g, '') // // line comments
        .replace(/\/\*[\s\S]*?\*\//g, '') // /* block comments */
        .replace(/,(\s*[}\]])/g, '$1'); // trailing commas
    const candidates = [];
    candidates.push(text.trim());
    const fences = [];
    const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
    let m;
    while ((m = fenceRe.exec(text)) !== null)
        fences.push(m[1].trim());
    fences.sort((a, b) => b.length - a.length);
    candidates.push(...fences);
    const objSpan = largestBalancedSpan(text, '{', '}');
    if (objSpan)
        candidates.push(objSpan);
    const arrSpan = largestBalancedSpan(text, '[', ']');
    if (arrSpan)
        candidates.push(arrSpan);
    for (const c of candidates) {
        const direct = tryParse(c);
        if (direct !== null && direct !== undefined)
            return direct;
    }
    for (const c of candidates) {
        const repaired = tryParse(sanitize(c));
        if (repaired !== null && repaired !== undefined)
            return repaired;
    }
    return null;
}
/**
 * Walk the string finding the widest balanced span between `open` and
 * `close`. String contents (including escaped quotes) are skipped so
 * braces inside strings don't break balance counting.
 */
export function largestBalancedSpan(text, open, close) {
    let bestStart = -1;
    let bestLen = 0;
    let start = -1;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (escape) {
                escape = false;
                continue;
            }
            if (ch === '\\') {
                escape = true;
                continue;
            }
            if (ch === '"')
                inString = false;
            continue;
        }
        if (ch === '"') {
            inString = true;
            continue;
        }
        if (ch === open) {
            if (depth === 0)
                start = i;
            depth++;
        }
        else if (ch === close && depth > 0) {
            depth--;
            if (depth === 0 && start >= 0) {
                const len = i - start + 1;
                if (len > bestLen) {
                    bestLen = len;
                    bestStart = start;
                }
                start = -1;
            }
        }
    }
    return bestLen > 0 ? text.slice(bestStart, bestStart + bestLen) : null;
}
/** Simpler regex/heuristic JSON extractor used by the review finaliser. */
export function extractJsonBlockFromText(text) {
    const fenceRe = /```json\s*([\s\S]*?)```/gi;
    let match;
    let last = null;
    while ((match = fenceRe.exec(text)) !== null)
        last = match[1];
    if (last) {
        try {
            return JSON.parse(last.trim());
        }
        catch { /* fall through */ }
    }
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
        try {
            return JSON.parse(text.slice(start, end + 1));
        }
        catch { /* */ }
    }
    return null;
}
/**
 * Validate the shape the model returned matches what the dispatch path
 * expects. Section `problem` is a plain string; every other section is
 * an object or array — `typeof === 'object'` covers both since arrays
 * are objects in JS.
 */
export function isValidParsedShape(parsed, section) {
    if (section === 'problem')
        return typeof parsed === 'string' && parsed.length > 0;
    return typeof parsed === 'object' && parsed !== null;
}
/**
 * Build the corrective input sent to the SAME agent when its first
 * output didn't parse. Quoting the bad output (truncated) helps the
 * model see what it actually emitted.
 */
export function buildJsonCorrectionInput(badOutput, section) {
    const expected = section === 'problem'
        ? 'a single fenced ```json ... ``` block containing ONE JSON STRING (the problem statement)'
        : section
            ? `a single fenced \`\`\`json ... \`\`\` block containing ONLY the updated "${section}" value`
            : 'a single fenced ```json ... ``` block containing the full plan object';
    const sample = badOutput.slice(0, 600);
    return [
        'Your previous output was not extractable as JSON. Do not apologise, do not explain — just emit a corrected reply.',
        '',
        'Required reply shape:',
        `  ${expected}`,
        '  No prose before or after the fenced block. No additional code fences. No comments inside.',
        '',
        `For reference, the first 600 chars of your previous output were:\n${sample}`,
        '',
        'Reply now with ONLY the fenced JSON block.',
    ].join('\n');
}
//# sourceMappingURL=json-extract.js.map