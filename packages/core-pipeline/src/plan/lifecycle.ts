/**
 * Plan lifecycle walker — pure state machine.
 *
 * Drives a plan through its five phases:
 *
 *   idle → drafting → verifying → (refining ⇄ verifying)* → awaiting_approval
 *        → executing → reconciling → complete
 *
 * with `failed` as a terminal sink for unrecoverable errors. Auto-refine
 * is a bounded loop: it iterates verify ↔ refine until errors == 0 OR
 * the refine budget (attempts + USD) is exhausted, at which point the
 * walker yields to the user (`wait-for-user`).
 *
 * Pure: no IO. The caller (dashboard or cli) fulfills each emitted
 * `LifecycleAction` and dispatches the next event. Tests are deterministic.
 */

export type LifecycleState =
  | 'idle'
  | 'drafting'
  | 'verifying'
  | 'refining'
  | 'awaiting_approval'
  | 'executing'
  | 'reconciling'
  | 'complete'
  | 'failed';

export interface LifecycleTransition {
  from: LifecycleState;
  to: LifecycleState;
  /** ISO. */
  at: string;
  reason: string;
}

export interface LifecycleContext {
  project: string;
  slug: string;
  state: LifecycleState;
  /** Number of refine→verify loops completed so far. */
  refineAttempts: number;
  /** Cumulative USD spent on refine regens. */
  refineSpentUsd: number;
  maxRefineAttempts: number;
  maxRefineUsd: number;
  /** Last failure reason; cleared on `reset`. */
  lastError?: string;
  /** Append-only audit log of every transition. */
  history: LifecycleTransition[];
}

export type LifecycleEvent =
  /** Plan agent spawned (DRAFT phase begins). */
  | { kind: 'plan-draft-started' }
  /** Plan agent produced a parseable plan. */
  | { kind: 'plan-draft-complete' }
  /** Chain-walker exhausted — terminal. */
  | { kind: 'plan-draft-failed'; reason: string }
  /** Rule engine returned. */
  | { kind: 'verify-complete'; errors: number; autoFixableCount: number; canTargetedRegen: boolean }
  /** Auto-refine pass began (acknowledgment, doesn't change state). */
  | { kind: 'refine-started' }
  /** Auto-refine pass finished. `spentUsd` accumulates into refineSpentUsd. */
  | { kind: 'refine-complete'; spentUsd: number }
  /** Auto-refine pass aborted — hand off to user. */
  | { kind: 'refine-failed'; reason: string }
  /** User clicked Approve. */
  | { kind: 'approve' }
  /** User clicked Execute (pipeline starts). */
  | { kind: 'execute-started' }
  /** Pipeline succeeded. */
  | { kind: 'execute-complete' }
  /** Pipeline failed terminally. */
  | { kind: 'execute-failed'; reason: string }
  /** Reconciliation write succeeded — terminal success. */
  | { kind: 'reconcile-complete' }
  /** User edited a section — refine counters reset, re-verify. */
  | { kind: 'edit'; reason: string }
  /** Manual reset (cancel). */
  | { kind: 'reset' };

export type LifecycleAction =
  /** No follow-up needed. */
  | { kind: 'noop' }
  /** Run the rule engine + dispatch `verify-complete`. */
  | { kind: 'verify'; reason: string }
  /** Run autoRefinePlan + targeted regens + dispatch `refine-complete`. */
  | { kind: 'refine'; reason: string }
  /** Hand off to the user. */
  | { kind: 'wait-for-user'; reason: string }
  /** Caller should run the pipeline. */
  | { kind: 'execute'; reason: string }
  /** Caller should run reconciliation. */
  | { kind: 'reconcile'; reason: string };

export interface TransitionResult {
  next: LifecycleContext;
  action: LifecycleAction;
}

// ── Constructors ─────────────────────────────────────────────────────────

export function initLifecycle(opts: {
  project: string;
  slug: string;
  /** Max refine→verify loops. Default 3. */
  maxRefineAttempts?: number;
  /** Max cumulative refine USD. Default 1.5 (matches DEFAULT_COST_POLICY.maxPerPlanRefineUsd). */
  maxRefineUsd?: number;
}): LifecycleContext {
  return {
    project: opts.project,
    slug: opts.slug,
    state: 'idle',
    refineAttempts: 0,
    refineSpentUsd: 0,
    maxRefineAttempts: opts.maxRefineAttempts ?? 3,
    maxRefineUsd: opts.maxRefineUsd ?? 1.5,
    history: [],
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────

function rec(ctx: LifecycleContext, to: LifecycleState, reason: string): LifecycleContext {
  if (ctx.state === to) {
    // No-op self-transition: still record so the history captures the event.
    return ctx;
  }
  return {
    ...ctx,
    state: to,
    history: [...ctx.history, {
      from: ctx.state,
      to,
      at: new Date().toISOString(),
      reason,
    }],
  };
}

/** Terminal states reject all events except `reset`. */
function isTerminal(state: LifecycleState): boolean {
  return state === 'complete' || state === 'failed';
}

// ── Transition ───────────────────────────────────────────────────────────

export function transitionLifecycle(
  ctx: LifecycleContext,
  event: LifecycleEvent,
): TransitionResult {
  // Reset bypasses everything.
  if (event.kind === 'reset') {
    const cleared: LifecycleContext = {
      ...ctx,
      refineAttempts: 0,
      refineSpentUsd: 0,
      lastError: undefined,
    };
    return { next: rec(cleared, 'idle', 'reset'), action: { kind: 'noop' } };
  }

  if (isTerminal(ctx.state)) {
    // Terminal — ignore non-reset events.
    return { next: ctx, action: { kind: 'noop' } };
  }

  switch (event.kind) {
    case 'plan-draft-started':
      return {
        next: rec(ctx, 'drafting', 'plan agent spawned'),
        action: { kind: 'noop' },
      };

    case 'plan-draft-complete':
      return {
        next: rec(ctx, 'verifying', 'draft complete'),
        action: { kind: 'verify', reason: 'initial' },
      };

    case 'plan-draft-failed':
      return {
        next: rec({ ...ctx, lastError: event.reason }, 'failed', event.reason),
        action: { kind: 'noop' },
      };

    case 'verify-complete': {
      if (event.errors === 0) {
        return {
          next: rec(ctx, 'awaiting_approval', 'verifier clean'),
          action: { kind: 'wait-for-user', reason: 'approval' },
        };
      }
      const haveWork = event.autoFixableCount > 0 || event.canTargetedRegen;
      const attemptsBudget = ctx.refineAttempts < ctx.maxRefineAttempts;
      const usdBudget = ctx.refineSpentUsd < ctx.maxRefineUsd;
      if (haveWork && attemptsBudget && usdBudget) {
        return {
          next: rec(ctx, 'refining',
            `auto-refine attempt ${ctx.refineAttempts + 1}/${ctx.maxRefineAttempts} (errors=${event.errors})`),
          action: { kind: 'refine', reason: 'auto-fix issues' },
        };
      }
      // Errors remain but we can't refine — hand off to user.
      const reason = !haveWork
        ? 'no auto-fixable patches available'
        : !attemptsBudget
        ? 'refine attempt cap reached'
        : 'refine USD budget exhausted';
      return {
        next: rec(ctx, 'awaiting_approval', reason),
        action: { kind: 'wait-for-user', reason: 'errors-remain' },
      };
    }

    case 'refine-started':
      // Acknowledgment event — no state change.
      return { next: ctx, action: { kind: 'noop' } };

    case 'refine-complete':
      return {
        next: rec({
          ...ctx,
          refineAttempts: ctx.refineAttempts + 1,
          refineSpentUsd: ctx.refineSpentUsd + event.spentUsd,
        }, 'verifying', `refine pass complete (+$${event.spentUsd.toFixed(3)})`),
        action: { kind: 'verify', reason: 'after-refine' },
      };

    case 'refine-failed':
      return {
        next: rec({ ...ctx, lastError: event.reason }, 'awaiting_approval',
          `refine failed: ${event.reason}`),
        action: { kind: 'wait-for-user', reason: 'refine-failed' },
      };

    case 'approve':
      // Approval doesn't auto-execute; user still clicks Execute.
      // We stay in awaiting_approval but emit a no-op so the UI can
      // surface "approved — ready to execute".
      return { next: ctx, action: { kind: 'noop' } };

    case 'execute-started':
      return {
        next: rec(ctx, 'executing', 'pipeline started'),
        action: { kind: 'noop' },
      };

    case 'execute-complete':
      return {
        next: rec(ctx, 'reconciling', 'pipeline complete'),
        action: { kind: 'reconcile', reason: 'post-execute' },
      };

    case 'execute-failed':
      return {
        next: rec({ ...ctx, lastError: event.reason }, 'failed',
          `pipeline failed: ${event.reason}`),
        action: { kind: 'noop' },
      };

    case 'reconcile-complete':
      return {
        next: rec(ctx, 'complete', 'reconciliation written'),
        action: { kind: 'noop' },
      };

    case 'edit':
      // Any edit invalidates approval AND refine progress — re-verify
      // from scratch under a fresh budget.
      return {
        next: rec({
          ...ctx,
          refineAttempts: 0,
          refineSpentUsd: 0,
        }, 'verifying', `user edit: ${event.reason}`),
        action: { kind: 'verify', reason: 'after-edit' },
      };

    default: {
      // Exhaustiveness check — all cases handled.
      const _exhaustive: never = event;
      void _exhaustive;
      return { next: ctx, action: { kind: 'noop' } };
    }
  }
}

// ── Convenience: serializable snapshot for the WS broadcast ─────────────

export interface LifecycleSnapshot {
  project: string;
  slug: string;
  state: LifecycleState;
  refineAttempts: number;
  refineSpentUsd: number;
  maxRefineAttempts: number;
  maxRefineUsd: number;
  lastError?: string;
  history: LifecycleTransition[];
}

export function snapshotLifecycle(ctx: LifecycleContext): LifecycleSnapshot {
  return {
    project: ctx.project,
    slug: ctx.slug,
    state: ctx.state,
    refineAttempts: ctx.refineAttempts,
    refineSpentUsd: ctx.refineSpentUsd,
    maxRefineAttempts: ctx.maxRefineAttempts,
    maxRefineUsd: ctx.maxRefineUsd,
    ...(ctx.lastError !== undefined ? { lastError: ctx.lastError } : {}),
    history: ctx.history,
  };
}
