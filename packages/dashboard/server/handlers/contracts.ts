/**
 * Contract-guard read routes (Recipe 7 / Phase 1).
 *
 * Migrated:
 *   - list-contracts    — discover OpenAPI/gRPC contracts per repo
 *   - rescan-contracts  — same plus consumer-call detection + graph build
 *
 * Both close over `projectLoader.getRepoLocalPaths` for the repo set;
 * everything else is dynamic-imported on call (matches the legacy case
 * bodies, which used module-level imports).
 */

import { route, type Handler } from './route.js';
import * as Z from './schemas.js';

export function contractsRoutes(): Record<string, Handler> {
  return {
    'list-contracts': route({
      input: Z.ListContracts,
      errorWireType: 'contracts-error',
      handle: async (input, deps) => {
        const loader = deps.extras.projectLoader;
        if (!loader) return;
        const { existsSync } = await import('node:fs');
        const { discoverContracts } = await import('../contract-discovery.js');
        const repoPaths = loader.getRepoLocalPaths(input.project);
        const contracts: unknown[] = [];
        for (const [repoName, repoPath] of Object.entries(repoPaths)) {
          if (!repoPath || !existsSync(repoPath)) continue;
          contracts.push(...discoverContracts(repoPath, repoName));
        }
        return { project: input.project, contracts };
      },
      wireType: 'contracts-list',
    }),

    'rescan-contracts': route({
      input: Z.RescanContracts,
      onParseFail: 'silent',
      errorWireType: 'contracts-error',
      handle: async (input, deps) => {
        const loader = deps.extras.projectLoader;
        if (!loader) return;
        const { existsSync } = await import('node:fs');
        const { discoverContracts } = await import('../contract-discovery.js');
        const { detectConsumerCalls } = await import('../contract-consumer-detector.js');
        const { buildContractGraph } = await import('../contract-graph-builder.js');
        const repoPaths = loader.getRepoLocalPaths(input.project);
        const contracts: unknown[] = [];
        const calls: unknown[] = [];
        for (const [repoName, repoPath] of Object.entries(repoPaths)) {
          if (!repoPath || !existsSync(repoPath)) continue;
          contracts.push(...discoverContracts(repoPath, repoName));
          calls.push(...detectConsumerCalls(repoPath, repoName));
        }
        const graph = buildContractGraph(contracts as never, calls as never);
        return { project: input.project, graph };
      },
      wireType: 'contracts-graph',
    }),
  };
}
