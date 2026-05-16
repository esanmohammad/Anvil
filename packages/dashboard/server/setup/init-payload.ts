/**
 * Init-payload sender (Phase 3 round-7 extraction from
 * `dashboard-server.ts`).
 *
 * `createInitSender(deps)` returns the `sendInit(ws)` closure called
 * for every newly-connected socket.io client. The function packs:
 *   - project summaries (from `projectLoader.listProjects`)
 *   - run history (`loadRunsSync`)
 *   - dashboard state (`readStateFile`)
 *   - feature records
 *   - tracked PRs (`trackedPRsForBroadcast`)
 *   - active runs snapshot
 *   - discovered models
 *
 * It also pre-warms the broadcaster's dedup string so the next state
 * watcher tick won't re-emit a `state` event identical to the one
 * embedded in this frame, then replays the accumulated `outputBuffer`
 * so the connecting client catches up on agent activity that fired
 * before it subscribed.
 *
 * The factory takes a `getOutputBuffer()` getter (rather than the
 * array directly) because dashboard-server rebinds `outputBuffer`
 * on every pipeline / quick-action start.
 */

import type { ProjectLoader, ProjectInfo } from '../project-loader.js';
import type { FeatureStore } from '../feature-store.js';
import type { Broadcaster, ActiveRun, ActivityEntry } from '../broadcasts.js';
import type { WsClient } from './ws-client.js';
import type {
  ProjectSummary,
  DashboardState,
} from '../dashboard-server.js';
import type { TrackedPR } from '../pipeline/pr-tracking.js';

/**
 * Discovery shape — mirrors `AvailableModelsResult` in dashboard-server.ts
 * but redeclared here to keep the module independent of the larger file.
 */
export interface AvailableModelsLike {
  providers: Array<{
    name: string;
    displayName: string;
    type: string;
    available: boolean;
    models: string[];
    tier: string;
    envVar?: string;
    binary?: string;
    setupHint?: string;
    capabilities: string[];
  }>;
  defaultModel: string;
  defaultProvider: string;
}

export interface InitSenderDeps {
  projectLoader: ProjectLoader;
  featureStore: FeatureStore;
  broadcaster: Broadcaster;
  activeRuns: Map<string, ActiveRun>;
  discoverAvailableModels: () => Promise<AvailableModelsLike>;
  loadRunsSync: () => unknown[];
  readStateFile: () => DashboardState;
  trackedPRsForBroadcast: () => Array<TrackedPR & { review: unknown }>;
  /** Returns the current outputBuffer reference (may be re-bound by pipeline / quick-action starts). */
  getOutputBuffer: () => ActivityEntry[];
}

export type SendInitFn = (ws: WsClient) => Promise<void>;

export function createInitSender(deps: InitSenderDeps): SendInitFn {
  return async function sendInit(ws: WsClient): Promise<void> {
    try {
      // Load projects and discover models in parallel to avoid waterfalls
      const [projects, availableModels] = await Promise.all([
        deps.projectLoader.listProjects(),
        deps.discoverAvailableModels().catch(
          () => ({ providers: [], defaultModel: 'sonnet', defaultProvider: 'claude' }) as AvailableModelsLike,
        ),
      ]);

      const projectInfos: ProjectSummary[] = projects.map((s: ProjectInfo) => ({
        name: s.name,
        title: s.title,
        owner: s.owner,
        lifecycle: s.lifecycle,
        repoCount: s.repos.length,
        repos: s.repos.map((r) => ({ name: r.name, language: r.language, github: r.github })),
      }));

      const runs = deps.loadRunsSync();
      const features = deps.featureStore.listFeatures();
      const state = deps.readStateFile();
      // Pre-warm the broadcaster's dedup string so the next watcher tick
      // doesn't re-emit a `state` event identical to the one embedded in
      // the init frame below.
      deps.broadcaster.primeStateDedup();

      const initFrame = JSON.stringify({
        type: 'init',
        payload: {
          projects: projectInfos, runs, state, features,
          prs: deps.trackedPRsForBroadcast(),
          activeRuns: Array.from(deps.activeRuns.values()).map((r) => ({
            id: r.id, type: r.type, project: r.project, description: r.description,
            model: r.model, status: r.status, startedAt: r.startedAt,
            activityCount: r.activities.length,
          })),
          availableModels,
        },
      });
      if (process.env.ANVIL_WS_DIAG) {
        console.warn('[srv-diag] sending init bytes=', initFrame.length,
          'readyState=', ws.readyState);
      }
      ws.send(initFrame);

      // Send accumulated output
      const buffer = deps.getOutputBuffer();
      if (buffer.length > 0) {
        ws.send(JSON.stringify({
          type: 'agent-output',
          payload: { entries: buffer },
        }));
      }
    } catch (err) {
      console.error('[dashboard] Error sending init:', err);
    }
  };
}
