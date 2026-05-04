/**
 * `anvil doctor --bootstrap-models` implementation.
 *
 *   1. If ~/.anvil/models.yaml is missing → copy bundled default template.
 *   2. Parse models.yaml; for every provider=ollama entry, check if the
 *      model is installed locally.
 *   3. Pull missing models sequentially via `ollama pull <id>`. Sequential
 *      on purpose — parallel pulls fight for disk + bandwidth and the
 *      first run hangs.
 *   4. Surface a clear summary; exit non-zero only on hard failure
 *      (e.g. ollama binary missing).
 *
 * Designed for testability: every side-effecting primitive (fs, fetch,
 * spawn, log) is injected via deps.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { execSync, spawn } from 'node:child_process';
import { parseModelRegistry } from '@anvil/agent-core';
import type { ModelEntry } from '@anvil/agent-core';
import { parse as parseYaml } from 'yaml';

export interface BootstrapDeps {
  /** Reads a file synchronously. Defaults to fs.readFileSync. */
  readFile?: (path: string) => string;
  /** Returns true if the path exists. Defaults to fs.existsSync. */
  exists?: (path: string) => boolean;
  /** Creates a directory recursively. Defaults to fs.mkdirSync. */
  mkdirRecursive?: (path: string) => void;
  /** Copies the template to the destination. Defaults to fs.copyFileSync. */
  copyFile?: (src: string, dest: string) => void;
  /** Lists the locally-installed Ollama model identifiers (e.g. 'qwen3:0.6b'). */
  listInstalledOllama?: () => string[];
  /** Pulls a single ollama model. Resolves on success, rejects on failure. */
  pullOllamaModel?: (modelId: string) => Promise<void>;
  /** Logger. */
  log?: (message: string) => void;
  /** Override for ANVIL_HOME / HOME resolution. */
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

export interface BootstrapResult {
  /** Path to the loaded (or created) models.yaml. */
  modelsYamlPath: string;
  /** True if the file was just created from template. */
  createdFromTemplate: boolean;
  /** Ollama models pulled this run. */
  pulled: string[];
  /** Ollama models already present (no pull needed). */
  alreadyPresent: string[];
  /** Ollama models that failed to pull (errors collected). */
  failed: { id: string; error: string }[];
}

export class BootstrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BootstrapError';
  }
}

export async function bootstrapModels(deps: BootstrapDeps = {}): Promise<BootstrapResult> {
  const env = deps.env ?? process.env;
  const home = deps.homeDir ?? homedir();
  const anvilHome = env.ANVIL_HOME ?? join(home, '.anvil');
  const modelsYamlPath = join(anvilHome, 'models.yaml');

  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  const exists = deps.exists ?? existsSync;
  const mkdir = deps.mkdirRecursive ?? ((p: string) => { mkdirSync(p, { recursive: true }); });
  const copyFile = deps.copyFile ?? copyFileSync;
  const log = deps.log ?? ((m: string) => { process.stderr.write(m + '\n'); });
  const listInstalledOllama = deps.listInstalledOllama ?? defaultListInstalledOllama;
  const pullOllamaModel = deps.pullOllamaModel ?? defaultPullOllamaModel;

  // 1. Ensure ~/.anvil exists + copy template if needed.
  let createdFromTemplate = false;
  if (!exists(modelsYamlPath)) {
    if (!exists(anvilHome)) {
      mkdir(anvilHome);
    }
    const templatePath = resolveTemplatePath(exists);
    if (templatePath === null) {
      throw new BootstrapError(
        `bundled models-default.yaml template not found in dist/templates/ ` +
        `or src/templates/. Reinstall @esankhan3/anvil-cli or rebuild from source.`,
      );
    }
    copyFile(templatePath, modelsYamlPath);
    createdFromTemplate = true;
    log(`Wrote ${modelsYamlPath} from bundled default template.`);
  }

  // 2. Parse and validate.
  let registry: { models: ModelEntry[] };
  try {
    registry = parseModelRegistry(parseYaml(readFile(modelsYamlPath)), modelsYamlPath);
  } catch (err) {
    throw new BootstrapError(
      `Failed to parse ${modelsYamlPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const ollamaModels = registry.models.filter((m) => m.provider === 'ollama');
  if (ollamaModels.length === 0) {
    log('No ollama models in registry — nothing to pull.');
    return { modelsYamlPath, createdFromTemplate, pulled: [], alreadyPresent: [], failed: [] };
  }

  // 3. Diff against locally-installed ollama models.
  let installed: string[];
  try {
    installed = listInstalledOllama();
  } catch (err) {
    throw new BootstrapError(
      `Could not list installed Ollama models: ${err instanceof Error ? err.message : String(err)}. ` +
      `Install ollama (e.g. \`brew install ollama\`) and retry.`,
    );
  }

  const alreadyPresent: string[] = [];
  const toPull: string[] = [];
  for (const m of ollamaModels) {
    if (isOllamaInstalled(m.id, installed)) alreadyPresent.push(m.id);
    else toPull.push(m.id);
  }

  if (toPull.length === 0) {
    log(`All ${ollamaModels.length} ollama model(s) already present.`);
    return { modelsYamlPath, createdFromTemplate, pulled: [], alreadyPresent, failed: [] };
  }

  log(`Pulling ${toPull.length} missing ollama model(s) sequentially: ${toPull.join(', ')}`);

  // 4. Sequential pulls (intentional — parallel hammers disk + Ollama).
  const pulled: string[] = [];
  const failed: { id: string; error: string }[] = [];
  for (const id of toPull) {
    log(`  → ollama pull ${id}`);
    try {
      await pullOllamaModel(id);
      pulled.push(id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failed.push({ id, error: msg });
      log(`    failed: ${msg}`);
    }
  }

  log(
    `Done — ${pulled.length} pulled, ${alreadyPresent.length} already present` +
      (failed.length ? `, ${failed.length} failed` : '') + '.',
  );
  return { modelsYamlPath, createdFromTemplate, pulled, alreadyPresent, failed };
}

// — Helpers —

/**
 * Returns the absolute path of the bundled `models-default.yaml` using
 * the injected `exists` dep so tests can stage a fake filesystem. Tries
 * the dist layout first (production), falls back to the src layout
 * (local dev). Returns null when neither is present.
 */
function resolveTemplatePath(exists: (p: string) => boolean): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist layout: cli/dist/commands/bootstrap-models.js → cli/dist/templates/
  const bundled = resolve(here, '..', 'templates', 'models-default.yaml');
  if (exists(bundled)) return bundled;
  // src layout: cli/src/commands/bootstrap-models.ts → cli/src/templates/
  const sourceFallback = resolve(here, '..', '..', 'src', 'templates', 'models-default.yaml');
  if (exists(sourceFallback)) return sourceFallback;
  return null;
}

function isOllamaInstalled(modelId: string, installed: string[]): boolean {
  // Ollama identifiers can include a tag (e.g. 'qwen3:0.6b') or default
  // to ':latest'. `ollama list` reports them WITH the tag, so we match
  // exactly. Edge case: registry entry without a tag should match the
  // installed `<name>:latest`.
  const normalized = modelId.includes(':') ? modelId : `${modelId}:latest`;
  return installed.includes(modelId) || installed.includes(normalized);
}

function defaultListInstalledOllama(): string[] {
  return runChild('ollama', ['list'])
    .split('\n')
    .slice(1) // drop the header row
    .map((line) => line.split(/\s+/)[0])
    .filter((name) => name && !name.startsWith('NAME'));
}

function defaultPullOllamaModel(modelId: string): Promise<void> {
  return new Promise((resolveOk, reject) => {
    const child = spawn('ollama', ['pull', modelId], { stdio: 'inherit' });
    child.on('exit', (code) => {
      if (code === 0) resolveOk();
      else reject(new Error(`ollama pull ${modelId} exited with code ${code}`));
    });
    child.on('error', (err) => reject(err));
  });
}

function runChild(cmd: string, args: string[]): string {
  // Synchronous wrapper for `ollama list` — used at boot only.
  // We purposefully shell out instead of querying the API so the function
  // works whether or not `ollama serve` is running.
  return execSync(`${cmd} ${args.map(shellQuote).join(' ')}`, {
    encoding: 'utf8',
    timeout: 10_000,
  });
}

function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_:.\/@\-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
