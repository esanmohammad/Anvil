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
export type CacheMode = 'read-only' | 'read-write' | 'off';
export interface CacheMount {
    host: string;
    sandbox: string;
    mode: CacheMode;
}
export interface CacheMountOptions {
    /** Override the host home dir (test seam). */
    homeDir?: string;
    /** Override per-tool. Default = read-only for all. */
    perTool?: Partial<Record<keyof typeof CACHE_DEFINITIONS, CacheMode>>;
    /** Override the global default (when perTool[x] is unset). */
    defaultMode?: CacheMode;
}
/**
 * Per-tool cache locations. Keyed on the tool slug. Each entry maps
 * `host` (relative to home) → `sandbox` (canonical path inside the
 * Anvil sandbox image).
 */
export declare const CACHE_DEFINITIONS: {
    readonly npm: {
        readonly host: ".npm";
        readonly sandbox: "/home/anvil/.npm";
    };
    readonly yarn: {
        readonly host: ".yarn/cache";
        readonly sandbox: "/home/anvil/.yarn/cache";
    };
    readonly pnpm: {
        readonly host: ".local/share/pnpm/store";
        readonly sandbox: "/home/anvil/.local/share/pnpm/store";
    };
    readonly pip: {
        readonly host: ".cache/pip";
        readonly sandbox: "/home/anvil/.cache/pip";
    };
    readonly cargo: {
        readonly host: ".cargo/registry";
        readonly sandbox: "/home/anvil/.cargo/registry";
    };
    readonly go: {
        readonly host: "go/pkg/mod";
        readonly sandbox: "/home/anvil/go/pkg/mod";
    };
};
/**
 * Build the list of mounts to attach to a sandbox. The returned
 * `host` path is absolute — the runner can either bind-mount as-is
 * (host has the cache) or skip when the directory doesn't exist
 * (avoiding a noisy mount of a nonexistent path).
 */
export declare function buildCacheMounts(opts?: CacheMountOptions): CacheMount[];
/**
 * Translate a list of cache mounts into `docker run --mount` argv
 * tokens. Each mount becomes `--mount type=bind,src=...,dst=...,readonly`
 * (or no `,readonly` for read-write).
 */
export declare function dockerCacheMountArgs(mounts: readonly CacheMount[]): string[];
//# sourceMappingURL=cache-mounts.d.ts.map