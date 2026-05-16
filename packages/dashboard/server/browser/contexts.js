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
import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
export class ContextStore {
    root;
    constructor(opts = {}) {
        this.root = opts.root ?? join(homedir(), '.anvil', 'browser', 'contexts');
    }
    dirFor(projectSlug, name) {
        return join(this.root, projectSlug, name);
    }
    list(projectSlug) {
        const dir = join(this.root, projectSlug);
        if (!existsSync(dir))
            return [];
        const out = [];
        for (const name of readdirSync(dir)) {
            const meta = this.read(projectSlug, name);
            if (meta)
                out.push(meta);
        }
        return out;
    }
    read(projectSlug, name) {
        const path = join(this.dirFor(projectSlug, name), 'metadata.json');
        if (!existsSync(path))
            return undefined;
        try {
            return JSON.parse(readFileSync(path, 'utf8'));
        }
        catch {
            return undefined;
        }
    }
    storageStatePath(projectSlug, name) {
        return join(this.dirFor(projectSlug, name), 'storage-state.json');
    }
    save(meta, storageState) {
        const dir = this.dirFor(meta.projectSlug, meta.name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'metadata.json'), JSON.stringify(meta, null, 2));
        writeFileSync(join(dir, 'storage-state.json'), JSON.stringify(storageState, null, 2));
    }
    delete(projectSlug, name) {
        const dir = this.dirFor(projectSlug, name);
        if (existsSync(dir))
            rmSync(dir, { recursive: true, force: true });
    }
    /**
     * Validate that `name` is on the project's allow-list (per pipeline-policy
     * overlay's `tools.browseHeadless.contexts`). Throws on rejection.
     */
    assertAllowed(name, allowedContexts) {
        if (!allowedContexts || allowedContexts.length === 0) {
            throw new Error(`browser context "${name}" not in project allow-list. Add it to ` +
                `pipeline-policy.overlay.json: tools.browseHeadless.contexts.`);
        }
        if (!allowedContexts.includes(name)) {
            throw new Error(`browser context "${name}" not allowed for this project.`);
        }
    }
}
//# sourceMappingURL=contexts.js.map