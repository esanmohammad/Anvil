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
    tools?: {
      perRunUsd?: number;
      perStageUsd?: number;
      perToolPerCallUsd?: number;
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
  tools?: {
    network?: WebToolPatch;
    browseHeadless?: WebToolPatch;
    browseEval?: WebToolPatch;
    browsePixel?: WebToolPatch;
  };
  sandbox?: SandboxPolicyPatch;
}

export interface SandboxPolicyPatch {
  default?: {
    runtime?: 'none' | 'docker' | 'podman' | 'firecracker' | 'gvisor';
    limits?: SandboxResourceLimitsPatch;
  };
  perStage?: Record<string, SandboxStageOverridePatch>;
  network?: SandboxNetworkPatch;
  limits?: {
    perRunWallSeconds?: number;
    perStageWallSeconds?: number;
    totalDiskMiB?: number;
  };
}

export interface SandboxStageOverridePatch {
  mode?: 'none' | 'container' | 'microVM';
  runtime?: 'none' | 'docker' | 'podman' | 'firecracker' | 'gvisor';
  fsMode?: 'overlay' | 'bind' | 'none';
  limits?: SandboxResourceLimitsPatch;
  network?: SandboxNetworkPatch;
}

export interface SandboxResourceLimitsPatch {
  memoryMiB?: number;
  cpus?: number;
  timeoutSeconds?: number;
  pids?: number;
  diskMiB?: number;
}

export interface SandboxNetworkPatch {
  default?: 'deny' | 'allow';
  allowList?: string[];
  blockList?: string[];
  allowLoopback?: boolean;
  dnsResolver?: string;
}

const VALID_RUNTIMES: readonly string[] = ['none', 'docker', 'podman', 'firecracker', 'gvisor'];
const VALID_MODES: readonly string[] = ['none', 'container', 'microVM'];
const VALID_FS_MODES: readonly string[] = ['overlay', 'bind', 'none'];
const VALID_NET_DEFAULTS: readonly string[] = ['deny', 'allow'];

export interface WebToolPatch {
  enabled?: boolean;
  stages?: string[];
  allowedDomains?: string[];
  blockedDomains?: string[];
  contexts?: string[];
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

  if (p.cost?.tools !== undefined) {
    const t = p.cost.tools;
    if (t === null || typeof t !== 'object') {
      return { ok: false, error: 'cost.tools must be an object' };
    }
    for (const key of ['perRunUsd', 'perStageUsd', 'perToolPerCallUsd'] as const) {
      const v = t[key];
      if (v !== undefined && (typeof v !== 'number' || v < 0 || Number.isNaN(v))) {
        return { ok: false, error: `cost.tools.${key} must be >= 0` };
      }
    }
  }

  if (p.tools !== undefined) {
    if (p.tools === null || typeof p.tools !== 'object') {
      return { ok: false, error: 'tools must be an object' };
    }
    for (const key of ['network', 'browseHeadless', 'browseEval', 'browsePixel'] as const) {
      const block = p.tools[key];
      if (block === undefined) continue;
      if (block === null || typeof block !== 'object') {
        return { ok: false, error: `tools.${key} must be an object` };
      }
      const r = validateWebToolBlock(block, `tools.${key}`);
      if (!r.ok) return r;
    }
  }

  if (p.sandbox !== undefined) {
    const r = validateSandboxBlock(p.sandbox);
    if (!r.ok) return r;
  }

  return { ok: true };
}

function validateSandboxBlock(s: unknown): ValidationResult {
  if (s === null || typeof s !== 'object') {
    return { ok: false, error: 'sandbox must be an object' };
  }
  const sb = s as SandboxPolicyPatch;

  if (sb.default !== undefined) {
    if (sb.default === null || typeof sb.default !== 'object') {
      return { ok: false, error: 'sandbox.default must be an object' };
    }
    if (sb.default.runtime !== undefined && !VALID_RUNTIMES.includes(sb.default.runtime)) {
      return { ok: false, error: `sandbox.default.runtime must be one of ${VALID_RUNTIMES.join(', ')}` };
    }
    if (sb.default.limits !== undefined) {
      const r = validateResourceLimits(sb.default.limits, 'sandbox.default.limits');
      if (!r.ok) return r;
    }
  }

  if (sb.perStage !== undefined) {
    if (sb.perStage === null || typeof sb.perStage !== 'object') {
      return { ok: false, error: 'sandbox.perStage must be an object' };
    }
    for (const [stage, override] of Object.entries(sb.perStage)) {
      if (typeof stage !== 'string' || stage.length === 0) {
        return { ok: false, error: 'sandbox.perStage keys must be non-empty stage names' };
      }
      if (override === null || typeof override !== 'object') {
        return { ok: false, error: `sandbox.perStage.${stage} must be an object` };
      }
      const r = validateStageOverride(override, `sandbox.perStage.${stage}`);
      if (!r.ok) return r;
    }
  }

  if (sb.network !== undefined) {
    const r = validateNetwork(sb.network, 'sandbox.network');
    if (!r.ok) return r;
  }

  if (sb.limits !== undefined) {
    if (sb.limits === null || typeof sb.limits !== 'object') {
      return { ok: false, error: 'sandbox.limits must be an object' };
    }
    for (const k of ['perRunWallSeconds', 'perStageWallSeconds', 'totalDiskMiB'] as const) {
      const v = sb.limits[k];
      if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < 0)) {
        return { ok: false, error: `sandbox.limits.${k} must be a non-negative number` };
      }
    }
  }

  return { ok: true };
}

function validateStageOverride(o: SandboxStageOverridePatch, prefix: string): ValidationResult {
  if (o.mode !== undefined && !VALID_MODES.includes(o.mode)) {
    return { ok: false, error: `${prefix}.mode must be one of ${VALID_MODES.join(', ')}` };
  }
  if (o.runtime !== undefined && !VALID_RUNTIMES.includes(o.runtime)) {
    return { ok: false, error: `${prefix}.runtime must be one of ${VALID_RUNTIMES.join(', ')}` };
  }
  if (o.fsMode !== undefined && !VALID_FS_MODES.includes(o.fsMode)) {
    return { ok: false, error: `${prefix}.fsMode must be one of ${VALID_FS_MODES.join(', ')}` };
  }
  if (o.limits !== undefined) {
    const r = validateResourceLimits(o.limits, `${prefix}.limits`);
    if (!r.ok) return r;
  }
  if (o.network !== undefined) {
    const r = validateNetwork(o.network, `${prefix}.network`);
    if (!r.ok) return r;
  }
  return { ok: true };
}

function validateResourceLimits(l: SandboxResourceLimitsPatch, prefix: string): ValidationResult {
  for (const k of ['memoryMiB', 'cpus', 'timeoutSeconds', 'pids', 'diskMiB'] as const) {
    const v = l[k];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      return { ok: false, error: `${prefix}.${k} must be a non-negative number` };
    }
  }
  return { ok: true };
}

function validateNetwork(n: SandboxNetworkPatch, prefix: string): ValidationResult {
  if (typeof n !== 'object' || n === null) {
    return { ok: false, error: `${prefix} must be an object` };
  }
  if (n.default !== undefined && !VALID_NET_DEFAULTS.includes(n.default)) {
    return { ok: false, error: `${prefix}.default must be one of ${VALID_NET_DEFAULTS.join(', ')}` };
  }
  for (const arr of ['allowList', 'blockList'] as const) {
    const v = n[arr];
    if (v === undefined) continue;
    if (!Array.isArray(v)) {
      return { ok: false, error: `${prefix}.${arr} must be an array of strings` };
    }
    for (const s of v) {
      if (typeof s !== 'string' || s.length === 0) {
        return { ok: false, error: `${prefix}.${arr} entries must be non-empty strings` };
      }
    }
  }
  if (n.allowLoopback !== undefined && typeof n.allowLoopback !== 'boolean') {
    return { ok: false, error: `${prefix}.allowLoopback must be boolean` };
  }
  if (n.dnsResolver !== undefined && (typeof n.dnsResolver !== 'string' || n.dnsResolver.length === 0)) {
    return { ok: false, error: `${prefix}.dnsResolver must be a non-empty string` };
  }
  return { ok: true };
}

function validateWebToolBlock(block: WebToolPatch, prefix: string): ValidationResult {
  if (block.enabled !== undefined && typeof block.enabled !== 'boolean') {
    return { ok: false, error: `${prefix}.enabled must be boolean` };
  }
  for (const arrKey of ['stages', 'allowedDomains', 'blockedDomains', 'contexts'] as const) {
    const v = block[arrKey];
    if (v === undefined) continue;
    if (!Array.isArray(v)) {
      return { ok: false, error: `${prefix}.${arrKey} must be an array of strings` };
    }
    for (const s of v) {
      if (typeof s !== 'string' || s.length === 0) {
        return { ok: false, error: `${prefix}.${arrKey} entries must be non-empty strings` };
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

  if (patch.tools !== undefined) {
    const baseTools = (existing.tools as Record<string, unknown> | undefined) ?? {};
    const merged: Record<string, unknown> = { ...baseTools };
    for (const key of ['network', 'browseHeadless', 'browseEval', 'browsePixel'] as const) {
      const patchBlock = patch.tools[key];
      if (patchBlock === undefined) continue;
      const baseBlock = (baseTools[key] as Record<string, unknown> | undefined) ?? {};
      merged[key] = { ...baseBlock, ...patchBlock };
    }
    out.tools = merged;
  }

  if (patch.sandbox !== undefined) {
    const baseSandbox = (existing.sandbox as Record<string, unknown> | undefined) ?? {};
    const merged: Record<string, unknown> = { ...baseSandbox };

    if (patch.sandbox.default !== undefined) {
      const baseDefault = (baseSandbox.default as Record<string, unknown> | undefined) ?? {};
      merged.default = { ...baseDefault, ...patch.sandbox.default };
    }
    if (patch.sandbox.perStage !== undefined) {
      const basePerStage = (baseSandbox.perStage as Record<string, unknown> | undefined) ?? {};
      const mergedPerStage: Record<string, unknown> = { ...basePerStage };
      for (const [stage, override] of Object.entries(patch.sandbox.perStage)) {
        const baseOverride = (basePerStage[stage] as Record<string, unknown> | undefined) ?? {};
        mergedPerStage[stage] = { ...baseOverride, ...override };
      }
      merged.perStage = mergedPerStage;
    }
    if (patch.sandbox.network !== undefined) {
      const baseNetwork = (baseSandbox.network as Record<string, unknown> | undefined) ?? {};
      merged.network = { ...baseNetwork, ...patch.sandbox.network };
    }
    if (patch.sandbox.limits !== undefined) {
      const baseLimits = (baseSandbox.limits as Record<string, unknown> | undefined) ?? {};
      merged.limits = { ...baseLimits, ...patch.sandbox.limits };
    }
    out.sandbox = merged;
  }

  return out;
}
