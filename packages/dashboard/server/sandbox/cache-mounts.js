/**
 * Package-manager cache mounts — Phase S8.
 *
 * Mounts host-side package caches into the sandbox so successive
 * builds don't re-download the world. Per §K.2 of the plan:
 *
 *   - Default: read-only (RO). Sandbox sees the user's existing cache;
 *     misses fall through to a vendor download which the sandbox
 *     CANNOT write back. Safe — a malicious package can't taint the
 *     host cache.
 *   - Per-stage opt-in: `cacheMode: 'read-write'` for `build` lets
 *     `npm install` populate the host cache (so the next sandbox
 *     starts with a hot cache).
 *
 * Pure module — emits docker mount flag strings. The runner splices
 * them into the run argv.
 */
import * as os from 'node:os';
import * as path from 'node:path';
/**
 * Per-tool cache locations. Keyed on the tool slug. Each entry maps
 * `host` (relative to home) → `sandbox` (canonical path inside the
 * Anvil sandbox image).
 */
export const CACHE_DEFINITIONS = {
    npm: { host: '.npm', sandbox: '/home/anvil/.npm' },
    yarn: { host: '.yarn/cache', sandbox: '/home/anvil/.yarn/cache' },
    pnpm: { host: '.local/share/pnpm/store', sandbox: '/home/anvil/.local/share/pnpm/store' },
    pip: { host: '.cache/pip', sandbox: '/home/anvil/.cache/pip' },
    cargo: { host: '.cargo/registry', sandbox: '/home/anvil/.cargo/registry' },
    go: { host: 'go/pkg/mod', sandbox: '/home/anvil/go/pkg/mod' },
};
/**
 * Build the list of mounts to attach to a sandbox. The returned
 * `host` path is absolute — the runner can either bind-mount as-is
 * (host has the cache) or skip when the directory doesn't exist
 * (avoiding a noisy mount of a nonexistent path).
 */
export function buildCacheMounts(opts = {}) {
    const home = opts.homeDir ?? os.homedir();
    const defaultMode = opts.defaultMode ?? 'read-only';
    const out = [];
    for (const [tool, def] of Object.entries(CACHE_DEFINITIONS)) {
        const mode = opts.perTool?.[tool] ?? defaultMode;
        if (mode === 'off')
            continue;
        out.push({
            host: path.join(home, def.host),
            sandbox: def.sandbox,
            mode,
        });
    }
    return out;
}
/**
 * Translate a list of cache mounts into `docker run --mount` argv
 * tokens. Each mount becomes `--mount type=bind,src=...,dst=...,readonly`
 * (or no `,readonly` for read-write).
 */
export function dockerCacheMountArgs(mounts) {
    const args = [];
    for (const m of mounts) {
        const ro = m.mode === 'read-only' ? ',readonly' : '';
        args.push('--mount', `type=bind,src=${m.host},dst=${m.sandbox}${ro}`);
    }
    return args;
}
//# sourceMappingURL=cache-mounts.js.map