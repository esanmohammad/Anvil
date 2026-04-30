/**
 * Approval-gate hook — Phase 4 of core-pipeline consolidation.
 *
 * Wires a transport-agnostic responder for the `approval:gate` request
 * channel. Steps issue `await ctx.bus.request('approval:gate', { stepId,
 * stageIndex })` to pause for human approval; this hook calls the
 * injected `getApprovalDecision()` and replies via `bus.respond()`.
 *
 * cli wires `getApprovalDecision` to its state-file polling responder
 * (matches legacy `waitForApproval`); dashboard wires it to its WS
 * client. Same wire, different transport.
 *
 * Per-call timeout: relies on the bus's per-request timeout (default
 * 30 minutes). The hook itself doesn't time out — the requester does.
 */

import type { BusRequest, EventBus } from '../types.js';

export interface ApprovalRequest {
  /** Step ID requesting approval. */
  stepId: string;
  /** Optional stage index (legacy compatibility — cli persists this in the state file). */
  stageIndex?: number;
}

export type ApprovalDecision = 'approved' | 'rejected';

export interface ApprovalGateHookOptions {
  /**
   * Source of the approval decision. cli polls state file; dashboard
   * pushes to WS clients and awaits the user.
   */
  getApprovalDecision: (request: ApprovalRequest) => Promise<ApprovalDecision>;
  /**
   * Optional logger for responder errors (a thrown decision provider
   * resolves the request as 'rejected' to keep pipelines forward-progress).
   */
  onError?: (err: Error, request: ApprovalRequest) => void;
}

export interface ApprovalGateHookHandle {
  unsubscribe: () => void;
  /** Number of approval requests handled. */
  readonly handledCount: number;
  /** Most recent decision-provider error. */
  readonly lastError: Error | undefined;
}

export const APPROVAL_GATE_CHANNEL = 'approval:gate' as const;

export function attachApprovalGateHook(
  bus: EventBus,
  opts: ApprovalGateHookOptions,
): ApprovalGateHookHandle {
  let handled = 0;
  let lastError: Error | undefined;

  const off = bus.onRequest<ApprovalRequest>(
    APPROVAL_GATE_CHANNEL,
    async (req: BusRequest<ApprovalRequest>) => {
      handled += 1;
      try {
        const decision = await opts.getApprovalDecision(req.payload);
        bus.respond<ApprovalDecision>(APPROVAL_GATE_CHANNEL, req.requestId, decision);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        opts.onError?.(lastError, req.payload);
        // Default-fail closed: a thrown provider resolves as rejected so
        // the pipeline doesn't hang waiting for a response that won't come.
        bus.respond<ApprovalDecision>(APPROVAL_GATE_CHANNEL, req.requestId, 'rejected');
      }
    },
  );

  return {
    unsubscribe: off,
    get handledCount() { return handled; },
    get lastError() { return lastError; },
  };
}
