/**
 * Validation + deep-merge helpers for the dashboard's policy overlay.
 *
 * `validatePolicyPatch` enforces the contract for the
 * `update-pipeline-policy` WS message — every field that lands in the
 * overlay JSON has a guard here. Server-side validation is the trust
 * boundary; the frontend can do the same checks for UX but must not be
 * relied on.
 *
 * `deepMergeOverlay` is a shallow-on-top + deep-merge-known-blocks
 * helper for the overlay file. The overlay is small + flat so we
 * intentionally don't pull in lodash.
 */

import type { PipelineStage } from './pipeline-policy-types.js';

const VALID_STAGES: readonly PipelineStage[] = ['plan', 'implement', 'review', 'test', 'ship'];
const VALID_RISK: readonly string[] = ['low', 'med'];
const VALID_BREACH: readonly string[] = ['ask', 'auto-approve', 'auto-reject'];

export interface PolicyPatch {
  enabled?: boolean;
  defaults?: {
    pauseAfter?: PipelineStage[];
    autoApproveIfRisk?: 'low' | 'med';
    autoApproveIfConfidence?: number;
  };
  cost?: {
    onBreach?: 'ask' | 'auto-approve' | 'auto-reject';
    autoApproveBelow?: number;
    graceWindowSeconds?: number;
    limits?: {
      perRun?: number;
      perProjectDaily?: number;
      perStage?: Partial<Record<PipelineStage, number>>;
    };
  };
  notifications?: {
    slack?: boolean;
    email?: boolean;
    timeoutHours?: number;
  };
  qa?: {
    enabled?: boolean;
    maxQuestionsPerStage?: number;
  };
}

export type ValidationResult = { ok: true } | { ok: false; error: string };

export function validatePolicyPatch(patch: unknown): ValidationResult {
  if (patch === null || typeof patch !== 'object') {
    return { ok: false, error: 'patch must be an object' };
  }
  const p = patch as PolicyPatch;

  if (p.enabled !== undefined && typeof p.enabled !== 'boolean') {
    return { ok: false, error: 'enabled must be boolean' };
  }

  if (p.defaults !== undefined) {
    const d = p.defaults;
    if (d === null || typeof d !== 'object') {
      return { ok: false, error: 'defaults must be an object' };
    }
    if (d.pauseAfter !== undefined) {
      if (!Array.isArray(d.pauseAfter)) {
        return { ok: false, error: 'defaults.pauseAfter must be an array' };
      }
      for (const s of d.pauseAfter) {
        if (typeof s !== 'string' || !(VALID_STAGES as readonly string[]).includes(s)) {
          return { ok: false, error: `Unknown stage: ${String(s)}` };
        }
      }
    }
    if (d.autoApproveIfRisk !== undefined) {
      if (typeof d.autoApproveIfRisk !== 'string' || !VALID_RISK.includes(d.autoApproveIfRisk)) {
        return { ok: false, error: 'defaults.autoApproveIfRisk must be "low" or "med"' };
      }
    }
    if (d.autoApproveIfConfidence !== undefined) {
      const c = d.autoApproveIfConfidence;
      if (typeof c !== 'number' || c < 0 || c > 1 || Number.isNaN(c)) {
        return { ok: false, error: 'defaults.autoApproveIfConfidence must be in [0, 1]' };
      }
    }
  }

  if (p.cost !== undefined) {
    const c = p.cost;
    if (c === null || typeof c !== 'object') {
      return { ok: false, error: 'cost must be an object' };
    }
    if (c.onBreach !== undefined) {
      if (typeof c.onBreach !== 'string' || !VALID_BREACH.includes(c.onBreach)) {
        return { ok: false, error: 'cost.onBreach must be one of "ask", "auto-approve", "auto-reject"' };
      }
    }
    if (c.autoApproveBelow !== undefined) {
      if (typeof c.autoApproveBelow !== 'number' || c.autoApproveBelow < 0) {
        return { ok: false, error: 'cost.autoApproveBelow must be >= 0' };
      }
    }
    if (c.graceWindowSeconds !== undefined) {
      if (typeof c.graceWindowSeconds !== 'number' || c.graceWindowSeconds < 10 || c.graceWindowSeconds > 600) {
        return { ok: false, error: 'cost.graceWindowSeconds must be in [10, 600]' };
      }
    }
    if (c.limits !== undefined) {
      if (c.limits === null || typeof c.limits !== 'object') {
        return { ok: false, error: 'cost.limits must be an object' };
      }
      if (c.limits.perRun !== undefined && (typeof c.limits.perRun !== 'number' || c.limits.perRun < 0)) {
        return { ok: false, error: 'cost.limits.perRun must be >= 0' };
      }
      if (c.limits.perProjectDaily !== undefined
          && (typeof c.limits.perProjectDaily !== 'number' || c.limits.perProjectDaily < 0)) {
        return { ok: false, error: 'cost.limits.perProjectDaily must be >= 0' };
      }
      if (c.limits.perStage !== undefined) {
        const ps = c.limits.perStage;
        if (ps === null || typeof ps !== 'object') {
          return { ok: false, error: 'cost.limits.perStage must be an object' };
        }
        for (const [k, v] of Object.entries(ps)) {
          if (!(VALID_STAGES as readonly string[]).includes(k)) {
            return { ok: false, error: `cost.limits.perStage: unknown stage "${k}"` };
          }
          if (typeof v !== 'number' || v < 0) {
            return { ok: false, error: `cost.limits.perStage.${k} must be >= 0` };
          }
        }
      }
    }
  }

  if (p.notifications !== undefined) {
    const n = p.notifications;
    if (n === null || typeof n !== 'object') {
      return { ok: false, error: 'notifications must be an object' };
    }
    if (n.slack !== undefined && typeof n.slack !== 'boolean') {
      return { ok: false, error: 'notifications.slack must be boolean' };
    }
    if (n.email !== undefined && typeof n.email !== 'boolean') {
      return { ok: false, error: 'notifications.email must be boolean' };
    }
    if (n.timeoutHours !== undefined) {
      const t = n.timeoutHours;
      if (typeof t !== 'number' || t < 0.25 || t > 168) {
        return { ok: false, error: 'notifications.timeoutHours must be in [0.25, 168]' };
      }
    }
  }

  if (p.qa !== undefined) {
    const q = p.qa;
    if (q === null || typeof q !== 'object') {
      return { ok: false, error: 'qa must be an object' };
    }
    if (q.enabled !== undefined && typeof q.enabled !== 'boolean') {
      return { ok: false, error: 'qa.enabled must be boolean' };
    }
    if (q.maxQuestionsPerStage !== undefined) {
      const m = q.maxQuestionsPerStage;
      if (typeof m !== 'number' || !Number.isInteger(m) || m < 0 || m > 20) {
        return { ok: false, error: 'qa.maxQuestionsPerStage must be an integer in [0, 20]' };
      }
    }
  }

  return { ok: true };
}

/**
 * Merge `patch` onto `existing`. Top-level keys overwrite; nested
 * `defaults`, `cost`, `cost.limits`, `notifications`, `qa` deep-merge.
 */
export function deepMergeOverlay(
  existing: Record<string, unknown>,
  patch: PolicyPatch,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...existing };

  if (patch.enabled !== undefined) out.enabled = patch.enabled;

  if (patch.defaults !== undefined) {
    out.defaults = {
      ...((existing.defaults as Record<string, unknown> | undefined) ?? {}),
      ...patch.defaults,
    };
  }

  if (patch.cost !== undefined) {
    const baseCost = (existing.cost as Record<string, unknown> | undefined) ?? {};
    const baseLimits = (baseCost.limits as Record<string, unknown> | undefined) ?? {};
    const patchLimits = patch.cost.limits;
    const mergedCost: Record<string, unknown> = { ...baseCost, ...patch.cost };
    if (patchLimits !== undefined || baseLimits) {
      const basePerStage = (baseLimits.perStage as Record<string, unknown> | undefined) ?? {};
      const patchPerStage = patchLimits?.perStage;
      mergedCost.limits = {
        ...baseLimits,
        ...(patchLimits ?? {}),
        ...(patchPerStage !== undefined || Object.keys(basePerStage).length > 0
          ? { perStage: { ...basePerStage, ...(patchPerStage ?? {}) } }
          : {}),
      };
    }
    out.cost = mergedCost;
  }

  if (patch.notifications !== undefined) {
    out.notifications = {
      ...((existing.notifications as Record<string, unknown> | undefined) ?? {}),
      ...patch.notifications,
    };
  }

  if (patch.qa !== undefined) {
    out.qa = {
      ...((existing.qa as Record<string, unknown> | undefined) ?? {}),
      ...patch.qa,
    };
  }

  return out;
}
