/**
 * Settings + provider + memory WS routes (Recipe 7 / Phase 1).
 *
 * Read-only inspector cases for the Settings panel. All migrate cleanly:
 * each is a one-shot read with no mutation that crosses service
 * boundaries. The provider-discovery cache is owned by
 * `provider-registry.ts`; we dynamic-import it on call (matches the
 * legacy case bodies, which used closure-captured imports).
 *
 * Migrated:
 *   - get-providers          — provider discovery → typed snapshot
 *   - get-available-models   — agent-core model list
 *   - get-routing            — flow-stage chain dump (build/fix/review/…)
 *   - get-budget-status      — read budget config + today's spend
 *   - get-conventions        — load convention rules for a project
 *   - get-memory-config      — env-driven reflection toggle
 *   - list-memories          — Memory inspector view
 *   - get-auth-status        — provider key presence (API providers only)
 */
import { route } from './route.js';
import * as Z from './schemas.js';
export function settingsRoutes() {
    return {
        'get-providers': route({
            input: Z.GetProviders,
            onParseFail: 'silent',
            handle: async () => {
                const { discoverProviders } = await import('../provider-registry.js');
                const discovery = await discoverProviders();
                return {
                    providers: discovery.providers.map((p) => ({
                        name: p.name,
                        displayName: p.displayName,
                        type: p.type,
                        envVar: p.envVar,
                        binary: p.binary,
                        available: p.available,
                        tier: p.capabilities.includes('agentic') ? 'agentic' : 'chat',
                        capabilities: p.capabilities,
                        setupHint: p.setupHint,
                    })),
                };
            },
            wireType: 'providers',
        }),
        'get-available-models': route({
            input: Z.GetAvailableModels,
            onParseFail: 'silent',
            handle: async (_input, deps) => {
                if (!deps.extras.discoverAvailableModels)
                    return;
                return await deps.extras.discoverAvailableModels();
            },
            wireType: 'available-models',
            errorMessage: (code) => `Model discovery failed: ${code}`,
        }),
        'get-routing': route({
            input: Z.GetRouting,
            onParseFail: 'silent',
            handle: async (_input, deps) => {
                const { resolveModelForStage } = await import('@esankhan3/anvil-core-pipeline');
                const { loadModelRegistry } = await import('@esankhan3/anvil-agent-core');
                const { join } = await import('node:path');
                const registry = loadModelRegistry({});
                const byId = new Map(registry.models.map((m) => [m.id, m]));
                const STAGES_BY_FLOW = {
                    build: ['clarify', 'requirements', 'repo-requirements', 'specs', 'tasks', 'build', 'validate', 'ship'],
                    fix: ['fix', 'fix-loop', 'validate'],
                    research: ['research'],
                    plan: ['plan'],
                    review: ['review'],
                };
                const annotate = (modelId) => {
                    const entry = byId.get(modelId);
                    return {
                        model: modelId,
                        tier: entry?.tier ?? 'unknown',
                        provider: entry?.provider ?? 'unknown',
                    };
                };
                const flows = {};
                for (const [flow, stages] of Object.entries(STAGES_BY_FLOW)) {
                    flows[flow] = stages.map((stage) => {
                        try {
                            const resolved = resolveModelForStage(stage);
                            const chain = [annotate(resolved.primary), ...resolved.fallbacks.map((fb) => annotate(fb.model))];
                            return { stage, chain };
                        }
                        catch (err) {
                            const message = err instanceof Error ? err.message : String(err);
                            return { stage, chain: [], error: message };
                        }
                    });
                }
                return {
                    flows,
                    stagePolicyPath: process.env.ANVIL_STAGE_POLICY ?? join(deps.extras.anvilHome, 'stage-policy.yaml'),
                    modelsYamlPath: join(deps.extras.anvilHome, 'models.yaml'),
                };
            },
            wireType: 'routing',
            errorMessage: (code) => `Routing resolve failed: ${code}`,
        }),
        'get-budget-status': route({
            input: Z.GetBudgetStatus,
            onParseFail: 'silent',
            handle: async (input, deps) => {
                const project = input.project ?? '';
                const loader = deps.extras.projectLoader;
                if (!loader)
                    return;
                let budgetConfig = {};
                try {
                    budgetConfig = loader.getBudgetConfig(project);
                }
                catch {
                    return { maxPerRun: 100, maxPerDay: 200, alertAt: 80, todaySpent: 0 };
                }
                let todaySpent = 0;
                try {
                    const { existsSync, readFileSync } = await import('node:fs');
                    const { join } = await import('node:path');
                    const indexPath = join(deps.extras.anvilHome, 'runs', 'index.jsonl');
                    if (existsSync(indexPath)) {
                        const content = readFileSync(indexPath, 'utf-8');
                        const todayStr = new Date().toISOString().slice(0, 10);
                        for (const line of content.split('\n').filter((l) => l.trim())) {
                            try {
                                const rec = JSON.parse(line);
                                if (project && rec.project && rec.project !== project)
                                    continue;
                                if (!rec.createdAt || !rec.createdAt.startsWith(todayStr))
                                    continue;
                                if (rec.totalCost?.estimatedCost > 0)
                                    todaySpent += rec.totalCost.estimatedCost;
                            }
                            catch { /* skip */ }
                        }
                    }
                }
                catch { /* ok */ }
                const modelConfig = loader.getModelForStage ? {
                    default: loader.getModelForStage(project, 'default'),
                    build: loader.getModelForStage(project, 'build'),
                    profiling: loader.getModelForStage(project, 'profiling'),
                } : {};
                return {
                    maxPerRun: budgetConfig.max_per_run,
                    maxPerDay: budgetConfig.max_per_day,
                    alertAt: budgetConfig.alert_at,
                    todaySpent,
                    modelConfig,
                };
            },
            wireType: 'budget-status',
        }),
        'get-conventions': route({
            input: Z.GetConventions,
            onParseFail: 'silent',
            handle: async (input, deps) => {
                const paths = deps.extras.conventionPaths;
                if (!paths)
                    return { rules: [] };
                try {
                    const { loadRules } = await import('@esankhan3/anvil-convention-core');
                    const rules = loadRules(paths, input.project ?? '');
                    return { rules };
                }
                catch {
                    return { rules: [] };
                }
            },
            wireType: 'conventions',
        }),
        'get-memory-config': route({
            input: Z.GetMemoryConfig,
            onParseFail: 'silent',
            handle: () => {
                const m = (process.env.ANVIL_REFLECTION ?? 'always').toLowerCase();
                const reflectionEnabled = !['off', '0', 'false', 'no'].includes(m);
                const sleeptimeIntervalMs = Number(process.env.ANVIL_SLEEPTIME_INTERVAL_MS ?? 30 * 60_000);
                return { reflectionEnabled, sleeptimeIntervalMs, mode: m };
            },
            wireType: 'memory-config',
        }),
        'list-memories': route({
            input: Z.ListMemories,
            onParseFail: 'silent',
            handle: async (input, deps) => {
                const store = deps.extras.memoryStore;
                if (!store)
                    return;
                try {
                    const { MemoryInspector } = await import('@esankhan3/anvil-memory-core');
                    const inspector = new MemoryInspector(store.unwrap());
                    const project = input.project ?? '';
                    const filter = {
                        namespace: project ? { scope: 'project', projectId: project } : undefined,
                        search: input.search,
                        kind: input.kind,
                        limit: input.limit,
                    };
                    const items = inspector.list(filter);
                    const stats = inspector.stats(filter.namespace);
                    const proposals = inspector.listProposals('pending', filter.namespace, 50);
                    return { items, stats, proposals };
                }
                catch (err) {
                    // Legacy parity — write the empty payload then a separate error frame.
                    deps.ws.send(JSON.stringify({ type: 'memories', payload: { items: [], stats: null, proposals: [] } }));
                    const message = err instanceof Error ? err.message : String(err);
                    deps.ws.send(JSON.stringify({ type: 'error', payload: { message: `Memory list failed: ${message}` } }));
                }
            },
            wireType: 'memories',
        }),
        'memory-add': route({
            input: Z.MemoryAdd,
            onParseFail: 'silent',
            handle: (input, deps) => {
                const writer = deps.extras.memoryWriter;
                if (!writer)
                    return;
                const project = input.project ?? '';
                const target = input.target ?? 'memory';
                const content = input.content ?? '';
                const result = writer.add(project, target, content);
                deps.ws.send(JSON.stringify({ type: 'memory-result', payload: result }));
                // Refresh overview (fire-and-forget — matches legacy parity).
                deps.extras.buildProjectOverview?.(project).then((o) => deps.ws.send(JSON.stringify({ type: 'overview', payload: o }))).catch(() => { });
            },
        }),
        'memory-replace': route({
            input: Z.MemoryReplace,
            onParseFail: 'silent',
            handle: (input, deps) => {
                const writer = deps.extras.memoryWriter;
                if (!writer)
                    return;
                const project = input.project ?? '';
                const target = input.target ?? 'memory';
                const oldText = input.oldText ?? '';
                const content = input.content ?? '';
                const result = writer.replace(project, target, oldText, content);
                deps.ws.send(JSON.stringify({ type: 'memory-result', payload: result }));
                deps.extras.buildProjectOverview?.(project).then((o) => deps.ws.send(JSON.stringify({ type: 'overview', payload: o }))).catch(() => { });
            },
        }),
        'memory-remove': route({
            input: Z.MemoryRemove,
            onParseFail: 'silent',
            handle: (input, deps) => {
                const writer = deps.extras.memoryWriter;
                if (!writer)
                    return;
                const project = input.project ?? '';
                const target = input.target ?? 'memory';
                const oldText = input.oldText ?? '';
                const result = writer.remove(project, target, oldText);
                deps.ws.send(JSON.stringify({ type: 'memory-result', payload: result }));
                deps.extras.buildProjectOverview?.(project).then((o) => deps.ws.send(JSON.stringify({ type: 'overview', payload: o }))).catch(() => { });
            },
        }),
        'generate-conventions': route({
            input: Z.GenerateConventions,
            handle: async (input, deps) => {
                const project = input.project ?? '';
                if (!project)
                    return { error: 'no-project' };
                const paths = deps.extras.conventionPaths;
                const loader = deps.extras.projectLoader;
                const getWorkspace = deps.extras.getWorkspaceFromConfig;
                if (!paths || !loader || !getWorkspace)
                    return { rules: [] };
                try {
                    const { join } = await import('node:path');
                    const { extractConventions, loadRules } = await import('@esankhan3/anvil-convention-core');
                    const workspace = getWorkspace(project) || join(deps.extras.anvilHome, 'workspaces', project);
                    const projectConfig = loader.getConfig?.(project);
                    const repoPaths = (projectConfig?.repos ?? []).map((r) => {
                        const rel = r.path ?? r.name ?? '';
                        return rel.startsWith('/') ? rel : join(workspace, rel);
                    });
                    extractConventions(paths, project, repoPaths);
                    const rules = loadRules(paths, project);
                    return { rules };
                }
                catch (err) {
                    // Legacy parity — emit a synthetic empty `conventions` then
                    // a separate `error` frame.
                    deps.ws.send(JSON.stringify({ type: 'conventions', payload: { rules: [] } }));
                    const message = err instanceof Error ? err.message : String(err);
                    deps.ws.send(JSON.stringify({ type: 'error', payload: { message: `Convention generation failed: ${message}` } }));
                }
            },
            wireType: 'conventions',
            errorMessage: () => 'project is required',
        }),
        'set-budget': route({
            input: Z.SetBudget,
            onParseFail: 'silent',
            handle: (input, deps) => {
                const project = input.project ?? '';
                if (!project)
                    return;
                const loader = deps.extras.projectLoader;
                if (!loader?.saveBudgetConfig)
                    return;
                try {
                    loader.saveBudgetConfig(project, {
                        max_per_run: input.maxPerRun ?? 100,
                        max_per_day: input.maxPerDay ?? 200,
                        alert_at: input.alertAt ?? 80,
                    });
                    return { success: true };
                }
                catch (err) {
                    throw err instanceof Error ? err : new Error(String(err));
                }
            },
            wireType: 'budget-saved',
        }),
        'ratify-proposal': route({
            input: Z.RatifyProposal,
            handle: async (input, deps) => {
                const store = deps.extras.memoryStore;
                if (!store)
                    return;
                try {
                    const { MemoryInspector } = await import('@esankhan3/anvil-memory-core');
                    const inspector = new MemoryInspector(store.unwrap());
                    return inspector.ratifyProposal(input.id);
                }
                catch (err) {
                    throw new Error(`Ratify failed: ${err instanceof Error ? err.message : String(err)}`);
                }
            },
            wireType: 'proposal-ratified',
            errorMessage: (code) => `Ratify failed: ${code}`,
        }),
        'reject-proposal': route({
            input: Z.RejectProposal,
            handle: async (input, deps) => {
                const store = deps.extras.memoryStore;
                if (!store)
                    return;
                try {
                    const { MemoryInspector } = await import('@esankhan3/anvil-memory-core');
                    const inspector = new MemoryInspector(store.unwrap());
                    const ok = inspector.rejectProposal(input.id, input.reason ?? 'manual reject');
                    return { ok };
                }
                catch (err) {
                    throw new Error(`Reject failed: ${err instanceof Error ? err.message : String(err)}`);
                }
            },
            wireType: 'proposal-rejected',
            errorMessage: (code) => `Reject failed: ${code}`,
        }),
        /**
         * `set-auth-key` — persist a provider's API key to `~/.anvil/.env`,
         * update `process.env` in-place so the current process picks it up,
         * invalidate the provider-discovery cache so the next `get-providers`
         * sees fresh state, and re-send the providers snapshot so the
         * Settings UI updates without a page reload.
         *
         * Provider → env-var mapping mirrors the legacy switch. Adding a
         * new provider means editing both this map AND `ALLOWED_ENV_KEYS`
         * in `dashboard-server.ts`.
         */
        'set-auth-key': route({
            input: Z.SetAuthKey,
            handle: async (input, deps) => {
                const provider = input.provider ?? '';
                const key = input.key ?? '';
                if (!provider || !key)
                    return { error: 'missing-fields' };
                const envVarMap = {
                    anthropic: 'ANTHROPIC_API_KEY',
                    adk: 'GEMINI_API_KEY',
                    openai: 'OPENAI_API_KEY',
                    gemini: 'GOOGLE_API_KEY',
                    'gemini-api': 'GOOGLE_API_KEY',
                    openrouter: 'OPENROUTER_API_KEY',
                    cohere: 'COHERE_API_KEY',
                    voyage: 'VOYAGE_API_KEY',
                    mistral: 'MISTRAL_API_KEY',
                    opencode: 'OPENCODE_API_KEY',
                };
                const envVar = envVarMap[provider];
                if (!envVar) {
                    return { error: `Unknown provider: ${provider}. Supported: ${Object.keys(envVarMap).join(', ')}` };
                }
                const { readFileSync, writeFileSync, mkdirSync } = await import('node:fs');
                const { join } = await import('node:path');
                const { discoverProviders, invalidateProviderCache } = await import('../provider-registry.js');
                try {
                    process.env[envVar] = key;
                    invalidateProviderCache();
                    const envFilePath = join(deps.extras.anvilHome, '.env');
                    let envContent = '';
                    try {
                        envContent = readFileSync(envFilePath, 'utf-8');
                    }
                    catch { /* new file */ }
                    const lineRegex = new RegExp(`^${envVar}=.*$`, 'm');
                    const newLine = `${envVar}=${key}`;
                    envContent = lineRegex.test(envContent)
                        ? envContent.replace(lineRegex, newLine)
                        : envContent.trimEnd() + (envContent ? '\n' : '') + newLine + '\n';
                    mkdirSync(deps.extras.anvilHome, { recursive: true, mode: 0o700 });
                    writeFileSync(envFilePath, envContent, { encoding: 'utf-8', mode: 0o600 });
                    console.log(`[dashboard] Set ${envVar} for provider "${provider}"`);
                    deps.ws.send(JSON.stringify({
                        type: 'auth-key-saved',
                        payload: { provider, envVar, success: true },
                    }));
                    // Re-send providers so the UI updates immediately.
                    const refreshed = await discoverProviders();
                    deps.ws.send(JSON.stringify({
                        type: 'providers',
                        payload: {
                            providers: refreshed.providers.map((p) => ({
                                name: p.name,
                                displayName: p.displayName,
                                type: p.type,
                                envVar: p.envVar,
                                binary: p.binary,
                                available: p.available,
                                capabilities: p.capabilities,
                                setupHint: p.setupHint,
                            })),
                        },
                    }));
                }
                catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    throw new Error(`Failed to save key: ${message}`);
                }
            },
            errorMessage: (code) => code === 'missing-fields' ? 'provider and key are required' : code,
        }),
        /**
         * `test-auth` — provider-specific liveness probe. Each branch makes
         * a lightweight authenticated request and reports `success: bool`
         * plus a short `error` message. The result wire-type is the same
         * regardless of outcome so the Settings UI can render success +
         * failure with one handler.
         *
         * Branches mirror the legacy switch verbatim. Adding a new provider
         * here usually also requires updating `set-auth-key`'s `envVarMap`
         * and the `provider-registry` detection.
         */
        'test-auth': route({
            input: Z.TestAuth,
            onParseFail: 'silent',
            handle: async (input, deps) => {
                const provider = input.provider ?? '';
                if (!provider) {
                    deps.ws.send(JSON.stringify({
                        type: 'auth-test-result',
                        payload: { provider, success: false, error: 'No provider specified' },
                    }));
                    return;
                }
                let success = false;
                let error = '';
                try {
                    if (provider === 'anthropic') {
                        const apiKey = process.env.ANTHROPIC_API_KEY;
                        if (!apiKey) {
                            error = 'ANTHROPIC_API_KEY not set';
                        }
                        else {
                            const res = await fetch('https://api.anthropic.com/v1/models?limit=1', {
                                headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
                                signal: AbortSignal.timeout(10000),
                            });
                            success = res.ok;
                            if (!success)
                                error = `HTTP ${res.status}: ${await res.text().catch(() => '')}`.slice(0, 200);
                        }
                    }
                    else if (provider === 'adk') {
                        // Presence-only check — ADK dispatches to either Anthropic or
                        // Gemini at runtime depending on which key the env exposes.
                        const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? process.env.ANTHROPIC_API_KEY;
                        if (!apiKey)
                            error = 'GEMINI_API_KEY / GOOGLE_API_KEY / ANTHROPIC_API_KEY not set';
                        else
                            success = true;
                    }
                    else if (provider === 'openai') {
                        const apiKey = process.env.OPENAI_API_KEY;
                        if (!apiKey) {
                            error = 'OPENAI_API_KEY not set';
                        }
                        else {
                            const res = await fetch('https://api.openai.com/v1/models', {
                                headers: { 'Authorization': `Bearer ${apiKey}` },
                                signal: AbortSignal.timeout(10000),
                            });
                            success = res.ok;
                            if (!success)
                                error = `HTTP ${res.status}: ${await res.text().catch(() => '')}`.slice(0, 200);
                        }
                    }
                    else if (provider === 'gemini-api' || provider === 'gemini') {
                        const apiKey = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY;
                        if (!apiKey) {
                            error = 'GOOGLE_API_KEY not set';
                        }
                        else {
                            // Security: use header, not query string (query params are
                            // logged in server access logs and proxy logs).
                            const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
                                headers: { 'x-goog-api-key': apiKey },
                                signal: AbortSignal.timeout(10000),
                            });
                            success = res.ok;
                            if (!success)
                                error = `HTTP ${res.status}: ${await res.text().catch(() => '')}`.slice(0, 200);
                        }
                    }
                    else if (provider === 'openrouter') {
                        const apiKey = process.env.OPENROUTER_API_KEY;
                        if (!apiKey) {
                            error = 'OPENROUTER_API_KEY not set';
                        }
                        else {
                            const res = await fetch('https://openrouter.ai/api/v1/models', {
                                headers: { 'Authorization': `Bearer ${apiKey}` },
                                signal: AbortSignal.timeout(10000),
                            });
                            success = res.ok;
                            if (!success)
                                error = `HTTP ${res.status}: ${await res.text().catch(() => '')}`.slice(0, 200);
                        }
                    }
                    else if (provider === 'opencode') {
                        const apiKey = process.env.OPENCODE_API_KEY;
                        if (!apiKey) {
                            error = 'OPENCODE_API_KEY not set';
                        }
                        else {
                            const baseUrl = (process.env.OPENCODE_BASE_URL ?? 'https://opencode.ai/zen/go/v1').replace(/\/+$/, '');
                            const res = await fetch(`${baseUrl}/models`, {
                                headers: { 'Authorization': `Bearer ${apiKey}` },
                                signal: AbortSignal.timeout(10000),
                            });
                            success = res.ok;
                            if (!success)
                                error = `HTTP ${res.status}: ${await res.text().catch(() => '')}`.slice(0, 200);
                        }
                    }
                    else if (provider === 'ollama') {
                        const host = process.env.OLLAMA_HOST || 'http://localhost:11434';
                        try {
                            const res = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(5000) });
                            success = res.ok;
                            if (!success)
                                error = 'Ollama not responding';
                        }
                        catch {
                            error = 'Cannot connect to Ollama';
                        }
                    }
                    else {
                        error = `Test not implemented for provider: ${provider}`;
                    }
                    console.log(`[dashboard] Test ${provider}: ${success ? 'OK' : error}`);
                    deps.ws.send(JSON.stringify({
                        type: 'auth-test-result',
                        payload: { provider, success, error },
                    }));
                }
                catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    deps.ws.send(JSON.stringify({
                        type: 'auth-test-result',
                        payload: { provider, success: false, error: message },
                    }));
                }
            },
        }),
        /**
         * `approve-gate` — clears the cli's `state.json` pendingApproval flag.
         * The cli polls that flag to decide whether to resume after a gate
         * stage. Dynamic-imported via `@esankhan3/anvil-cli/pipeline/state-file`
         * which lives in a sibling package.
         */
        'approve-gate': route({
            input: Z.ApproveGate,
            onParseFail: 'silent',
            handle: async (input) => {
                try {
                    const stateMod = await import('@esankhan3/anvil-cli/pipeline/state-file');
                    stateMod.clearPendingApproval();
                    return { stage: input.stage };
                }
                catch {
                    // Legacy parity — bubble up as a generic error wire-type.
                    throw new Error('Failed to approve gate');
                }
            },
            wireType: 'gate-approved',
        }),
        'get-auth-status': route({
            input: Z.GetAuthStatus,
            onParseFail: 'silent',
            handle: async () => {
                const { discoverProviders } = await import('../provider-registry.js');
                const discovery = await discoverProviders();
                const authProviders = discovery.providers
                    .filter((p) => p.type === 'api' && p.envVar)
                    .map((p) => ({ name: p.name, envVar: p.envVar, hasKey: p.available }));
                return { providers: authProviders };
            },
            wireType: 'auth-status',
        }),
    };
}
//# sourceMappingURL=settings.js.map