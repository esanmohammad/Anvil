/**
 * PR-review agent spawner (Phase 3 round-3 extraction from
 * `dashboard-server.ts`).
 *
 * `createReviewSpawn(deps)` returns the bundle:
 *   - `startReviewRun`      — kick off a PR review: prepasses + N persona agents
 *   - `finalizeReviewAgent` — parse each persona's output, filter, persist
 *   - `applyReviewFix`      — apply a suggestedFix patch to the PR branch
 *   - `reviewAgentContext`  — Map exposed for the agent-event router
 *
 * Behaviour is preserved verbatim; closure deps come through the
 * `deps` bag. Most heavy lifting (security prepass, convention rules,
 * plan compliance, KB context, evidence gate, R3 verifier, scope
 * matcher, convention filter, calibration, dismissals, GitHub
 * annotator) stays as dynamic imports.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { loadRules } from '@esankhan3/anvil-convention-core';
import { prIdFromUrl, } from '../review-store.js';
import { buildPlanCompliance } from '../review-plan-compliance.js';
import { runSecurityPrepass } from '../review-rules/security-prepass.js';
import { runConventionRules } from '../review-rules/conventions.js';
import { recordResolution, recordReviewCreated, formatLearningsForPrompt } from '../review-learner.js';
import { loadPrDiff, buildReviewerPrompt, normaliseFinding, severityToAnnotation, } from './review-helpers.js';
import { extractJsonBlockFromText } from './json-extract.js';
export function createReviewSpawn(deps) {
    const reviewAgentContext = new Map();
    async function startReviewRun(project, prUrl, trigger, personas, modelId, priorReview) {
        const parsed = prIdFromUrl(prUrl);
        if (!parsed)
            throw new Error(`Could not parse PR URL: ${prUrl}`);
        const { prId, repo, number } = parsed;
        const model = modelId ?? 'sonnet';
        const configWorkspace = deps.getWorkspaceFromConfig(project);
        const cwd = configWorkspace && existsSync(configWorkspace)
            ? configWorkspace
            : join(process.env.ANVIL_WORKSPACE_ROOT
                || process.env.FF_WORKSPACE_ROOT
                || join(homedir(), 'workspace'), project);
        let diffInfo;
        try {
            diffInfo = await loadPrDiff(repo, number);
        }
        catch (err) {
            throw new Error(`Failed to load PR diff (is gh auth configured?): ${err instanceof Error ? err.message : String(err)}`);
        }
        // Look up linked plan if any (best-effort).
        let linkedPlan = null;
        let linkedPlanSlug;
        try {
            const pointers = deps.planStore.listPlans(project);
            const hit = pointers.find((p) => diffInfo.title?.includes(p.slug));
            if (hit) {
                linkedPlan = deps.planStore.readCurrent(project, hit.slug);
                linkedPlanSlug = hit.slug;
            }
        }
        catch { /* ok */ }
        const now = new Date().toISOString();
        const baseReview = priorReview
            ? deps.reviewStore.bumpVersion(project, prId, {
                pr: { ...priorReview.pr, headSha: diffInfo.headSha, baseSha: diffInfo.baseSha },
                trigger,
                startedAt: now,
                completedAt: '',
                personas,
            })
            : deps.reviewStore.createReview(project, {
                id: prId,
                project,
                pr: {
                    repo, number, url: prUrl,
                    headSha: diffInfo.headSha, baseSha: diffInfo.baseSha,
                    title: diffInfo.title, author: diffInfo.author,
                },
                planSlug: linkedPlanSlug,
                trigger,
                personas,
                diffStats: { additions: diffInfo.additions, deletions: diffInfo.deletions, files: diffInfo.fileCount },
                findings: [],
                planCompliance: null,
                convention: { rulesChecked: 0, violations: 0 },
                security: { checks: [], flags: 0 },
                summary: '',
                verdict: 'comment',
                estimate: { usd: 0, seconds: 0 },
                model,
                startedAt: now,
                completedAt: '',
            });
        try {
            recordReviewCreated(deps.anvilHome, project);
        }
        catch { /* ok */ }
        deps.services.reviews.emit('review.started', { reviewId: prId, prId, personas, project });
        // ── Prepass rules (cheap, synchronous) ───────────────────────────
        const prepassFindings = [];
        try {
            const secFindings = runSecurityPrepass({ files: diffInfo.files });
            prepassFindings.push(...secFindings.map((f) => normaliseFinding(f)));
        }
        catch (err) {
            console.warn('[review] security prepass failed:', err);
        }
        try {
            const convFindings = runConventionRules({ files: diffInfo.files }, { anvilHome: deps.anvilHome, project });
            prepassFindings.push(...convFindings.map((f) => normaliseFinding(f)));
        }
        catch (err) {
            console.warn('[review] convention prepass failed:', err);
        }
        if (linkedPlan) {
            try {
                const repoLocalPaths = deps.projectLoader.getRepoLocalPaths(project);
                const featureDir = join(cwd, '.anvil', 'reviews', prId);
                const { report, findings } = buildPlanCompliance({
                    plan: linkedPlan,
                    featureDir,
                    repoLocalPaths,
                    baseBranch: 'main',
                    branch: '',
                });
                prepassFindings.push(...findings);
                deps.reviewStore.bumpVersion(project, prId, { planCompliance: report });
            }
            catch (err) {
                console.warn('[review] plan compliance failed:', err);
            }
        }
        // Incident binding (R7)
        try {
            const { checkIncidentBindings } = await import('../review-incident-bind-check.js');
            const changedFiles = diffInfo.files.map((f) => ({
                path: f.path,
                added: f.addedLines.length,
                removed: 0,
            }));
            const bindFindings = checkIncidentBindings(project, changedFiles, { boundStore: deps.boundTestsStore });
            for (const bf of bindFindings) {
                prepassFindings.push(normaliseFinding({
                    severity: 'blocker',
                    category: 'security',
                    persona: 'security',
                    file: bf.filePath,
                    line: 1,
                    snippet: '',
                    description: bf.message,
                    confidence: 'high',
                }));
            }
        }
        catch (err) {
            console.warn('[review] incident-binding check failed:', err);
        }
        if (linkedPlan) {
            try {
                const { comparePlanAgainstDiff } = await import('../review-plan-diff-comparator.js');
                const { producePlanAwareFindings } = await import('../review-plan-aware.js');
                const cmp = comparePlanAgainstDiff(linkedPlan, diffInfo.files.map((f) => ({
                    path: f.path,
                    hunks: [{
                            addedLines: f.addedLines.length,
                            removedLines: 0,
                            snippet: f.addedLines.slice(0, 5).map((l) => `+${l.text}`).join('\n'),
                        }],
                })));
                const planFindings = producePlanAwareFindings(cmp);
                for (const pf of planFindings) {
                    if (pf.kind === 'plan-ok')
                        continue;
                    prepassFindings.push(normaliseFinding({
                        severity: pf.severity === 'blocker' ? 'blocker'
                            : pf.severity === 'high' ? 'error'
                                : 'warn',
                        category: 'plan-drift',
                        persona: 'architect',
                        file: pf.filePath ?? '',
                        line: 1,
                        snippet: pf.evidence?.slice(0, 160) ?? '',
                        description: pf.message,
                        confidence: 'med',
                    }));
                }
            }
            catch (err) {
                console.warn('[review] plan-aware compare failed:', err);
            }
        }
        if (prepassFindings.length) {
            deps.reviewStore.appendFindings(project, prId, prepassFindings);
        }
        // R5 — KB context summary (best-effort)
        try {
            const { computeKbContext } = await import('../review-kb-context.js');
            const { summarizeForPrompt } = await import('../review-kb-summarizer.js');
            const repoLocalPaths = deps.projectLoader.getRepoLocalPaths(project);
            const repoNames = Object.keys(repoLocalPaths);
            const repoGraphs = {};
            for (const repoName of repoNames) {
                const graphPath = join(deps.anvilHome, 'knowledge-base', project, repoName, 'graph.json');
                if (!existsSync(graphPath))
                    continue;
                try {
                    repoGraphs[repoName] = JSON.parse(readFileSync(graphPath, 'utf-8'));
                }
                catch { /* skip unreadable graph */ }
            }
            if (Object.keys(repoGraphs).length > 0) {
                const defaultRepo = repoNames[0];
                const changed = diffInfo.files.map((f) => ({
                    repoName: defaultRepo,
                    filePath: f.path,
                }));
                const report = computeKbContext(changed, repoGraphs);
                const summary = summarizeForPrompt(report);
                deps.services.reviews.emit('review.kb-summary', {
                    reviewId: prId,
                    summary,
                    changedSymbols: report.changedSymbols.length,
                    orphans: report.orphans.length,
                });
            }
        }
        catch (err) {
            console.warn('[review] kb-context summary failed:', err);
        }
        // Spawn LLM reviewers (one per persona) in parallel.
        const currentForPrompt = deps.reviewStore.readCurrent(project, prId) ?? baseReview;
        const learnings = formatLearningsForPrompt(deps.anvilHome, project);
        const fileContents = {};
        for (const f of diffInfo.files) {
            const abs = join(cwd, f.path);
            try {
                if (existsSync(abs))
                    fileContents[f.path] = readFileSync(abs, 'utf-8');
            }
            catch { /* skip unreadable */ }
        }
        for (const persona of personas) {
            const prompt = buildReviewerPrompt(persona, currentForPrompt, diffInfo.diff, linkedPlan, learnings);
            const projectPrompt = `You are reviewing code for project "${project}".\nPersona: **${persona}**.\n${learnings}`;
            const agent = deps.agentManager.spawn({
                name: `review-${persona}-${prId}`,
                persona,
                project,
                stage: `review-${persona}`,
                prompt,
                projectPrompt,
                model,
                cwd,
                permissionMode: 'bypassPermissions',
            });
            reviewAgentContext.set(agent.id, {
                reviewId: prId, project, persona,
                repoLocalPath: cwd,
                diffText: diffInfo.diff,
                fileContents,
            });
            deps.services.agents.emit('agent.spawned', { ...agent, reviewId: prId, persona });
        }
    }
    async function finalizeReviewAgent(agentId, agent) {
        const ctx = reviewAgentContext.get(agentId);
        if (!ctx)
            return;
        reviewAgentContext.delete(agentId);
        const parsed = extractJsonBlockFromText(agent.output ?? '');
        let findings = [];
        let summary = '';
        if (parsed && typeof parsed === 'object') {
            const p = parsed;
            if (Array.isArray(p.findings)) {
                findings = p.findings.map((f) => normaliseFinding({
                    severity: (f.severity ?? 'warn'),
                    category: (f.category ?? 'correctness'),
                    persona: ctx.persona,
                    file: f.file ?? '',
                    line: f.line ?? 0,
                    snippet: f.snippet ?? '',
                    description: f.description ?? '',
                    suggestedFix: f.suggestedFix ?? null,
                    confidence: (f.confidence ?? 'med'),
                }));
            }
            if (typeof p.summary === 'string')
                summary = p.summary;
        }
        // ── World-class review gates (R2/R6/R8/R12) ──
        let filteredFindings = findings;
        // R2 — Evidence gate.
        if (ctx.repoLocalPath && ctx.diffText && ctx.fileContents) {
            try {
                const { applyEvidenceGate } = await import('../review-evidence-gate.js');
                const enriched = filteredFindings.map((f) => ({
                    ...f,
                    quoted: f.snippet,
                    targetSymbol: undefined,
                    claimType: f.category === 'security' ? 'security'
                        : f.category === 'correctness' ? 'null-deref'
                            : f.category === 'test' ? 'missing-test'
                                : f.category === 'convention' ? 'unusual-pattern'
                                    : 'other',
                }));
                const gate = await applyEvidenceGate(enriched, {
                    repoLocalPath: ctx.repoLocalPath,
                    diffText: ctx.diffText,
                    fileContents: ctx.fileContents,
                });
                const keptIds = new Set(gate.kept.map((f) => f.id));
                filteredFindings = filteredFindings.filter((f) => keptIds.has(f.id));
            }
            catch (err) {
                console.warn('[review] evidence gate failed:', err);
            }
        }
        // R3 — Executable verifier (off by default).
        if (process.env.ANVIL_REVIEW_VERIFIER === 'on' && ctx.repoLocalPath && ctx.fileContents) {
            try {
                const { verifyFindings } = await import('../review-verifier.js');
                const v = await verifyFindings(filteredFindings, {
                    repoLocalPath: ctx.repoLocalPath,
                    fileContents: ctx.fileContents,
                }, { timeoutMs: 10_000, concurrency: 3 });
                const keptIds = new Set(v.verified.map((f) => f.id));
                filteredFindings = filteredFindings.filter((f) => keptIds.has(f.id));
            }
            catch (err) {
                console.warn('[review] R3 verifier failed:', err);
            }
        }
        // R-scope — Out-of-scope persona findings.
        try {
            const { matches } = await import('../review-scope-matcher.js');
            filteredFindings = filteredFindings.filter((f) => {
                const persona = f.persona ?? ctx.persona;
                if (!persona || !f.file)
                    return true;
                return matches(persona, f.file);
            });
        }
        catch (err) {
            console.warn('[review] scope matcher failed:', err);
        }
        // R6 — Convention filter.
        try {
            const { applyConventionFilter } = await import('../review-convention-filter.js');
            const fingerprint = loadRules(deps.conventionPaths, ctx.project);
            if (fingerprint && fingerprint.length > 0) {
                const report = applyConventionFilter(filteredFindings, fingerprint);
                const keptIds = new Set(report.kept.map((f) => f.id));
                const demotedIds = new Set(report.demoted.map((f) => f.id));
                filteredFindings = filteredFindings
                    .filter((f) => keptIds.has(f.id) || demotedIds.has(f.id))
                    .map((f) => demotedIds.has(f.id)
                    ? { ...f, severity: (f.severity === 'blocker' ? 'error' : f.severity === 'error' ? 'warn' : 'info') }
                    : f);
            }
        }
        catch (err) {
            console.warn('[review] convention filter failed:', err);
        }
        try {
            const calibBundle = deps.reviewCalibrationStore.computeSnapshot(ctx.project);
            const { applyCalibration } = await import('../review-calibration-filter.js');
            filteredFindings = applyCalibration(filteredFindings, calibBundle);
        }
        catch (err) {
            console.warn('[review] calibration filter failed:', err);
        }
        try {
            filteredFindings = filteredFindings.filter((f) => {
                const fp = f.file ?? '';
                const segs = fp.split('/');
                const filePattern = segs.length > 1
                    ? `${segs.slice(0, 2).join('/')}/**/*${fp.match(/\.[^./]+$/)?.[0] ?? ''}`
                    : fp;
                return !deps.reviewDismissalStore.shouldFilter(ctx.project, {
                    personaId: f.persona ?? ctx.persona,
                    claimType: f.category ?? 'other',
                    filePattern,
                });
            });
        }
        catch (err) {
            console.warn('[review] dismissal filter failed:', err);
        }
        try {
            const current = deps.reviewStore.appendFindings(ctx.project, ctx.reviewId, filteredFindings);
            if (summary) {
                const combined = current.summary
                    ? `${current.summary} | ${ctx.persona}: ${summary}`
                    : `${ctx.persona}: ${summary}`;
                deps.reviewStore.bumpVersion(ctx.project, ctx.reviewId, {
                    summary: combined.slice(0, 800),
                    completedAt: new Date().toISOString(),
                    estimate: {
                        usd: current.estimate.usd + agent.cost.totalUsd,
                        seconds: current.estimate.seconds + Math.round(agent.cost.durationMs / 1000),
                    },
                });
            }
            deps.services.reviews.emit('review.persona-done', {
                reviewId: ctx.reviewId,
                persona: ctx.persona,
                findingCount: findings.length,
            });
            const final = deps.reviewStore.readCurrent(ctx.project, ctx.reviewId);
            if (final) {
                const anyStillRunning = Array.from(reviewAgentContext.values()).some((c) => c.reviewId === ctx.reviewId);
                if (!anyStillRunning) {
                    deps.services.reviews.emit('review.created', { review: final });
                    if (process.env.ANVIL_REVIEW_PUBLISH === 'on' && final.pr?.url) {
                        (async () => {
                            try {
                                const { postReviewAnnotations } = await import('../review-github-annotator.js');
                                const { synthesizeVerdict } = await import('../review-synthesizer.js');
                                const verdict = synthesizeVerdict(final.findings);
                                const annotations = final.findings.map((f) => ({
                                    findingId: f.id,
                                    severity: severityToAnnotation(f.severity),
                                    filePath: f.file,
                                    line: f.line || 1,
                                    body: f.description,
                                }));
                                const result = await postReviewAnnotations({
                                    prUrl: final.pr.url,
                                    annotations,
                                    verdictHeadline: verdict.headline,
                                    verdictLevel: verdict.level,
                                });
                                deps.services.reviews.emit('review.published', { reviewId: ctx.reviewId, ...result });
                            }
                            catch (err) {
                                console.warn('[review] github annotator failed:', err);
                            }
                        })();
                    }
                }
            }
        }
        catch (err) {
            deps.services.reviews.emit('review.error', {
                message: err instanceof Error ? err.message : String(err),
                reviewId: ctx.reviewId,
            });
        }
    }
    async function applyReviewFix(project, reviewId, findingId) {
        const review = deps.reviewStore.readCurrent(project, reviewId);
        if (!review)
            throw new Error(`Review ${reviewId} not found`);
        const finding = review.findings.find((f) => f.id === findingId);
        if (!finding)
            throw new Error(`Finding ${findingId} not found`);
        if (!finding.suggestedFix)
            throw new Error(`Finding ${findingId} has no suggestedFix`);
        const repoLocalPaths = deps.projectLoader.getRepoLocalPaths(project);
        const [, repoName] = review.pr.repo.split('/');
        const localPath = repoLocalPaths[repoName];
        if (!localPath || !existsSync(localPath)) {
            throw new Error(`Local clone for ${review.pr.repo} not found. Run the pipeline once first.`);
        }
        execSync(`gh pr checkout ${review.pr.number} --repo ${review.pr.repo}`, { cwd: localPath, stdio: 'pipe' });
        const tmpPatch = join(localPath, `.anvil-fix-${findingId}.patch`);
        writeFileSync(tmpPatch, finding.suggestedFix.diff, 'utf-8');
        try {
            execSync(`git apply "${tmpPatch}"`, { cwd: localPath, stdio: 'pipe' });
        }
        catch {
            execSync(`git apply --3way "${tmpPatch}"`, { cwd: localPath, stdio: 'pipe' });
        }
        execSync(`git add -A`, { cwd: localPath, stdio: 'pipe' });
        const msg = `[anvil-review] fix: ${finding.description.slice(0, 80).replace(/"/g, '\\"')}`;
        execSync(`git commit -m "${msg}"`, { cwd: localPath, stdio: 'pipe' });
        const sha = execSync(`git rev-parse HEAD`, { cwd: localPath, encoding: 'utf-8' }).trim();
        execSync(`git push`, { cwd: localPath, stdio: 'pipe' });
        const updated = deps.reviewStore.setResolution(project, reviewId, findingId, 'addressed');
        const priorResolution = review.findings.find((f) => f.id === findingId)?.resolution ?? 'pending';
        if (updated) {
            const finding2 = updated.findings.find((f) => f.id === findingId);
            if (finding2) {
                try {
                    recordResolution(deps.anvilHome, project, updated, finding2, priorResolution);
                }
                catch { /* ok */ }
            }
        }
        return sha;
    }
    return {
        startReviewRun,
        finalizeReviewAgent,
        applyReviewFix,
        reviewAgentContext,
    };
}
//# sourceMappingURL=review-spawn.js.map