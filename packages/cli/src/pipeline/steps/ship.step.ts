/**
 * Ship step — Phase 5 port.
 *
 * Wraps cli's existing `runShipStage`. Per ADR P5 / PLAN §5.2.6, the
 * ship Step exposes a typed `prInfos` field on its output — replacing
 * the legacy `regex-match-on-stdout` approach in
 * `orchestrator.ts:1421`.
 */

import type { Step, StepContext } from '@anvil/core-pipeline';
import { runShipStage } from '../stages/ship/index.js';
import type { ShipStageResult } from '../stages/ship/index.js';
import type { AgentRunner } from '../stages/types.js';

export interface ShipInput {
  project: string;
  runId: string;
  featureSlug: string;
  repoPaths: Record<string, string>;
  branchName: string;
  validationSummary: string;
  agentRunner: AgentRunner;
  skipShip: boolean;
  cost?: { estimatedCost: number };
}

export type ShipOutput = ShipStageResult;

export const SHIP_STEP_ID = 'ship' as const;

export function createShipStep(): Step<ShipInput, ShipOutput> {
  return {
    id: SHIP_STEP_ID,
    name: 'Deploy sandbox, smoke test, open PRs',
    parallelism: 'serial',
    run: async (ctx: StepContext<ShipInput>): Promise<ShipOutput> => {
      const result = await runShipStage({
        project: ctx.input.project,
        runId: ctx.input.runId,
        featureSlug: ctx.input.featureSlug,
        repoPaths: ctx.input.repoPaths,
        branchName: ctx.input.branchName,
        validationSummary: ctx.input.validationSummary,
        agentRunner: ctx.input.agentRunner,
        skipShip: ctx.input.skipShip,
        cost: ctx.input.cost,
      });
      ctx.emit('SHIP.json', result);
      return result;
    },
  };
}
