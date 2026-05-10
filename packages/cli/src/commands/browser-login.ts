/**
 * `anvil browser login <name> <url>` — launch a headed Chromium so the
 * user can log into the given URL, then save the resulting storage
 * state as a named context. Subsequent runs can attach the context via
 * `browser_attach_context` (gated by per-project allow-list).
 *
 * Playwright is an optional dependency. When missing, the command
 * surfaces a helpful install prompt instead of failing silently.
 */

import { Command } from 'commander';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { writeFileSync } from 'node:fs';

interface BrowserLoginOptions {
  project?: string;
  /** Override the contexts root (test seam). */
  root?: string;
}

export const browserCommand = new Command('browser')
  .description('Browser context management for Tier 2 web tools.');

browserCommand
  .command('login <name> <url>')
  .description('Launch a headed Chromium so you can authenticate; saves the storage state as a named context.')
  .option('-p, --project <slug>', 'project slug for the context (default: "default")', 'default')
  .option('--root <path>', 'override contexts root (default: ~/.anvil/browser/contexts)')
  .action(async (name: string, url: string, opts: BrowserLoginOptions) => {
    const project = opts.project ?? 'default';
    const root = opts.root ?? join(homedir(), '.anvil', 'browser', 'contexts');
    const dir = join(root, project, name);
    mkdirSync(dir, { recursive: true });

    let playwright: { chromium: { launchPersistentContext: (...a: unknown[]) => Promise<unknown> } } | undefined;
    try {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const dynImport = new Function('m', 'return import(m)') as (m: string) => Promise<typeof playwright>;
      playwright = await dynImport('playwright');
    } catch {
      console.error('playwright is not installed. Install with: npm install -w @anvil-dev/dashboard playwright && npx playwright install chromium');
      process.exitCode = 2;
      return;
    }

    if (!playwright) return;

    console.log(`Launching headed Chromium → ${url}`);
    console.log('Authenticate in the browser window, then close it to save the context.');

    const context = await playwright.chromium.launchPersistentContext(dir, {
      headless: false,
      viewport: { width: 1280, height: 800 },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const page = await (context as any).newPage();
    await page.goto(url);

    await new Promise<void>((resolve) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (context as any).on('close', resolve);
    });

    // Persist metadata. The storage state lives in the persistent dir
    // managed by Playwright; metadata.json is the human-readable index.
    const meta = {
      name,
      projectSlug: project,
      url,
      createdAt: new Date().toISOString(),
      refreshedAt: new Date().toISOString(),
    };
    writeFileSync(join(dir, 'metadata.json'), JSON.stringify(meta, null, 2));
    console.log(`Saved context "${name}" for project "${project}" at ${dir}`);
  });

browserCommand
  .command('list')
  .description('List saved browser contexts.')
  .option('-p, --project <slug>', 'project slug', 'default')
  .option('--root <path>', 'override contexts root')
  .action(async (opts: BrowserLoginOptions) => {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const dynImport = new Function('m', 'return import(m)') as (m: string) => Promise<{ ContextStore: new (o: { root?: string }) => { list: (p: string) => unknown[] } }>;
    const mod = await dynImport(join(import.meta.url, '..', '..', '..', '..', 'dashboard', 'server', 'browser', 'contexts.js'));
    void mod;
    // Read directory listing without depending on the dashboard module:
    const project = opts.project ?? 'default';
    const root = opts.root ?? join(homedir(), '.anvil', 'browser', 'contexts');
    const dir = join(root, project);
    try {
      const { readdirSync } = await import('node:fs');
      const names = readdirSync(dir);
      if (names.length === 0) {
        console.log(`(no contexts for project "${project}")`);
        return;
      }
      for (const name of names) console.log(name);
    } catch {
      console.log(`(no contexts for project "${project}")`);
    }
  });
