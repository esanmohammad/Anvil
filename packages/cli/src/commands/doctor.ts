import { Command } from 'commander';
import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
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

function checkProviderKeys(): CheckResult {
  const children: CheckResult[] = [];

  const openaiKey = !!process.env.OPENAI_API_KEY;
  children.push({ name: 'OpenAI', ok: openaiKey, optional: true, message: openaiKey ? 'OPENAI_API_KEY set' : 'OPENAI_API_KEY not set' });

  const geminiKey = !!(process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY);
  children.push({ name: 'Gemini', ok: geminiKey, optional: true, message: geminiKey ? 'API key set' : 'GOOGLE_API_KEY / GEMINI_API_KEY not set' });

  const openrouterKey = !!process.env.OPENROUTER_API_KEY;
  children.push({ name: 'OpenRouter', ok: openrouterKey, optional: true, message: openrouterKey ? 'OPENROUTER_API_KEY set' : 'OPENROUTER_API_KEY not set' });

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

function getWorkspacePath(configPath: string): string | null {
  try {
    const raw = readFileSync(configPath, 'utf-8');
    const match = raw.match(/^workspace:\s+(.+)$/m);
    if (match) {
      const ws = match[1].replace(/^["']|["']$/g, '').trim().replace(/^~/, homedir());
      return ws.startsWith('/') ? ws : join(homedir(), ws);
    }
  } catch { /* ignore */ }
  return null;
}

function getRepoNames(configPath: string): string[] {
  try {
    const raw = readFileSync(configPath, 'utf-8');
    const names: string[] = [];
    const matches = raw.matchAll(/^\s{2,4}-\s+name:\s+(.+)$/gm);
    for (const m of matches) {
      names.push(m[1].trim());
    }
    return names;
  } catch { return []; }
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
    const wsPath = getWorkspacePath(proj.configPath);
    const repoNames = getRepoNames(proj.configPath);

    if (!wsPath) {
      // No workspace configured — just check repo count
      children.push({
        name: proj.name,
        ok: true,
        message: `${repoNames.length} repo(s) configured (no workspace path)`,
      });
      continue;
    }

    if (!existsSync(wsPath)) {
      children.push({ name: proj.name, ok: false, message: 'workspace not found' });
      continue;
    }

    // Count cloned repos
    let cloned = 0;
    for (const repoName of repoNames) {
      const repoPath = join(wsPath, repoName);
      if (existsSync(repoPath)) cloned++;
    }

    const total = repoNames.length;
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
  ];

  const output = formatDoctorResults(results);
  process.stderr.write(output);

  return results.every((r) => r.ok || r.optional);
}

export const doctorCommand = new Command('doctor')
  .description('Check project health and dependencies')
  .action(async () => {
    const allOk = await runDoctor();
    if (!allOk) {
      process.exitCode = 1;
    }
  });
