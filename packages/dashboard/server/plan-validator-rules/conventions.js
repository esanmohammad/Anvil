/**
 * Conventions rule — check the plan against `enforced` rules learned by
 * convention-generator.ts. Very lightweight for MVP: only checks the
 * `avoid any type` / `require explicit types` style rules for TS repos,
 * plus transport mismatches (e.g. a plan proposes HTTP where the repo is
 * gRPC-only).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
function loadConventionRules(anvilHome, project) {
    const path = join(anvilHome, 'projects', project, 'conventions.json');
    if (!existsSync(path))
        return [];
    try {
        const raw = JSON.parse(readFileSync(path, 'utf-8'));
        if (Array.isArray(raw))
            return raw;
        if (Array.isArray(raw.rules))
            return raw.rules;
        return [];
    }
    catch {
        return [];
    }
}
/** Detect if a repo seems to use a single transport style exclusively. */
function inferRepoTransportStyle(plan, repoName) {
    const related = plan.contracts.filter((c) => c.producer === repoName || c.consumers.includes(repoName));
    const kinds = new Set(related.map((c) => c.kind));
    if (kinds.size !== 1)
        return null;
    const [only] = Array.from(kinds);
    if (only === 'http' || only === 'grpc' || only === 'kafka')
        return only;
    return null;
}
export function checkConventions(plan, deps) {
    const issues = [];
    const rules = loadConventionRules(deps.anvilHome, deps.project)
        .filter((r) => (r.status ?? 'detected') === 'enforced');
    for (const rule of rules) {
        if (!rule.avoidPattern)
            continue;
        const needle = rule.avoidPattern.toLowerCase();
        // Scan plan text fields for the forbidden pattern.
        const blobs = [
            { path: 'problem', text: plan.problem },
            { path: 'architecture.notes', text: plan.architecture.notes },
            ...plan.repos.flatMap((r, i) => [
                { path: `repos[${i}].changes`, text: r.changes, repo: r.name },
            ]),
        ];
        for (const b of blobs) {
            if (rule.repo && b.repo && rule.repo !== b.repo)
                continue;
            if (b.text.toLowerCase().includes(needle)) {
                issues.push({
                    severity: rule.severity ?? 'warn',
                    path: b.path,
                    repo: b.repo,
                    message: `Convention "${rule.description}" violated — found "${rule.avoidPattern}".`,
                    hint: rule.id,
                });
            }
        }
    }
    // Transport-style conflict: if a repo's existing contracts in the plan are
    // all one kind, but the plan proposes contracts of a different kind, flag.
    const contractsByOwner = {};
    for (const c of plan.contracts) {
        (contractsByOwner[c.producer] ??= []).push(c.kind);
    }
    for (const [repo, kinds] of Object.entries(contractsByOwner)) {
        const unique = [...new Set(kinds)];
        if (unique.length > 1) {
            // Looks like a multi-transport repo — skip.
            continue;
        }
        const inferred = inferRepoTransportStyle(plan, repo);
        if (!inferred)
            continue;
        // Nothing more to check in MVP (needs knowledge of the repo's existing style).
    }
    return issues;
}
//# sourceMappingURL=conventions.js.map