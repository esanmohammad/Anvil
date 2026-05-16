/**
 * Project overview builder (Phase 3 extraction from
 * `dashboard-server.ts`).
 *
 * `createProjectOverviewBuilder(deps)` returns a single async function
 * that reads from `memoryStore` / `projectLoader` / `featureStore` /
 * `kbManager` and renders the payload the dashboard's `get-overview`
 * route + `memory-{add,replace,remove}` echoes hand back to clients.
 */
import { loadRules } from '@esankhan3/anvil-convention-core';
export function createProjectOverviewBuilder(deps) {
    return async function buildProjectOverview(projectName) {
        // Memory — use per-entry timestamps (headers) instead of Date.now()
        const memoryEntries = deps.memoryStore.getEntriesWithMeta(projectName, 'memory');
        const userEntries = deps.memoryStore.getEntriesWithMeta(projectName, 'user');
        const memories = [];
        for (let i = 0; i < memoryEntries.length; i++) {
            const e = memoryEntries[i];
            memories.push({
                id: `mem-${i}`,
                key: e.content.split('\n')[0].slice(0, 80),
                value: e.content,
                category: 'memory',
                timestamp: Date.parse(e.addedAt) || 0,
            });
        }
        for (let i = 0; i < userEntries.length; i++) {
            const e = userEntries[i];
            memories.push({
                id: `user-${i}`,
                key: e.content.split('\n')[0].slice(0, 80),
                value: e.content,
                category: 'user',
                timestamp: Date.parse(e.addedAt) || 0,
            });
        }
        memories.sort((a, b) => b.timestamp - a.timestamp);
        let repos = [];
        try {
            const allProjects = await deps.projectLoader.listProjects();
            const sys = allProjects.find((s) => s.name === projectName);
            if (sys) {
                repos = sys.repos.map((r) => ({ name: r.name, language: r.language ?? '' }));
            }
        }
        catch { /* */ }
        const systemFeatures = deps.featureStore.listFeatures(projectName).map((f) => ({
            slug: f.slug,
            description: f.description,
            status: f.status,
            totalCost: f.totalCost,
            updatedAt: f.updatedAt,
        }));
        let conventions = [];
        try {
            conventions = loadRules(deps.conventionPaths, projectName)
                .map((r) => r.description || r.name);
        }
        catch { /* */ }
        let kbStatus = null;
        try {
            kbStatus = await deps.kbManager.getStatus(projectName);
        }
        catch { /* ok */ }
        return { projectName, repos, memories, conventions, features: systemFeatures, kbStatus };
    };
}
//# sourceMappingURL=project-overview.js.map