/**
 * Project overview builder (Phase 3 extraction from
 * `dashboard-server.ts`).
 *
 * `createProjectOverviewBuilder(deps)` returns a single async function
 * that reads from `memoryStore` / `projectLoader` / `featureStore` /
 * `kbManager` and renders the payload the dashboard's `get-overview`
 * route + `memory-{add,replace,remove}` echoes hand back to clients.
 */
import type { MemoryStore } from '../memory-store.js';
import type { ProjectLoader } from '../project-loader.js';
import type { FeatureStore } from '../feature-store.js';
import type { KnowledgeBaseManager, KBProjectStatus } from '../knowledge-base-manager.js';
export interface ProjectOverviewDeps {
    memoryStore: MemoryStore;
    projectLoader: ProjectLoader;
    featureStore: FeatureStore;
    kbManager: KnowledgeBaseManager;
    conventionPaths: {
        conventionsDir: string;
        rulesDir: string;
    };
}
export interface ProjectOverview {
    projectName: string;
    repos: Array<{
        name: string;
        language: string;
    }>;
    memories: Array<{
        id: string;
        key: string;
        value: string;
        category: string;
        timestamp: number;
    }>;
    conventions: string[];
    features: Array<{
        slug: string;
        description: string;
        status: string;
        totalCost: number;
        updatedAt: string;
    }>;
    kbStatus: KBProjectStatus | null;
}
export declare function createProjectOverviewBuilder(deps: ProjectOverviewDeps): (projectName: string) => Promise<ProjectOverview>;
//# sourceMappingURL=project-overview.d.ts.map