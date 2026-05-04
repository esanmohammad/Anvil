/**
 * Approval-gate responder — Phase 5 of core-pipeline consolidation.
 *
 * Lifted from `orchestrator.ts:673-705` (waitForApproval). Polls the
 * dashboard state file every 500ms until `pendingApproval` clears.
 *
 * Exposed as `getApprovalDecision(stageIndex)` so it can be passed to
 * `attachApprovalGateHook(bus, { getApprovalDecision })`. Same wire,
 * different transport: dashboard provides its own WS-driven responder.
 */

import {
  setPendingApproval,
  readDashboardState,
} from './state-file.js';
import { info, warn } from '../logger.js';
import type { ApprovalRequest } from '@anvil/core-pipeline';

const APPROVAL_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Resolves `'approved'` when the dashboard clears `pendingApproval`,
 * `'rejected'` on timeout / dashboard cancel.
 *
 * Accepts the bus's `ApprovalRequest` shape; the legacy `stageIndex`
 * field is propagated to the state file when present.
 */
export async function getApprovalDecision(
  request: ApprovalRequest,
): Promise<'approved' | 'rejected'> {
  const stageIndex = request.stageIndex ?? 0;
  setPendingApproval(stageIndex);
  info(`Waiting for approval on stage ${stageIndex} (step ${request.stepId})...`);

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      clearInterval(interval);
      warn(`Approval for stage ${stageIndex} timed out after 30 minutes`);
      resolve('rejected');
    }, APPROVAL_TIMEOUT_MS);

    const interval = setInterval(() => {
      const state = readDashboardState();
      if (!state.activePipeline) {
        clearInterval(interval);
        clearTimeout(timeout);
        resolve('rejected');
        return;
      }
      if (!state.activePipeline.pendingApproval) {
        clearInterval(interval);
        clearTimeout(timeout);
        if (state.activePipeline.status === 'failed' || state.activePipeline.status === 'cancelled') {
          resolve('rejected');
        } else {
          resolve('approved');
        }
      }
    }, 500);
  });
}
