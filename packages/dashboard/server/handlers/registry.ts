/**
 * Top-level handler registry (Recipe 7 / Phase 1).
 *
 * `dashboard-server.ts` `handleClientMessage` consults this map first.
 * If `msg.action` matches a registered route, the route handles parse +
 * dispatch + reply and the switch is skipped entirely. Unmatched actions
 * fall through to the legacy switch so we can migrate one domain at a
 * time without breaking the rest.
 *
 * As more domain files land (`runs.ts`, `tests.ts`, etc.), each spreads
 * its route map into this aggregate via `...domainRoutes()`.
 *
 * Acceptance per the plan: `grep -c "case '"` in `dashboard-server.ts`
 * drops to 0 once every action is in this registry.
 */

import type { Handler } from './route.js';
import { planRoutes } from './plans.js';
import { reviewRoutes } from './reviews.js';
import { incidentRoutes } from './incidents.js';
import { kbRoutes } from './kb.js';
import { costRoutes } from './cost.js';
import { projectGraphRoutes } from './project-graph.js';
import { testRoutes } from './tests.js';
import { settingsRoutes } from './settings.js';
import { pauseRoutes } from './pauses.js';
import { learningsRoutes } from './learnings.js';
import { contractsRoutes } from './contracts.js';
import { ciTriageRoutes } from './ci-triage.js';
import { projectRoutes } from './projects.js';
import { runsPipelineRoutes } from './runs-pipeline.js';
import { plansSpawnRoutes } from './plans-spawn.js';
import { reviewsSpawnRoutes } from './reviews-spawn.js';
import { testsPipelineRoutes } from './tests-pipeline.js';
import { incidentsSpawnRoutes } from './incidents-spawn.js';

/** Construct the registry. Pure factory — no side effects. */
export function buildRegistry(): Record<string, Handler> {
  return {
    ...planRoutes(),
    ...reviewRoutes(),
    ...incidentRoutes(),
    ...kbRoutes(),
    ...costRoutes(),
    ...projectGraphRoutes(),
    ...testRoutes(),
    ...settingsRoutes(),
    ...pauseRoutes(),
    ...learningsRoutes(),
    ...contractsRoutes(),
    ...ciTriageRoutes(),
    ...projectRoutes(),
    // Phase 2.6 — closure-dependent pipeline + spawn migrations
    ...runsPipelineRoutes(),
    ...plansSpawnRoutes(),
    ...reviewsSpawnRoutes(),
    ...testsPipelineRoutes(),
    ...incidentsSpawnRoutes(),
  };
}

/**
 * Default singleton — boot-time cost is one object spread. Importing
 * this is cheaper than calling `buildRegistry()` at every dispatch.
 */
export const handlerRegistry: Record<string, Handler> = buildRegistry();
