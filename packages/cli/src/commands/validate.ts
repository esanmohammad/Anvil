import { Command } from 'commander';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getFFHome } from '../home.js';
import pc from 'picocolors';

// ── Types ─────────────────────────────────────────────────────────────────

interface ValidationMessage {
  level: 'error' | 'warning';
  message: string;
}

interface ValidationResult {
  project: string;
  errors: ValidationMessage[];
  warnings: ValidationMessage[];
  ok: boolean;
}

interface ParsedRepo {
  name?: string;
  path?: string;
  language?: string;
  github?: string;
  hasBuild: boolean;
  hasTest: boolean;
}

interface ParsedConfig {
  project?: string;
  workspace?: string;
  repos: ParsedRepo[];
  stages: string[];
  rawText: string;
}

// ── Valid pipeline stages ─────────────────────────────────────────────────

const VALID_STAGES = new Set([
  'clarify',
  'requirements',
  'plan',
  'build',
  'test',
  'review',
  'ship',
  'verify',
  'research',
  'design',
  'implement',
  'integrate',
  'deploy',
  'monitor',
]);

const GITHUB_REPO_PATTERN = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;

// ── Config discovery ──────────────────────────────────────────────────────

function findProjectConfigs(): Array<{ name: string; configPath: string }> {
  const home = getFFHome();
  const entries: Array<{ name: string; configPath: string }> = [];

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

// ── Minimal config parser for validation ──────────────────────────────────

function parseConfigForValidation(configPath: string): ParsedConfig | null {
  try {
    const raw = readFileSync(configPath, 'utf-8');
    const lines = raw.split('\n');

    let project: string | undefined;
    let workspace: string | undefined;
    const repos: ParsedRepo[] = [];
    const stages: string[] = [];

    let currentRepo: ParsedRepo | null = null;
    let inRepos = false;
    let inCommands = false;

    const flushRepo = () => {
      if (currentRepo) repos.push(currentRepo);
      currentRepo = null;
      inCommands = false;
    };

    for (const line of lines) {
      const stripped = line.trimEnd();
      if (/^\s*#/.test(stripped) || /^\s*$/.test(stripped)) continue;
      const indent = stripped.length - stripped.trimStart().length;

      if (indent === 0) {
        flushRepo();
        inRepos = false;

        const scalar = stripped.match(/^(\w[\w_-]*):\s+(.+)$/);
        if (scalar) {
          const val = scalar[2].replace(/^["']|["']$/g, '').trim();
          if (scalar[1] === 'project' || scalar[1] === 'project') project = val;
          else if (scalar[1] === 'workspace') workspace = val.replace(/^~/, homedir());
        }

        if (/^repos:\s*$/.test(stripped)) inRepos = true;
        continue;
      }

      // Inline stages
      const stagesMatch = stripped.match(/^\s{2}stages:\s+\[(.+)\]/);
      if (stagesMatch) {
        stages.push(...stagesMatch[1].split(',').map((s) => s.trim()));
        continue;
      }

      if (inRepos) {
        const repoStart = stripped.match(/^\s{2,4}-\s+name:\s+(.+)/);
        if (repoStart) {
          flushRepo();
          currentRepo = {
            name: repoStart[1].trim(),
            hasBuild: false,
            hasTest: false,
          };
          inCommands = false;
          continue;
        }

        if (currentRepo) {
          if (/^\s{4,6}commands:\s*$/.test(stripped)) {
            inCommands = true;
            continue;
          }

          const kv = stripped.match(/^\s{4,8}(\w[\w_-]*):\s+(.+)$/);
          if (kv) {
            const val = kv[2].replace(/^["']|["']$/g, '').trim();
            if (inCommands) {
              if (kv[1] === 'build') currentRepo.hasBuild = true;
              if (kv[1] === 'test') currentRepo.hasTest = true;
            } else {
              if (kv[1] === 'path') currentRepo.path = val;
              else if (kv[1] === 'language') currentRepo.language = val;
              else if (kv[1] === 'github') currentRepo.github = val;
            }
          }
        }
      }
    }

    flushRepo();
    return { project, workspace, repos, stages, rawText: raw };
  } catch {
    return null;
  }
}

// ── Validation logic ──────────────────────────────────────────────────────

function validateProject(projectName: string, configPath: string): ValidationResult {
  const errors: ValidationMessage[] = [];
  const warnings: ValidationMessage[] = [];

  const config = parseConfigForValidation(configPath);
  if (!config) {
    return {
      project: projectName,
      errors: [{ level: 'error', message: `Failed to parse config at ${configPath}` }],
      warnings: [],
      ok: false,
    };
  }

  // Required: project field
  if (!config.project) {
    errors.push({ level: 'error', message: 'Missing required field: project' });
  }

  // Required: repos
  if (config.repos.length === 0) {
    errors.push({ level: 'error', message: 'Missing required field: repos (no repos defined)' });
  }

  // Workspace path exists
  if (config.workspace) {
    const wsPath = config.workspace.startsWith('/') ? config.workspace : join(homedir(), config.workspace);
    if (!existsSync(wsPath)) {
      warnings.push({ level: 'warning', message: `Workspace path does not exist: ${wsPath}` });
    }
  }

  // Check for duplicate repo names
  const repoNames = config.repos.map((r) => r.name).filter(Boolean) as string[];
  const seen = new Set<string>();
  for (const name of repoNames) {
    if (seen.has(name)) {
      errors.push({ level: 'error', message: `Duplicate repo name: ${name}` });
    }
    seen.add(name);
  }

  // Per-repo validation
  for (const repo of config.repos) {
    const prefix = repo.name ? `repo "${repo.name}"` : 'unnamed repo';

    // Required fields
    if (!repo.name) {
      errors.push({ level: 'error', message: `${prefix}: missing required field "name"` });
    }
    if (!repo.path) {
      warnings.push({ level: 'warning', message: `${prefix}: missing field "path"` });
    }
    if (!repo.language) {
      warnings.push({ level: 'warning', message: `${prefix}: missing field "language"` });
    }

    // Repo path exists on disk
    if (repo.path && config.workspace) {
      const wsPath = config.workspace.startsWith('/') ? config.workspace : join(homedir(), config.workspace);
      const repoPath = repo.path.startsWith('/') ? repo.path : join(wsPath, repo.path.replace(/^\.\//, ''));
      if (!existsSync(repoPath)) {
        warnings.push({ level: 'warning', message: `${prefix}: path does not exist on disk: ${repoPath}` });
      }
    }

    // Should have build or test
    if (!repo.hasBuild && !repo.hasTest) {
      warnings.push({ level: 'warning', message: `${prefix}: no "build" or "test" command defined` });
    }

    // GitHub field format
    if (repo.github && !GITHUB_REPO_PATTERN.test(repo.github)) {
      errors.push({ level: 'error', message: `${prefix}: invalid github format "${repo.github}" (expected org/repo)` });
    }
  }

  // Pipeline stages validation
  for (const stage of config.stages) {
    if (!VALID_STAGES.has(stage)) {
      warnings.push({ level: 'warning', message: `Unknown pipeline stage: "${stage}" (valid: ${[...VALID_STAGES].join(', ')})` });
    }
  }

  return {
    project: projectName,
    errors,
    warnings,
    ok: errors.length === 0,
  };
}

function printResult(result: ValidationResult): void {
  const icon = result.ok ? pc.green('\u2713') : pc.red('\u2717');
  console.log(`${icon} ${pc.bold(result.project)}`);

  for (const err of result.errors) {
    console.log(`  ${pc.red('error')}   ${err.message}`);
  }
  for (const warn of result.warnings) {
    console.log(`  ${pc.yellow('warn')}    ${warn.message}`);
  }

  if (result.errors.length === 0 && result.warnings.length === 0) {
    console.log(`  ${pc.dim('No issues found')}`);
  }
}

export const validateCommand = new Command('validate')
  .description('Validate project configuration files')
  .argument('[project]', 'Project name to validate (validates all if omitted)')
  .action(async (projectArg?: string) => {
    const configs = findProjectConfigs();

    if (configs.length === 0) {
      console.error(pc.red('No projects configured.'));
      process.exitCode = 1;
      return;
    }

    const toValidate = projectArg
      ? configs.filter((c) => c.name === projectArg)
      : configs;

    if (projectArg && toValidate.length === 0) {
      console.error(pc.red(`Project "${projectArg}" not found.`));
      console.error(`Available: ${configs.map((c) => c.name).join(', ')}`);
      process.exitCode = 1;
      return;
    }

    console.log('');
    console.log(pc.bold('Anvil Config Validation'));
    console.log('');

    let allOk = true;
    for (const { name, configPath } of toValidate) {
      const result = validateProject(name, configPath);
      printResult(result);
      if (!result.ok) allOk = false;
      console.log('');
    }

    const totalErrors = toValidate.length;
    const summary = allOk
      ? pc.green(`All ${totalErrors} project(s) valid`)
      : pc.red('Validation failed — fix errors above');
    console.log(summary);
    console.log('');

    if (!allOk) process.exitCode = 1;
  });
