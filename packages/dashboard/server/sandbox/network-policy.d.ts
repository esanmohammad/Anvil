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
import type { NetworkPolicy, StageSandboxPolicyEntry } from '@esankhan3/anvil-core-pipeline/sandbox/types.js';
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
export declare function resolveNetworkPolicy(args: ResolveNetworkPolicyArgs): ResolvedNetworkPolicy;
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
export declare function dockerRunNetworkArgs(policy: ResolvedNetworkPolicy, opts?: {
    networkName?: string;
}): string[];
/**
 * Render a dnsmasq config body that resolves only the allow-listed
 * hosts. Wildcards (`*.foo.com`) become `address=/.foo.com/0.0.0.0`
 * patterns that resolve to the loopback (effectively dropping them
 * unless the iptables rule below also passes).
 *
 * Each host outside the allow-list resolves to `0.0.0.0` so even DNS
 * leaks aren't useful to a malicious payload.
 */
export declare function dnsmasqConfigBody(policy: ResolvedNetworkPolicy): string;
/**
 * Render the iptables rules (one per allow-list entry) that lock down
 * egress to the resolved hosts. Returned as a list of bash commands
 * the dashboard's `ensureSandboxNetwork` executes against the Docker
 * daemon's network namespace.
 *
 * S4 lands the rule shape; full iptables wiring runs in an init
 * container started by `ensureSandboxNetwork`.
 */
export declare function iptablesRulesForPolicy(policy: ResolvedNetworkPolicy): string[];
//# sourceMappingURL=network-policy.d.ts.map