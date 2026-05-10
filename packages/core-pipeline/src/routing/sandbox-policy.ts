/**
 * Per-stage sandbox policy table — maps each pipeline stage to its
 * default runtime mode, filesystem propagation, and resource limits.
 *
 * Lives next to `STAGE_TOOL_PERMISSIONS` (read access)
 * + `STAGE_WEB_PERMISSIONS` (web/browser tool access). Together these
 * three tables describe everything a stage is allowed to touch.
 *
 * Phase S0: every stage defaults to `mode: 'none'` so the contract is
 * exercised end-to-end without breaking today's behavior. Phase S12
 * flips `build` / `test` / `validate` / `ship` / `fix` / `fix-loop` to
 * `'container'` once the Docker runner has shipped to production.
 *
 * Read-only stages (clarify / requirements / specs / tasks / plan /
 * review / research) stay `'none'` permanently — they don't exec.
 *
 * `reflection` is `'none'` with `network: deny` (distillation only).
 *
 * See `docs/sandbox-isolation-plan.md` §F for the full rationale.
 */

import type {
  NetworkPolicy,
  SandboxLimits,
  StageSandboxPolicyEntry,
} from '../sandbox/types.js';

/** Built-in package-manager allow-list. */
export const PACKAGE_MANAGER_ALLOW_LIST: readonly string[] = Object.freeze([
  // npm / yarn / pnpm
  'registry.npmjs.org',
  'npmjs.org',
  '*.npmjs.com',
  'yarnpkg.com',
  // pip
  'pypi.org',
  'files.pythonhosted.org',
  'pypi.python.org',
  // cargo
  'crates.io',
  'static.crates.io',
  // Go modules
  'goproxy.io',
  'proxy.golang.org',
  'sum.golang.org',
  // git hosts
  'github.com',
  '*.github.com',
  '*.githubusercontent.com',
  'gitlab.com',
  '*.gitlab.com',
  // loopback (always permitted)
  'localhost',
  '127.0.0.1',
  '::1',
]);

/** Standard `network` policy used by container-mode stages. */
const PKG_NETWORK: NetworkPolicy = Object.freeze({
  default: 'deny',
  allowList: PACKAGE_MANAGER_ALLOW_LIST,
  allowLoopback: true,
}) as NetworkPolicy;

/** Pre-S12 default. Every stage runs unsandboxed; the table still
 *  lists the eventual container mode for documentation. The dashboard's
 *  pipeline-policy overlay can flip a stage to `'container'` per project
 *  even before S12 ships globally.
 */
export const STAGE_SANDBOX_POLICY: Readonly<Record<string, StageSandboxPolicyEntry>> = Object.freeze({
  // — Read-only stages (mode permanently 'none') —
  clarify: { mode: 'none', fsMode: 'none', notes: 'Q&A only — no exec' },
  requirements: { mode: 'none', fsMode: 'none', notes: 'read-only analysis' },
  'repo-requirements': { mode: 'none', fsMode: 'none', notes: 'per-repo analysis' },
  specs: { mode: 'none', fsMode: 'none', notes: 'read-only synthesis' },
  tasks: { mode: 'none', fsMode: 'none', notes: 'read-only synthesis' },
  plan: { mode: 'none', fsMode: 'none', notes: 'read-only planning' },
  review: { mode: 'none', fsMode: 'none', notes: 'read-only review' },
  research: { mode: 'none', fsMode: 'none', notes: 'read-only investigation' },
  reflection: {
    mode: 'none',
    fsMode: 'none',
    limits: { network: { default: 'deny', allowLoopback: false } },
    notes: 'distillation only — no FS, no network',
  },

  // — Implementation stages (S12: mode flipped to 'container') —
  build: {
    mode: 'container',
    fsMode: 'overlay',
    limits: {
      memoryMiB: 4096,
      cpus: 2,
      timeoutSeconds: 1800,
      pids: 1024,
      diskMiB: 8192,
      network: PKG_NETWORK,
    },
    notes: 'heavy stage — package install network needed',
  },
  test: {
    mode: 'container',
    fsMode: 'overlay',
    limits: {
      memoryMiB: 4096,
      cpus: 2,
      timeoutSeconds: 600,
      pids: 1024,
      diskMiB: 4096,
      network: PKG_NETWORK,
    },
    notes: 'npm test / pytest',
  },
  validate: {
    mode: 'container',
    fsMode: 'overlay',
    limits: {
      memoryMiB: 2048,
      cpus: 1,
      timeoutSeconds: 300,
      pids: 512,
      diskMiB: 2048,
      network: PKG_NETWORK,
    },
    notes: 'lint + smoke; tightest budget — runs many times',
  },
  ship: {
    mode: 'container',
    fsMode: 'overlay',
    limits: {
      memoryMiB: 1024,
      cpus: 1,
      timeoutSeconds: 600,
      pids: 256,
      diskMiB: 1024,
      network: {
        default: 'deny',
        allowList: ['github.com', '*.github.com', '*.githubusercontent.com', 'gitlab.com', '*.gitlab.com'],
        allowLoopback: true,
      },
    },
    notes: 'git + gh — only git hosts',
  },

  // — Ad-hoc commands —
  fix: {
    mode: 'container',
    fsMode: 'overlay',
    limits: {
      memoryMiB: 4096,
      cpus: 2,
      timeoutSeconds: 1200,
      pids: 1024,
      diskMiB: 4096,
      network: PKG_NETWORK,
    },
    notes: 'same scope as build',
  },
  'fix-loop': {
    mode: 'container',
    fsMode: 'overlay',
    limits: {
      memoryMiB: 4096,
      cpus: 2,
      timeoutSeconds: 1200,
      pids: 1024,
      diskMiB: 4096,
      network: PKG_NETWORK,
    },
    notes: 'same scope as build',
  },
});

/**
 * Look up the policy entry for a stage. Stages not in the table fall
 * back to `'none'` (no isolation, no limits) so unknown stages keep
 * working without a "missing policy" error.
 */
export function sandboxPolicyForStage(stage: string): StageSandboxPolicyEntry {
  const entry = STAGE_SANDBOX_POLICY[stage];
  if (entry) return entry;
  return { mode: 'none', fsMode: 'none', notes: 'unknown stage — defaults to none' };
}

/** True iff the stage runs inside an isolated runtime by default. */
export function stageIsSandboxed(stage: string): boolean {
  const entry = sandboxPolicyForStage(stage);
  return entry.mode !== 'none';
}

/**
 * Merge a per-project overlay (`pipeline-policy.overlay.json`'s
 * `sandbox.perStage[stage]` block) with the built-in entry. Overlay
 * fields win individually; missing fields inherit the default.
 */
export function mergeStageSandboxPolicy(
  base: StageSandboxPolicyEntry,
  overlay: Partial<StageSandboxPolicyEntry> | undefined,
): StageSandboxPolicyEntry {
  if (!overlay) return base;
  const mergedLimits = mergeLimits(base.limits, overlay.limits);
  return {
    mode: overlay.mode ?? base.mode,
    fsMode: overlay.fsMode ?? base.fsMode,
    ...(mergedLimits ? { limits: mergedLimits } : {}),
    ...(overlay.notes !== undefined ? { notes: overlay.notes } : base.notes !== undefined ? { notes: base.notes } : {}),
  };
}

function mergeLimits(a: SandboxLimits | undefined, b: SandboxLimits | undefined): SandboxLimits | undefined {
  if (!a && !b) return undefined;
  const aSafe = a ?? {};
  const bSafe = b ?? {};
  const merged: SandboxLimits = { ...aSafe, ...bSafe };
  if (aSafe.network || bSafe.network) {
    merged.network = mergeNetworkPolicy(aSafe.network, bSafe.network);
  }
  return merged;
}

function mergeNetworkPolicy(
  a: NetworkPolicy | undefined,
  b: NetworkPolicy | undefined,
): NetworkPolicy {
  const aSafe: NetworkPolicy = a ?? { default: 'deny' };
  const bSafe: Partial<NetworkPolicy> = b ?? {};
  const out: NetworkPolicy = {
    default: bSafe.default ?? aSafe.default,
  };
  const allowList = bSafe.allowList ?? aSafe.allowList;
  if (allowList !== undefined) out.allowList = allowList;
  const blockList = bSafe.blockList ?? aSafe.blockList;
  if (blockList !== undefined) out.blockList = blockList;
  const allowLoopback = bSafe.allowLoopback ?? aSafe.allowLoopback;
  if (allowLoopback !== undefined) out.allowLoopback = allowLoopback;
  const dnsResolver = bSafe.dnsResolver ?? aSafe.dnsResolver;
  if (dnsResolver !== undefined) out.dnsResolver = dnsResolver;
  return out;
}
