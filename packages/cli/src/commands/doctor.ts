import { Command } from 'commander';
import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { getFFHome } from '../home.js';
import pc from 'picocolors';

export interface CheckResult {
  name: string;
  ok: boolean;
  optional?: boolean;
  message: string;
  children?: CheckResult[];
}

function tryExec(cmd: string): string | null {
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout: 10_000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

function extractVersion(output: string): string {
  const match = output.match(/(\d+\.\d+[\.\d]*)/);
  return match ? match[1] : output;
}

function checkNodeVersion(): CheckResult {
  const version = process.version;
  const major = parseInt(version.slice(1).split('.')[0], 10);
  const ok = major >= 18;
  return {
    name: 'Node.js',
    ok,
    message: ok ? `${version} (>= 18 required)` : `${version} — requires >= 18`,
  };
}

function checkGit(): CheckResult {
  const out = tryExec('git --version');
  if (!out) return { name: 'git', ok: false, message: 'not found' };
  return { name: 'git', ok: true, message: extractVersion(out) };
}

function checkGh(): CheckResult {
  const out = tryExec('gh --version');
  if (!out) return { name: 'gh', ok: false, message: 'not found (needed for PR creation)' };
  // Also check auth
  const auth = tryExec('gh auth status 2>&1');
  const isAuthed = auth && !auth.includes('not logged');
  return {
    name: 'gh',
    ok: true,
    message: extractVersion(out) + (isAuthed ? ' (authenticated)' : ' (NOT authenticated — run: gh auth login)'),
  };
}

function checkClaude(): CheckResult {
  const out = tryExec('claude --version 2>/dev/null');
  if (!out) return { name: 'claude', ok: false, message: 'not found (needed for agent execution)' };
  return { name: 'claude', ok: true, message: extractVersion(out) };
}

function checkGeminiCli(): CheckResult {
  const out = tryExec('gemini --version 2>/dev/null');
  if (!out) {
    return { name: 'gemini', ok: false, optional: true, message: 'optional — install: npm i -g @google/gemini-cli' };
  }
  return { name: 'gemini', ok: true, optional: true, message: extractVersion(out) };
}

type AuthStore = Record<string, { key?: string }>;

function loadAuthStore(): AuthStore {
  const authPath = join(homedir(), '.anvil', 'auth.json');
  if (!existsSync(authPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(authPath, 'utf-8'));
    return parsed && typeof parsed === 'object' ? (parsed as AuthStore) : {};
  } catch {
    return {};
  }
}

function readAnvilEnvFile(): Record<string, string> {
  const envPath = join(homedir(), '.anvil', '.env');
  if (!existsSync(envPath)) return {};
  try {
    const content = readFileSync(envPath, 'utf-8');
    const out: Record<string, string> = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx < 1) continue;
      out[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
    }
    return out;
  } catch {
    return {};
  }
}

function isProviderConfigured(envVars: string[], authStore: AuthStore, dotenv: Record<string, string>, authKeys: string[]): boolean {
  if (envVars.some((v) => !!process.env[v])) return true;
  if (envVars.some((v) => !!dotenv[v])) return true;
  if (authKeys.some((k) => !!authStore[k]?.key)) return true;
  return false;
}

function checkProviderKeys(): CheckResult {
  const children: CheckResult[] = [];
  const auth = loadAuthStore();
  const dotenv = readAnvilEnvFile();

  const openai = isProviderConfigured(['OPENAI_API_KEY'], auth, dotenv, ['openai']);
  children.push({ name: 'OpenAI', ok: openai, optional: true, message: openai ? 'API key set' : 'OPENAI_API_KEY not set' });

  const gemini = isProviderConfigured(['GOOGLE_API_KEY', 'GEMINI_API_KEY'], auth, dotenv, ['gemini']);
  children.push({ name: 'Gemini', ok: gemini, optional: true, message: gemini ? 'API key set' : 'GOOGLE_API_KEY / GEMINI_API_KEY not set' });

  const openrouter = isProviderConfigured(['OPENROUTER_API_KEY'], auth, dotenv, ['openrouter']);
  children.push({ name: 'OpenRouter', ok: openrouter, optional: true, message: openrouter ? 'API key set' : 'OPENROUTER_API_KEY not set' });

  const ollamaAvail = tryExec('curl -s http://localhost:11434/api/tags 2>/dev/null');
  children.push({ name: 'Ollama', ok: !!ollamaAvail, optional: true, message: ollamaAvail ? 'running on localhost:11434' : 'not running' });

  const available = children.filter((c) => c.ok).length;
  return {
    name: 'LLM Providers',
    ok: true,
    optional: true,
    message: `${available}/${children.length} configured`,
    children,
  };
}

function checkAnvilHome(): CheckResult {
  const home = getFFHome();
  const ok = existsSync(home);
  return {
    name: 'Anvil home',
    ok,
    message: ok ? home.replace(homedir(), '~') : `${home.replace(homedir(), '~')} does not exist (run: anvil init)`,
  };
}

interface ProjectEntry {
  name: string;
  configPath: string;
}

function findProjects(): ProjectEntry[] {
  const home = getFFHome();
  const entries: ProjectEntry[] = [];

  // projects/<name>/factory.yaml
  const projectsDir = join(home, 'projects');
  if (existsSync(projectsDir)) {
    try {
      for (const name of readdirSync(projectsDir)) {
        if (name.startsWith('.')) continue;
        const yamlPath = join(projectsDir, name, 'factory.yaml');
        if (existsSync(yamlPath)) {
          entries.push({ name, configPath: yamlPath });
        }
      }
    } catch { /* ignore */ }
  }

  // legacy: projects/<name>/project.yaml
  const legacyDir = join(home, 'projects');
  if (existsSync(legacyDir)) {
    try {
      for (const name of readdirSync(legacyDir)) {
        if (name.startsWith('.')) continue;
        if (entries.some((e) => e.name === name)) continue;
        const yamlPath = join(legacyDir, name, 'project.yaml');
        if (existsSync(yamlPath)) {
          entries.push({ name, configPath: yamlPath });
        }
      }
    } catch { /* ignore */ }
  }

  return entries;
}

interface ProjectYamlShape {
  workspace?: string;
  repos?: Array<{ name?: string; path?: string }>;
}

function loadProjectYaml(configPath: string): ProjectYamlShape | null {
  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = parseYaml(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as ProjectYamlShape;
    }
  } catch { /* ignore */ }
  return null;
}

function getWorkspacePath(yamlContent: ProjectYamlShape | null): string | null {
  const ws = yamlContent?.workspace;
  if (typeof ws !== 'string' || ws.length === 0) return null;
  const expanded = ws.replace(/^~/, homedir());
  return isAbsolute(expanded) ? expanded : join(homedir(), expanded);
}

interface RepoEntry {
  name: string;
  /** Path as declared in factory.yaml, relative or absolute. */
  declaredPath: string;
}

function getRepoEntries(yamlContent: ProjectYamlShape | null): RepoEntry[] {
  const repos = yamlContent?.repos;
  if (!Array.isArray(repos)) return [];
  const out: RepoEntry[] = [];
  for (const r of repos) {
    if (!r || typeof r !== 'object' || typeof r.name !== 'string' || r.name.length === 0) continue;
    // path is optional — fall back to using `name` as the directory.
    const declaredPath = typeof r.path === 'string' && r.path.length > 0 ? r.path : r.name;
    out.push({ name: r.name, declaredPath });
  }
  return out;
}

function resolveRepoPath(wsPath: string, declaredPath: string): string {
  if (isAbsolute(declaredPath)) return declaredPath;
  // `./foo`, `foo`, `../foo` all resolve relative to the workspace root.
  return resolve(wsPath, declaredPath);
}

function checkProjects(): CheckResult {
  const projects = findProjects();
  if (projects.length === 0) {
    return {
      name: 'Projects',
      ok: false,
      message: 'none configured (add factory.yaml to projects/ or projects/)',
    };
  }

  const names = projects.map((p) => p.name);
  const children: CheckResult[] = [];

  for (const proj of projects) {
    const yaml = loadProjectYaml(proj.configPath);
    const wsPath = getWorkspacePath(yaml);
    const repos = getRepoEntries(yaml);

    if (!wsPath) {
      // No workspace configured — just count repo entries
      children.push({
        name: proj.name,
        ok: true,
        message: `${repos.length} repo(s) configured (no workspace path)`,
      });
      continue;
    }

    if (!existsSync(wsPath)) {
      children.push({ name: proj.name, ok: false, message: 'workspace not found' });
      continue;
    }

    // Count cloned repos using each repo's declared `path` (falls back to
    // `name` when the yaml omits a path). Resolves relative paths against
    // the workspace root, so `./foo` and absolute paths both work.
    let cloned = 0;
    for (const repo of repos) {
      const repoPath = resolveRepoPath(wsPath, repo.declaredPath);
      if (existsSync(repoPath)) cloned++;
    }

    const total = repos.length;
    const allCloned = cloned === total;
    children.push({
      name: proj.name,
      ok: allCloned,
      message: `${cloned}/${total} repos cloned`,
    });
  }

  return {
    name: 'Projects',
    ok: children.every((c) => c.ok),
    message: `${projects.length} configured (${names.join(', ')})`,
    children,
  };
}

/**
 * Probe the `anvil/sandbox` image. Surfaced as an OPTIONAL check —
 * Docker isn't required for read-only stages, but the user is more
 * likely to discover `--pull-sandbox` from this row than from `-h`.
 */
function checkSandboxImage(): CheckResult {
  const dockerBin = process.env.DOCKER_BIN ?? 'docker';
  const tag = process.env.ANVIL_SANDBOX_TAG ?? 'anvil/sandbox:latest';
  const dockerOut = tryExec(`${dockerBin} version --format '{{.Server.Version}}' 2>/dev/null`);
  if (!dockerOut) {
    return {
      name: 'docker',
      ok: false,
      optional: true,
      message: 'not installed (sandboxed stages will fall back to host; set ANVIL_SANDBOX_FORCE_NONE=1 to silence)',
    };
  }
  const inspect = tryExec(`${dockerBin} image inspect ${tag} 2>/dev/null`);
  if (inspect) {
    return { name: 'sandbox image', ok: true, message: `${tag} present` };
  }
  return {
    name: 'sandbox image',
    ok: false,
    optional: true,
    message: `${tag} not pulled — run "anvil doctor --pull-sandbox"`,
  };
}

function formatIcon(result: CheckResult): string {
  if (result.optional && !result.ok) return pc.yellow('\u25CB');
  return result.ok ? pc.green('\u2713') : pc.red('\u2717');
}

export function formatDoctorResults(results: CheckResult[]): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(pc.bold('Anvil Doctor'));
  lines.push('');

  for (const r of results) {
    lines.push(`  ${formatIcon(r)} ${r.name} ${pc.dim(r.message)}`);
    if (r.children) {
      for (const child of r.children) {
        lines.push(`    ${formatIcon(child)} ${child.name}: ${pc.dim(child.message)}`);
      }
    }
  }

  lines.push('');

  const total = results.length;
  const passed = results.filter((r) => r.ok || r.optional).length;
  const failed = results.filter((r) => !r.ok && !r.optional).length;
  if (failed > 0) {
    lines.push(`  ${pc.green(`${passed} passed`)}  ${pc.red(`${failed} failed`)}`);
  } else {
    lines.push(`  ${pc.green('All checks passed')}`);
  }
  lines.push('');

  return lines.join('\n');
}

export async function runDoctor(): Promise<boolean> {
  const results: CheckResult[] = [
    checkNodeVersion(),
    checkGit(),
    checkGh(),
    checkClaude(),
    checkGeminiCli(),
    checkAnvilHome(),
    checkProjects(),
    checkProviderKeys(),
    checkSandboxImage(),
  ];

  const output = formatDoctorResults(results);
  process.stderr.write(output);

  return results.every((r) => r.ok || r.optional);
}

/**
 * `--pull-sandbox` — pre-warm the anvil/sandbox Docker image so the
 * first sandboxed stage starts fast. Calls `docker image inspect`;
 * if missing, `docker pull anvil/sandbox:latest`.
 */
async function pullSandboxImage(): Promise<boolean> {
  const dockerBin = process.env.DOCKER_BIN ?? 'docker';
  const tag = process.env.ANVIL_SANDBOX_TAG ?? 'anvil/sandbox:latest';
  try {
    execSync(`${dockerBin} image inspect ${tag}`, { stdio: ['ignore', 'pipe', 'pipe'] });
    process.stdout.write(`${tag} already present\n`);
    return true;
  } catch {
    /* fall through to pull */
  }
  try {
    execSync(`${dockerBin} pull ${tag}`, { stdio: 'inherit' });
    return true;
  } catch (err) {
    process.stderr.write(`pull failed: ${(err as Error).message}\n`);
    return false;
  }
}

export const doctorCommand = new Command('doctor')
  .description('Check project health and dependencies')
  .option('--bootstrap-models', 'Write ~/.anvil/models.yaml from the bundled default if missing, then pull any ollama models the registry references but does not have installed locally')
  .option('--pull-sandbox', 'Pre-pull the anvil/sandbox Docker image so the first sandboxed stage starts fast')
  .action(async (opts: { bootstrapModels?: boolean; pullSandbox?: boolean }) => {
    if (opts.bootstrapModels) {
      const { bootstrapModels, BootstrapError } = await import('./bootstrap-models.js');
      try {
        const result = await bootstrapModels();
        if (result.failed.length > 0) {
          process.exitCode = 1;
        }
        return;
      } catch (err) {
        process.stderr.write(
          (err instanceof BootstrapError ? err.message : String(err)) + '\n',
        );
        process.exitCode = 1;
        return;
      }
    }

    if (opts.pullSandbox) {
      const ok = await pullSandboxImage();
      if (!ok) process.exitCode = 1;
      return;
    }

    const allOk = await runDoctor();
    if (!allOk) {
      process.exitCode = 1;
    }
  });
