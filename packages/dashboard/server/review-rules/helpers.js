/**
 * Shared helpers for review prepass rules.
 *
 * Pure functions only — no I/O. These helpers are used by both
 * security-prepass.ts and conventions.ts to walk added diff lines and
 * build standard ReviewFinding shapes.
 */
// ── Helpers ─────────────────────────────────────────────────────────────
/**
 * Trim a text chunk to a short, single-line-ish snippet for findings.
 * Removes trailing newlines and limits to 160 chars.
 */
export function snippet(text) {
    const trimmed = text.replace(/\r?\n+$/g, '').trim();
    if (trimmed.length <= 160)
        return trimmed;
    return trimmed.slice(0, 157) + '...';
}
/**
 * Iterate added lines across all files, yielding every regex match.
 * For each line we exec() the regex until exhausted so multi-hit lines
 * (e.g. two secrets pasted together) are not silently collapsed.
 *
 * The regex is cloned per call so accumulated lastIndex on a /g regex
 * passed in from the caller doesn't leak across matchers.
 */
export function* matchInAddedLines(diff, regex) {
    const flags = regex.flags.includes('g') ? regex.flags : regex.flags + 'g';
    for (const file of diff.files) {
        for (const line of file.addedLines) {
            const local = new RegExp(regex.source, flags);
            let m;
            while ((m = local.exec(line.text)) !== null) {
                yield {
                    file: file.path,
                    lineNumber: line.lineNumber,
                    text: line.text,
                    match: m,
                };
                // Guard against zero-width infinite loops.
                if (m.index === local.lastIndex)
                    local.lastIndex++;
            }
        }
    }
}
/**
 * Build a suggestedFix that replaces a literal secret with an env var ref.
 * The diff is a small, human-readable unified-ish hunk (not strict patch
 * format — the reviewer UI renders this as a hint, not an apply-able patch).
 */
export function envVarFix(match, varName) {
    const safeVar = varName.replace(/[^A-Z0-9_]/gi, '_').toUpperCase();
    return {
        diff: `- ${match}\n` +
            `+ process.env.${safeVar}`,
        rationale: `Never commit secrets. Move the value to an environment variable ` +
            `(e.g. ${safeVar}) loaded from a secret manager or .env file that is ` +
            `gitignored. Rotate the exposed credential immediately.`,
    };
}
//# sourceMappingURL=helpers.js.map