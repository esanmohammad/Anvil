/**
 * Named browser contexts (Browserbase-style). Persistent cookie jars
 * stored at `~/.anvil/browser/contexts/<projectSlug>/<contextName>/`.
 * The user creates a context via the `anvil browser login <name> <url>`
 * CLI, which launches a headed Chromium, lets the user authenticate,
 * and saves the storage state to that path.
 *
 * The dashboard / CLI can attach a context to an existing session;
 * subsequent `browser_navigate` calls reuse the saved cookies.
 *
 * Defenses:
 *   - Per-project allow-list — pipeline-policy overlay's
 *     `tools.browseHeadless.contexts: ["docs-portal"]` is the gate.
 *   - Context expiry timestamp; `anvil browser refresh <name>` forces a
 *     re-login when stale.
 */
export interface ContextMetadata {
    name: string;
    projectSlug: string;
    url: string;
    createdAt: string;
    refreshedAt: string;
    /** Optional cookies expiry hint — informational only; runtime trusts
     *  Playwright's storageState. */
    expiresAt?: string;
}
export interface ContextStoreOpts {
    /** Override the root for tests. Default `~/.anvil/browser/contexts`. */
    root?: string;
}
export declare class ContextStore {
    private readonly root;
    constructor(opts?: ContextStoreOpts);
    private dirFor;
    list(projectSlug: string): ContextMetadata[];
    read(projectSlug: string, name: string): ContextMetadata | undefined;
    storageStatePath(projectSlug: string, name: string): string;
    save(meta: ContextMetadata, storageState: unknown): void;
    delete(projectSlug: string, name: string): void;
    /**
     * Validate that `name` is on the project's allow-list (per pipeline-policy
     * overlay's `tools.browseHeadless.contexts`). Throws on rejection.
     */
    assertAllowed(name: string, allowedContexts: readonly string[] | undefined): void;
}
//# sourceMappingURL=contexts.d.ts.map