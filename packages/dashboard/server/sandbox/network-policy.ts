/**
 * Sandbox network policy — Phase S4.
 *
 * Implements §H.2/§H.3 of the sandbox plan. Two responsibilities:
 *
 *  1. **Resolution**: combine the per-stage NetworkPolicy (from
 *     `STAGE_SANDBOX_POLICY`) + the project overlay
 *     (`pipeline-policy.overlay.json: sandbox.network`) + the
 *     built-in package-manager allow-list. The resolution order is:
 *
 *       1. Project explicit blockList (always wins).
 *       2. Per-stage allowList.
 *       3. Project allowList.
 *       4. Built-in package-manager allow-list (npm / pip / cargo / Go / git).
 *       5. Default deny.
 *
 *  2. **Egress enforcement**: emit the docker run flags (custom bridge,
 *     dnsmasq DNS server, iptables rule) so the resolved policy is
 *     enforced at the runtime level. Linux-only — on macOS the dnsmasq
 *     + iptables apparatus runs INSIDE the docker daemon's VM, so the
 *     setup commands are emitted regardless and the daemon executes
 *     them on the Linux side.
 */

import type {
  NetworkPolicy,
  StageSandboxPolicyEntry,
} from '@esankhan3/anvil-core-pipeline/sandbox/types.js';
import { PACKAGE_MANAGER_ALLOW_LIST } from '@esankhan3/anvil-core-pipeline/routing/sandbox-policy.js';

export interface ResolveNetworkPolicyArgs {
  /** The per-stage entry from STAGE_SANDBOX_POLICY (or its merge
   *  with the per-project overlay). */
  stagePolicy: StageSandboxPolicyEntry | undefined;
  /** Project-wide overlay (pipeline-policy.overlay.json: sandbox.network). */
  projectOverlay: NetworkPolicy | undefined;
  /** Whether to layer the built-in package-manager allow-list under
   *  every container-mode stage. Default true. */
  includePackageManagerHosts?: boolean;
}

export interface ResolvedNetworkPolicy extends NetworkPolicy {
  /** Where each allow-list entry came from (telemetry). */
  sources: {
    blockList: 'project' | 'stage' | 'merged';
    allowList: Array<'stage' | 'project' | 'package-manager'>;
  };
}

/**
 * Resolve a final network policy for a stage. Returns a fully-baked
 * `NetworkPolicy` with the merged allow/block lists, ready to feed
 * into `dockerRunNetworkArgs` / `dnsmasqConfigBody`.
 */
export function resolveNetworkPolicy(
  args: ResolveNetworkPolicyArgs,
): ResolvedNetworkPolicy {
  const stage = args.stagePolicy?.limits?.network;
  const project = args.projectOverlay;
  const includePm = args.includePackageManagerHosts ?? true;

  const blockList: string[] = [];
  // Project explicit deny always wins (resolution rule 1).
  if (project?.blockList) blockList.push(...project.blockList);
  if (stage?.blockList) for (const b of stage.blockList) if (!blockList.includes(b)) blockList.push(b);

  const allowList: string[] = [];
  const sources: ResolvedNetworkPolicy['sources']['allowList'] = [];

  const addAll = (xs: readonly string[] | undefined, src: 'stage' | 'project' | 'package-manager') => {
    if (!xs) return;
    let added = false;
    for (const x of xs) {
      // Skip if explicitly blocked (resolution rule 1).
      if (blockList.includes(x)) continue;
      if (!allowList.includes(x)) {
        allowList.push(x);
        added = true;
      }
    }
    if (added && !sources.includes(src)) sources.push(src);
  };

  addAll(stage?.allowList, 'stage');
  addAll(project?.allowList, 'project');
  if (includePm) addAll(PACKAGE_MANAGER_ALLOW_LIST, 'package-manager');

  const out: ResolvedNetworkPolicy = {
    default: project?.default ?? stage?.default ?? 'deny',
    allowList,
    blockList,
    allowLoopback: project?.allowLoopback ?? stage?.allowLoopback ?? true,
    sources: {
      blockList: project?.blockList && stage?.blockList ? 'merged' : project?.blockList ? 'project' : 'stage',
      allowList: sources,
    },
  };
  if (project?.dnsResolver !== undefined) out.dnsResolver = project.dnsResolver;
  else if (stage?.dnsResolver !== undefined) out.dnsResolver = stage.dnsResolver;
  return out;
}

/**
 * Compose the `docker run` flags that enforce a NetworkPolicy.
 *
 * Returns an array of argv tokens to splice into the existing
 * `docker run` invocation — keeps the runner's responsibility purely
 * about lifecycle and offloads network detail to this module.
 *
 * The current implementation:
 *  - When `default === 'allow'` and no allowList → no flags
 *    (default-allow on the default bridge).
 *  - When `default === 'deny'` and `allowList.length === 0` and
 *    `allowLoopback === true` → `--network none` (no egress at all).
 *  - Otherwise → `--network anvil-sandbox` + `--dns <resolver>`. The
 *    network is created by `ensureSandboxNetwork()` (idempotent).
 */
export function dockerRunNetworkArgs(
  policy: ResolvedNetworkPolicy,
  opts: { networkName?: string } = {},
): string[] {
  const networkName = opts.networkName ?? 'anvil-sandbox';

  if (policy.default === 'allow' && (!policy.allowList || policy.allowList.length === 0)) {
    return [];
  }

  if (
    policy.default === 'deny' &&
    (!policy.allowList || policy.allowList.length === 0) &&
    policy.allowLoopback === true
  ) {
    // Loopback-only — special docker case is `--network none` plus the
    // userland service binds 127.0.0.1; loopback works via the
    // container's own lo interface without any bridge needed.
    return ['--network', 'none'];
  }

  const args = ['--network', networkName];
  if (policy.dnsResolver) {
    args.push('--dns', policy.dnsResolver);
  } else {
    // Default: point at the network's DNS resolver (dnsmasq sidecar
    // listens on the bridge gateway IP, conventionally 172.18.0.1).
    args.push('--dns', '127.0.0.11'); // Docker's embedded DNS
  }
  return args;
}

/**
 * Render a dnsmasq config body that resolves only the allow-listed
 * hosts. Wildcards (`*.foo.com`) become `address=/.foo.com/0.0.0.0`
 * patterns that resolve to the loopback (effectively dropping them
 * unless the iptables rule below also passes).
 *
 * Each host outside the allow-list resolves to `0.0.0.0` so even DNS
 * leaks aren't useful to a malicious payload.
 */
export function dnsmasqConfigBody(policy: ResolvedNetworkPolicy): string {
  const lines: string[] = [
    '# Generated by anvil sandbox/network-policy',
    'no-resolv',
    'server=8.8.8.8',  // upstream resolver — only consulted for allow-listed names
    'no-hosts',
    'log-facility=-',
  ];

  const allow = new Set<string>();
  for (const entry of policy.allowList ?? []) {
    if (entry === 'localhost' || entry === '127.0.0.1' || entry === '::1') continue;
    allow.add(stripWildcard(entry));
  }

  // Allow each entry (default rule = no `address=` line means
  // dnsmasq forwards to upstream).
  for (const a of allow) {
    lines.push(`server=/${a}/8.8.8.8`);
  }

  // Sinkhole everything else — wildcard match.
  if (policy.default === 'deny') {
    lines.push('address=/#/0.0.0.0');
  }

  for (const block of policy.blockList ?? []) {
    lines.push(`address=/${stripWildcard(block)}/0.0.0.0`);
  }

  return lines.join('\n') + '\n';
}

/**
 * Render the iptables rules (one per allow-list entry) that lock down
 * egress to the resolved hosts. Returned as a list of bash commands
 * the dashboard's `ensureSandboxNetwork` executes against the Docker
 * daemon's network namespace.
 *
 * S4 lands the rule shape; full iptables wiring runs in an init
 * container started by `ensureSandboxNetwork`.
 */
export function iptablesRulesForPolicy(policy: ResolvedNetworkPolicy): string[] {
  const rules: string[] = [];
  // Default policy on OUTPUT.
  if (policy.default === 'deny') {
    rules.push('iptables -P OUTPUT DROP');
  } else {
    rules.push('iptables -P OUTPUT ACCEPT');
  }
  // Always allow loopback.
  if (policy.allowLoopback !== false) {
    rules.push('iptables -A OUTPUT -o lo -j ACCEPT');
  }
  // Allow DNS to the configured resolver (so dnsmasq lookups work).
  rules.push('iptables -A OUTPUT -p udp --dport 53 -j ACCEPT');
  rules.push('iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT');

  // Allow each allow-list entry (resolved by name; iptables sees IPs
  // post-resolution at runtime).
  for (const entry of policy.allowList ?? []) {
    if (entry === 'localhost' || entry === '127.0.0.1' || entry === '::1') continue;
    rules.push(`iptables -A OUTPUT -d ${stripWildcard(entry)} -j ACCEPT`);
  }
  // Explicit blocks last.
  for (const entry of policy.blockList ?? []) {
    rules.push(`iptables -A OUTPUT -d ${stripWildcard(entry)} -j DROP`);
  }
  return rules;
}

function stripWildcard(host: string): string {
  return host.replace(/^\*\./, '').replace(/^\*\*\./, '');
}
