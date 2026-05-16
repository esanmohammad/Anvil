/**
 * Pure review-spawn helpers (Phase 3 extraction from
 * `dashboard-server.ts`). Zero closure deps.
 *
 *   - `loadPrDiff(repo, prNumber)` — call `gh api`/`gh pr diff` and
 *     parse the unified diff into per-file added-lines.
 *   - `buildReviewerPrompt(persona, review, diff, plan, learnings)` —
 *     persona-specific prompt template.
 *   - `normaliseFinding(partial)` — fill defaults for the
 *     `ReviewFinding` shape coming back from the model.
 *   - `severityToAnnotation(s)` — map ReviewFinding severity onto the
 *     annotator's narrower severity ladder.
 */
import { newFindingId, } from '../review-store.js';
/** Load diff lines from gh CLI — input for the security + convention rules. */
export async function loadPrDiff(repo, prNumber) {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    const metaOut = await execFileAsync('gh', [
        'api', `repos/${repo}/pulls/${prNumber}`,
        '--jq', '{head: .head.sha, base: .base.sha, title: .title, author: .user.login, additions: .additions, deletions: .deletions, files: .changed_files}',
    ], { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }).catch(() => ({ stdout: '{}' }));
    const meta = (() => { try {
        return JSON.parse(metaOut.stdout);
    }
    catch {
        return {};
    } })();
    const diffOut = await execFileAsync('gh', [
        'pr', 'diff', String(prNumber), '--repo', repo,
    ], { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 }).catch(() => ({ stdout: '' }));
    const diff = diffOut.stdout;
    // Parse unified diff to extract per-file added lines.
    const files = [];
    let currentFile = null;
    let newLineNo = 0;
    for (const line of diff.split('\n')) {
        if (line.startsWith('+++ b/')) {
            currentFile = { path: line.slice(6), addedLines: [] };
            files.push(currentFile);
        }
        else if (line.startsWith('@@ ')) {
            const m = line.match(/\+(\d+)/);
            newLineNo = m ? parseInt(m[1], 10) - 1 : 0;
        }
        else if (currentFile && (line.startsWith('+') && !line.startsWith('+++'))) {
            newLineNo++;
            currentFile.addedLines.push({ lineNumber: newLineNo, text: line.slice(1) });
        }
        else if (currentFile && !line.startsWith('-') && !line.startsWith('\\')) {
            newLineNo++;
        }
    }
    return {
        diff,
        files,
        additions: meta.additions ?? 0,
        deletions: meta.deletions ?? 0,
        fileCount: meta.files ?? files.length,
        headSha: meta.head ?? '',
        baseSha: meta.base ?? '',
        title: meta.title,
        author: meta.author,
    };
}
export function buildReviewerPrompt(persona, review, diff, plan, learnings) {
    const personaRole = {
        architect: 'senior staff engineer reviewing overall design, layering, and abstraction fit',
        security: 'security engineer focused on OWASP Top 10: injection, auth, secrets, CSRF, XSS, SSRF',
        style: 'code-style reviewer enforcing this project\'s conventions (see rules below)',
        tester: 'QA engineer assessing test coverage delta, flaky patterns, missing asserts',
        domain: 'domain expert using the project memory + KB to verify business-logic correctness',
    };
    const schema = `{
  "findings": [
    {
      "severity": "blocker | error | warn | info | nit",
      "category": "correctness | security | convention | test | perf | docs | plan-drift",
      "file": "path/relative/to/repo",
      "line": 1,
      "snippet": "up to 160 chars of the problematic code",
      "description": "one-sentence actionable issue",
      "suggestedFix": { "diff": "unified diff", "rationale": "why this fix" } | null,
      "confidence": "high | med | low"
    }
  ],
  "summary": "<200 char verdict summary"
}`;
    const planBlock = plan
        ? `## Plan context\nThis PR was produced from a plan. Flag **plan-drift** findings if the diff diverges from the plan:\n\`\`\`json\n${JSON.stringify({ title: plan.title, repos: plan.repos, contracts: plan.contracts }, null, 2).slice(0, 4000)}\n\`\`\`\n`
        : '';
    return `You are a ${personaRole[persona]} reviewing PR ${review.pr.url}.

${planBlock}${learnings ? learnings + '\n' : ''}
## Diff
\`\`\`diff
${diff.slice(0, 60000)}
\`\`\`

## Your task
Review the diff from the **${persona}** perspective. Be terse. Prefer high-confidence findings. Skip style noise when a \`style\` persona exists separately (unless you ARE the style persona).

## Required output
Emit EXACTLY one fenced \`\`\`json ... \`\`\` block matching:
\`\`\`json
${schema}
\`\`\`
Findings array may be empty. No prose outside the JSON block.`;
}
/** Fill defaults for the ReviewFinding shape coming back from the model. */
export function normaliseFinding(partial) {
    return {
        id: newFindingId(),
        severity: partial.severity,
        category: partial.category,
        persona: partial.persona,
        file: partial.file,
        line: partial.line,
        snippet: partial.snippet,
        description: partial.description,
        suggestedFix: partial.suggestedFix ?? null,
        kbRef: partial.kbRef,
        cve: partial.cve,
        confidence: (partial.confidence ?? 'med'),
        resolution: 'pending',
        createdAt: new Date().toISOString(),
    };
}
/** Map ReviewFinding severity onto the annotator's narrower ladder. */
export function severityToAnnotation(s) {
    if (s === 'blocker')
        return 'blocker';
    if (s === 'error')
        return 'high';
    if (s === 'warn')
        return 'medium';
    if (s === 'nit')
        return 'low';
    return 'info';
}
//# sourceMappingURL=review-helpers.js.map