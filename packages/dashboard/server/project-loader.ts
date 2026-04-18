/**
 * project-loader — Generic project configuration for Anvil.
 *
 * Reads factory.yaml files from:
 *   1. ~/.anvil/projects/<name>/factory.yaml
 *   2. Current workspace with factory.yaml at root
 *
 * Config format: see factory.yaml schema below.
 *
 * Environment variables:
 *   ANVIL_WORKSPACE_ROOT  — default workspace root (default: ~/workspace)
 *   ANVIL_HOME            — Anvil home dir (default: ~/.anvil)
 */

import { readFileSync, existsSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ── Paths ────────────────────────────────────────────────────────────────

const ANVIL_HOME = process.env.ANVIL_HOME || process.env.FF_HOME || join(homedir(), '.anvil');
const PROJECTS_DIR = join(ANVIL_HOME, 'projects');

function getWorkspaceRoot(): string {
  return process.env.ANVIL_WORKSPACE_ROOT || process.env.FF_WORKSPACE_ROOT || join(homedir(), 'workspace');
}

// ── Config Types (factory.yaml schema) ───────────────────────────────────

export interface RepoConfig {
  name: string;
  path: string;                // relative to workspace, or absolute
  github?: string;             // org/repo — for cloning + PR creation
  language: string;
  description?: string;
  commands?: RepoCommands;
  connects?: TransportConfig[];
}

export interface RepoCommands {
  install?: string;
  build?: string;
  test?: string;
  lint?: string;
  format?: string;
  [key: string]: string | undefined;  // extensible
}

export interface TransportConfig {
  type: string;               // 'kafka' | 'http' | 'redis' | 'postgres' | 'mongo' | 'grpc' | etc.
  to?: string;                // target repo name (for directed connections)
  produces?: string[];         // topic/event names this repo produces
  consumes?: string[];         // topic/event names this repo consumes
  endpoint?: string;           // for HTTP/gRPC
  database?: string;           // for DB connections
  name?: string;               // connection name/label
}

export interface DomainConfig {
  description?: string;
  glossary?: Record<string, string>;
  invariants?: string[];
  critical_flows?: Array<{ name: string; steps: string[] | string }>;
  sharp_edges?: string[];
}

export interface PipelineConfig {
  stages?: string[];
  ship?: {
    branch_prefix?: string;
    pr_template?: string;
    deploy?: string;
    smoke_test?: string;
  };
  models?: {
    default?: string;
    build?: string;
    research?: string;
    clarify?: string;
    tasks?: string;
    specs?: string;
    validate?: string;
    [key: string]: string | undefined;
  };
  approval_gates?: Array<{ after: string }>;
  custom_stages?: Record<string, {
    persona?: string;
    prompt_file?: string;
    after?: string;
    per_repo?: boolean;
    timeout?: number;
  }>;
  providers?: {
    default?: string;
    [stage: string]: string | { provider: string; base_url?: string; api_key_env?: string } | undefined;
  };
  fallback?: string[];
}

export interface NotificationsConfig {
  slack?: {
    webhook_url?: string;
    events?: string[];
    channel?: string;
  };
}

export interface BudgetConfig {
  max_per_run: number;         // max USD per pipeline run (default: 100)
  max_per_day: number;         // max USD per day (default: 200)
  alert_at: number;            // dollar amount to trigger browser alert (default: 80)
}

export interface FactoryConfig {
  version: number;
  project: string;             // project identifier (slug)
  title?: string;
  workspace?: string;          // workspace path (absolute or relative to home)
  repos: RepoConfig[];
  domain?: DomainConfig;
  pipeline?: PipelineConfig;
  budget?: BudgetConfig;
  personas_dir?: string;
  notifications?: NotificationsConfig;
  knowledge?: {
    embedding?: {
      provider?: string;
      model?: string;
      dimensions?: number;
    };
    chunking?: {
      max_tokens?: number;
      context_enrichment?: string;
    };
    retrieval?: {
      max_chunks?: number;
      max_tokens?: number;
    };
    auto_index?: boolean;
  };
}

// ── Project interfaces ───────────────────────────────────────────────────

export interface ProjectInfo {
  name: string;
  title: string;
  owner: string;
  lifecycle: string;
  type: string;
  tier: string;
  repos: ProjectRepo[];
  invariants: Array<{ id: string; statement: string; criticality: string }>;
  criticalFlows: Array<{ id: string; name: string; trigger: string }>;
  sharpEdges: Array<{ id: string; statement: string; severity: string }>;
  glossary: Array<{ term: string; definition: string }>;
}

export interface ProjectRepo {
  name: string;
  github: string;
  language: string;
  repoKind: string;
  description: string;
  localPath: string | null;
  cloneStatus: 'cloned' | 'updated' | 'skipped' | 'failed' | 'unknown';
}

export interface WorkspaceStatus {
  exists: boolean;
  path: string;
  repos: Array<{ name: string; path: string; status: string }>;
  lastUpdated: string | null;
}

// ── Minimal YAML parser ──────────────────────────────────────────────────
// Handles factory.yaml structure: top-level scalars, arrays of objects,
// and nested objects up to 3 levels deep.

interface YamlDoc {
  [key: string]: string | YamlObj[] | YamlObj;
}

interface YamlObj {
  [key: string]: string | string[] | YamlObj | YamlObj[];
}

function parseFactoryYaml(text: string): FactoryConfig {
  const lines = text.split('\n');

  // State
  let project = '';
  let title = '';
  let version = 1;
  let workspace = '';
  let personasDir = '';
  const repos: RepoConfig[] = [];
  const domain: DomainConfig = {};
  const pipeline: PipelineConfig = {};
  const budget: Partial<BudgetConfig> = {};

  let section = ''; // 'repos' | 'domain' | 'pipeline' | 'budget'
  let currentRepo: Partial<RepoConfig> | null = null;
  let subSection = ''; // 'commands' | 'connects' | 'glossary' | 'invariants' | etc.
  let subSubSection = ''; // 'ship' | 'models' | 'produces' | 'consumes'
  let currentConnect: Partial<TransportConfig> | null = null;
  let currentFlow: { name: string; steps: string[] } | null = null;

  const flushRepo = () => {
    if (currentRepo && currentRepo.name) {
      repos.push(currentRepo as RepoConfig);
    }
    currentRepo = null;
    subSection = '';
    subSubSection = '';
    currentConnect = null;
  };

  const flushConnect = () => {
    if (currentConnect && currentConnect.type && currentRepo) {
      if (!currentRepo.connects) currentRepo.connects = [];
      currentRepo.connects.push(currentConnect as TransportConfig);
    }
    currentConnect = null;
    subSubSection = '';
  };

  const flushFlow = () => {
    if (currentFlow && currentFlow.name) {
      if (!domain.critical_flows) domain.critical_flows = [];
      domain.critical_flows.push(currentFlow);
    }
    currentFlow = null;
  };

  for (const line of lines) {
    const stripped = line.trimEnd();
    if (/^\s*#/.test(stripped) || /^\s*$/.test(stripped)) continue;
    const indent = stripped.length - stripped.trimStart().length;

    // Top-level keys (indent 0)
    if (indent === 0) {
      flushRepo();
      flushFlow();

      const scalarMatch = stripped.match(/^(\w[\w_-]*):\s+(.+)$/);
      if (scalarMatch) {
        const [, key, val] = scalarMatch;
        const v = val.replace(/^["']|["']$/g, '').trim();
        if (key === 'project') project = v;
        else if (key === 'title') title = v;
        else if (key === 'version') version = parseInt(v, 10) || 1;
        else if (key === 'workspace') workspace = v.replace(/^~/, homedir());
        else if (key === 'personas_dir') personasDir = v;
        section = '';
        continue;
      }

      const blockMatch = stripped.match(/^(\w[\w_-]*):\s*$/);
      if (blockMatch) {
        section = blockMatch[1];
        subSection = '';
        subSubSection = '';
        continue;
      }
    }

    // repos section
    if (section === 'repos') {
      // New repo: "  - name: value"
      const repoStart = stripped.match(/^\s{2}-\s+name:\s+(.+)/);
      if (repoStart && indent <= 4) {
        flushRepo();
        currentRepo = { name: repoStart[1].trim(), language: '', path: '' };
        subSection = '';
        continue;
      }

      if (currentRepo) {
        // Sub-blocks: commands, connects
        const subBlock = stripped.match(/^\s{4,6}(\w[\w_-]*):\s*$/);
        if (subBlock) {
          if (subBlock[1] === 'connects') { subSection = 'connects'; flushConnect(); }
          else if (subBlock[1] === 'commands') subSection = 'commands';
          else subSection = subBlock[1];
          subSubSection = '';
          continue;
        }

        // Simple key-value on repo
        const kvMatch = stripped.match(/^\s{4,6}(\w[\w_-]*):\s+(.+)$/);
        if (kvMatch && !subSection) {
          const [, key, val] = kvMatch;
          const v = val.replace(/^["']|["']$/g, '').trim();
          if (key === 'path') currentRepo.path = v;
          else if (key === 'github') currentRepo.github = v;
          else if (key === 'language') currentRepo.language = v;
          else if (key === 'description') currentRepo.description = v;
          continue;
        }

        // Commands sub-section
        if (subSection === 'commands' && kvMatch) {
          if (!currentRepo.commands) currentRepo.commands = {};
          currentRepo.commands[kvMatch[1]] = kvMatch[2].replace(/^["']|["']$/g, '').trim();
          continue;
        }

        // Connects sub-section
        if (subSection === 'connects') {
          // New connection: "      - type: kafka"
          const connectStart = stripped.match(/^\s{6,8}-\s+type:\s+(.+)/);
          if (connectStart) {
            flushConnect();
            currentConnect = { type: connectStart[1].trim() };
            subSubSection = '';
            continue;
          }

          if (currentConnect) {
            // Sub-arrays: produces, consumes
            const subArr = stripped.match(/^\s{8,10}(produces|consumes):\s*$/);
            if (subArr) { subSubSection = subArr[1]; continue; }

            // Inline array: produces: [a, b, c]
            const inlineArr = stripped.match(/^\s{8,10}(produces|consumes):\s+\[(.+)\]/);
            if (inlineArr) {
              const items = inlineArr[2].split(',').map((s) => s.trim().replace(/^["']|["']$/g, ''));
              if (inlineArr[1] === 'produces') currentConnect.produces = items;
              else currentConnect.consumes = items;
              continue;
            }

            // Array items
            const arrItem = stripped.match(/^\s{10,12}-\s+(.+)/);
            if (arrItem && (subSubSection === 'produces' || subSubSection === 'consumes')) {
              const val = arrItem[1].replace(/^["']|["']$/g, '').trim();
              if (!currentConnect[subSubSection]) (currentConnect as any)[subSubSection] = [];
              (currentConnect[subSubSection] as string[]).push(val);
              continue;
            }

            // Simple connect fields
            const connectKv = stripped.match(/^\s{8,10}(\w[\w_-]*):\s+(.+)$/);
            if (connectKv) {
              const [, key, val] = connectKv;
              const v = val.replace(/^["']|["']$/g, '').trim();
              if (key === 'to') currentConnect.to = v;
              else if (key === 'endpoint') currentConnect.endpoint = v;
              else if (key === 'database') currentConnect.database = v;
              else if (key === 'name') currentConnect.name = v;
              continue;
            }
          }
        }
      }
    }

    // domain section
    if (section === 'domain') {
      const domainBlock = stripped.match(/^\s{2}(\w[\w_-]*):\s*$/);
      if (domainBlock) {
        flushFlow();
        subSection = domainBlock[1];
        continue;
      }

      const domainScalar = stripped.match(/^\s{2}(\w[\w_-]*):\s+(.+)$/);
      if (domainScalar && !subSection) {
        if (domainScalar[1] === 'description') domain.description = domainScalar[2].replace(/^["']|["']$/g, '').trim();
        continue;
      }

      // description as multiline (indented continuation)
      if (stripped.match(/^\s{2}description:\s*\|?\s*$/)) {
        subSection = 'description';
        domain.description = '';
        continue;
      }
      if (subSection === 'description' && indent >= 4) {
        domain.description = (domain.description || '') + stripped.trim() + '\n';
        continue;
      }

      // glossary: key: value pairs
      if (subSection === 'glossary') {
        const glossKv = stripped.match(/^\s{4}(\w[\w_\s-]+):\s+(.+)$/);
        if (glossKv) {
          if (!domain.glossary) domain.glossary = {};
          domain.glossary[glossKv[1].trim()] = glossKv[2].replace(/^["']|["']$/g, '').trim();
          continue;
        }
      }

      // invariants: array of strings
      if (subSection === 'invariants') {
        const invItem = stripped.match(/^\s{4}-\s+["']?(.+?)["']?\s*$/);
        if (invItem) {
          if (!domain.invariants) domain.invariants = [];
          domain.invariants.push(invItem[1]);
          continue;
        }
      }

      // sharp_edges: array of strings
      if (subSection === 'sharp_edges') {
        const seItem = stripped.match(/^\s{4}-\s+["']?(.+?)["']?\s*$/);
        if (seItem) {
          if (!domain.sharp_edges) domain.sharp_edges = [];
          domain.sharp_edges.push(seItem[1]);
          continue;
        }
      }

      // critical_flows: array of objects
      if (subSection === 'critical_flows') {
        const flowStart = stripped.match(/^\s{4}-\s+name:\s+(.+)/);
        if (flowStart) {
          flushFlow();
          currentFlow = { name: flowStart[1].trim(), steps: [] };
          continue;
        }
        if (currentFlow) {
          const stepsInline = stripped.match(/^\s{6}steps:\s+\[(.+)\]/);
          if (stepsInline) {
            currentFlow.steps = stepsInline[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, ''));
            continue;
          }
          const stepsBlock = stripped.match(/^\s{6}steps:\s*$/);
          if (stepsBlock) { subSubSection = 'steps'; continue; }
          if (subSubSection === 'steps') {
            const stepItem = stripped.match(/^\s{8}-\s+(.+)/);
            if (stepItem) { currentFlow.steps.push(stepItem[1].trim()); continue; }
          }
        }
      }
    }

    // pipeline section
    if (section === 'pipeline') {
      const pipeBlock = stripped.match(/^\s{2}(\w[\w_-]*):\s*$/);
      if (pipeBlock) {
        subSection = pipeBlock[1];
        continue;
      }

      // stages: [clarify, requirements, ...]
      const stagesInline = stripped.match(/^\s{2}stages:\s+\[(.+)\]/);
      if (stagesInline) {
        pipeline.stages = stagesInline[1].split(',').map((s) => s.trim());
        continue;
      }

      // ship sub-section
      if (subSection === 'ship') {
        const shipKv = stripped.match(/^\s{4}(\w[\w_-]*):\s+(.+)$/);
        if (shipKv) {
          if (!pipeline.ship) pipeline.ship = {};
          (pipeline.ship as any)[shipKv[1]] = shipKv[2].replace(/^["']|["']$/g, '').trim();
          continue;
        }
      }

      // models sub-section
      if (subSection === 'models') {
        const modelKv = stripped.match(/^\s{4}(\w[\w_-]*):\s+(.+)$/);
        if (modelKv) {
          if (!pipeline.models) pipeline.models = {};
          pipeline.models[modelKv[1]] = modelKv[2].replace(/^["']|["']$/g, '').trim();
          continue;
        }
      }
    }

    // budget section
    if (section === 'budget') {
      const budgetKv = stripped.match(/^\s{2}(\w[\w_-]*):\s+(.+)$/);
      if (budgetKv) {
        const [, key, val] = budgetKv;
        const v = parseFloat(val);
        if (!isNaN(v)) {
          if (key === 'max_per_run') budget.max_per_run = v;
          else if (key === 'max_per_day') budget.max_per_day = v;
          else if (key === 'alert_at') budget.alert_at = v;
        }
        continue;
      }
    }
  }

  // Flush remaining
  flushConnect();
  flushRepo();
  flushFlow();

  return {
    version,
    project,
    title: title || project,
    workspace: workspace || undefined,
    repos,
    domain: Object.keys(domain).length > 0 ? domain : undefined,
    pipeline: Object.keys(pipeline).length > 0 ? pipeline : undefined,
    budget: Object.keys(budget).length > 0 ? budget as BudgetConfig : undefined,
    personas_dir: personasDir || undefined,
  };
}

// ── Auto-Discovery: create project from directory scan (no YAML needed) ──

/**
 * Scan a directory for git repos and create a minimal FactoryConfig.
 * No project.yaml or factory.yaml required — just point at a directory.
 *
 * Detects language from file extensions in each repo.
 */
export function discoverProjectFromDirectory(
  projectName: string,
  directoryPath: string,
): FactoryConfig | null {
  if (!existsSync(directoryPath)) return null;

  const repos: RepoConfig[] = [];

  // Check if directoryPath itself is a monorepo (has .git at root)
  const isMonorepo = existsSync(join(directoryPath, '.git'));
  if (isMonorepo) {
    // Single repo — the directory itself
    const lang = detectLanguage(directoryPath);
    repos.push({
      name: projectName,
      path: '.',
      language: lang,
    });
  } else {
    // Multi-repo — scan subdirectories for .git folders
    try {
      const entries = readdirSync(directoryPath);
      for (const entry of entries) {
        if (entry.startsWith('.')) continue;
        const fullPath = join(directoryPath, entry);
        if (!isDirectoryOrSymlink(fullPath)) continue;
        if (!existsSync(join(fullPath, '.git'))) continue;

        const lang = detectLanguage(fullPath);
        repos.push({
          name: entry,
          path: `./${entry}`,
          language: lang,
        });
      }
    } catch { /* ignore */ }
  }

  if (repos.length === 0) return null;

  return {
    version: 1,
    project: projectName,
    title: projectName,
    workspace: directoryPath,
    repos,
    // No domain, pipeline, connects — all discovered automatically by WS-1/WS-2
  };
}

/**
 * Detect the primary language of a repo by scanning file extensions.
 */
function detectLanguage(repoPath: string): string {
  const extCounts: Record<string, number> = {};
  const langMap: Record<string, string> = {
    '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript',
    '.go': 'go', '.py': 'python', '.rs': 'rust', '.java': 'java', '.php': 'php',
    '.rb': 'ruby', '.cs': 'csharp', '.swift': 'swift', '.kt': 'kotlin',
  };
  const skipDirs = new Set(['node_modules', 'dist', '.git', 'build', 'vendor', '__pycache__', '.venv', 'target']);

  function walk(dir: string, depth: number): void {
    if (depth > 3) return; // don't go too deep
    try {
      for (const entry of readdirSync(dir)) {
        if (skipDirs.has(entry) || entry.startsWith('.')) continue;
        const full = join(dir, entry);
        try {
          const stat = statSync(full);
          if (stat.isDirectory()) { walk(full, depth + 1); continue; }
          const ext = entry.slice(entry.lastIndexOf('.'));
          if (langMap[ext]) extCounts[langMap[ext]] = (extCounts[langMap[ext]] || 0) + 1;
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  walk(repoPath, 0);

  // Also check manifest files for definitive language detection
  if (existsSync(join(repoPath, 'go.mod'))) return 'go';
  if (existsSync(join(repoPath, 'Cargo.toml'))) return 'rust';
  if (existsSync(join(repoPath, 'pyproject.toml')) || existsSync(join(repoPath, 'setup.py'))) return 'python';
  if (existsSync(join(repoPath, 'pom.xml')) || existsSync(join(repoPath, 'build.gradle'))) return 'java';
  if (existsSync(join(repoPath, 'composer.json'))) return 'php';

  // Return the most common language
  const sorted = Object.entries(extCounts).sort((a, b) => b[1] - a[1]);
  return sorted[0]?.[0] || 'unknown';
}

/**
 * Create and persist a minimal project config from directory scan.
 * Writes to ~/.anvil/projects/<name>/factory.yaml so the project appears in listings.
 */
export function createProjectFromScan(
  projectName: string,
  directoryPath: string,
): FactoryConfig | null {
  const config = discoverProjectFromDirectory(projectName, directoryPath);
  if (!config) return null;

  // Write a minimal factory.yaml
  const projectDir = join(PROJECTS_DIR, projectName);
  mkdirSync(projectDir, { recursive: true });

  const yamlLines = [
    `version: 1`,
    `project: ${projectName}`,
    `title: ${projectName}`,
    `workspace: ${directoryPath}`,
    ``,
    `repos:`,
  ];

  for (const repo of config.repos) {
    yamlLines.push(`  - name: ${repo.name}`);
    yamlLines.push(`    path: ${repo.path}`);
    yamlLines.push(`    language: ${repo.language}`);
    if (repo.github) yamlLines.push(`    github: ${repo.github}`);
    yamlLines.push('');
  }

  yamlLines.push(`# Domain, connections, and architecture are discovered automatically.`);
  yamlLines.push(`# See repo profiles in ~/.anvil/knowledge-base/${projectName}/<repo>/profile.json`);

  writeFileSync(join(projectDir, 'factory.yaml'), yamlLines.join('\n'), 'utf-8');
  console.log(`[project-loader] Created project "${projectName}" from ${directoryPath} (${config.repos.length} repos)`);

  return config;
}

// ── Cache ────────────────────────────────────────────────────────────────

interface CacheEntry<T> { data: T; timestamp: number; }
const CACHE_TTL = 30_000;
let projectListCache: CacheEntry<ProjectInfo[]> | null = null;

function isCacheValid<T>(entry: CacheEntry<T> | null): entry is CacheEntry<T> {
  return entry !== null && Date.now() - entry.timestamp < CACHE_TTL;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function isDirectoryOrSymlink(fullPath: string): boolean {
  try { return statSync(fullPath).isDirectory(); } catch { return false; }
}

function scanWorkspaceDir(dir: string): Array<{ name: string; path: string; status: string }> {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((name) => !name.startsWith('.') && isDirectoryOrSymlink(join(dir, name)))
      .filter((name) => existsSync(join(dir, name, '.git')))
      .map((name) => ({ name, path: join(dir, name), status: 'cloned' }));
  } catch { return []; }
}

/**
 * Find all factory.yaml configs across known locations.
 */
function findProjectConfigs(): Array<{ name: string; path: string }> {
  const configs: Array<{ name: string; path: string }> = [];

  // Priority 1: ~/.anvil/projects/<name>/factory.yaml
  if (existsSync(PROJECTS_DIR)) {
    try {
      for (const name of readdirSync(PROJECTS_DIR)) {
        if (name.startsWith('.')) continue;
        const dir = join(PROJECTS_DIR, name);
        if (!isDirectoryOrSymlink(dir)) continue;
        const yamlPath = join(dir, 'factory.yaml');
        if (existsSync(yamlPath)) {
          configs.push({ name, path: yamlPath });
        }
      }
    } catch { /* ignore */ }
  }

  // Priority 2: Backward compat — ~/.anvil/projects/<name>/project.yaml
  const legacyDir = join(ANVIL_HOME, 'projects');
  if (existsSync(legacyDir)) {
    try {
      for (const name of readdirSync(legacyDir)) {
        if (name.startsWith('.')) continue;
        if (configs.some((c) => c.name === name)) continue; // don't override factory.yaml
        const dir = join(legacyDir, name);
        if (!isDirectoryOrSymlink(dir)) continue;
        const yamlPath = join(dir, 'project.yaml');
        if (existsSync(yamlPath)) {
          configs.push({ name, path: yamlPath });
        }
      }
    } catch { /* ignore */ }
  }

  return configs;
}

/**
 * Read a factory.yaml or legacy project.yaml and return a FactoryConfig.
 */
function readConfig(configPath: string): FactoryConfig | null {
  try {
    const raw = readFileSync(configPath, 'utf-8');

    // Detect legacy project.yaml by checking for 'project:' key
    if (configPath.endsWith('project.yaml') || /^project:\s+/m.test(raw)) {
      return convertLegacyConfig(raw, configPath);
    }

    return parseFactoryYaml(raw);
  } catch (err: any) {
    console.error(`[project-loader] Failed to read config at ${configPath}:`, err.message);
    return null;
  }
}

/**
 * Convert a legacy project.yaml to FactoryConfig.
 */
function convertLegacyConfig(raw: string, _path: string): FactoryConfig {
  // Minimal parse of top-level fields
  const getField = (key: string): string => {
    const match = raw.match(new RegExp(`^${key}:\\s+(.+)$`, 'm'));
    return match ? match[1].replace(/^["']|["']$/g, '').trim() : '';
  };

  const name = getField('project') || getField('name') || '';
  const title = getField('title') || name;
  const workspace = getField('workspace') || '';

  // Extract repos from the "repos:" block
  const repos: RepoConfig[] = [];
  const repoMatches = raw.matchAll(/^\s{2,4}-\s+name:\s+(.+)$/gm);
  for (const m of repoMatches) {
    const repoName = m[1].trim();
    // Try to find fields after this repo entry (until next repo or section)
    const afterMatch = raw.slice((m.index ?? 0) + m[0].length);
    const nextRepoOrSection = afterMatch.search(/^\s{2,4}-\s+name:|^[a-z]/m);
    const repoBlock = nextRepoOrSection > 0 ? afterMatch.slice(0, nextRepoOrSection) : afterMatch.slice(0, 500);
    const githubMatch = repoBlock.match(/^\s+github:\s+(.+)$/m);
    const langMatch = repoBlock.match(/^\s+language:\s+(.+)$/m);
    const pathMatch = repoBlock.match(/^\s+path:\s+(.+)$/m);

    repos.push({
      name: repoName,
      path: pathMatch ? pathMatch[1].trim() : `./${repoName}`,
      github: githubMatch ? githubMatch[1].trim() : '',
      language: langMatch ? langMatch[1].trim() : '',
    });
  }

  // Extract invariants
  const invariants: string[] = [];
  const invSection = raw.match(/^invariants:\s*\n((?:\s+-\s+.+\n?)*)/m);
  if (invSection) {
    const invItems = invSection[1].matchAll(/^\s+-\s+(.+)$/gm);
    for (const inv of invItems) {
      invariants.push(inv[1].replace(/^["']|["']$/g, '').trim());
    }
  }

  return {
    version: 1,
    project: name,
    title,
    workspace: workspace || undefined,
    repos,
    domain: invariants.length > 0 ? { invariants } : undefined,
  };
}

/**
 * Convert FactoryConfig to the backward-compatible ProjectInfo shape.
 */
function configToProjectInfo(config: FactoryConfig, repoPaths: Record<string, string>): ProjectInfo {
  return {
    name: config.project,
    title: config.title || config.project,
    owner: '',
    lifecycle: 'production',
    type: '',
    tier: '',
    repos: config.repos.map((r) => ({
      name: r.name,
      github: r.github || '',
      language: r.language || '',
      repoKind: '',
      description: r.description || '',
      localPath: repoPaths[r.name] || null,
      cloneStatus: repoPaths[r.name] ? 'cloned' as const : 'unknown' as const,
    })),
    invariants: (config.domain?.invariants || []).map((s, i) => ({
      id: `inv-${i}`,
      statement: s,
      criticality: 'high',
    })),
    criticalFlows: (config.domain?.critical_flows || []).map((f, i) => ({
      id: `flow-${i}`,
      name: f.name,
      trigger: Array.isArray(f.steps) ? f.steps.join(' → ') : String(f.steps),
    })),
    sharpEdges: (config.domain?.sharp_edges || []).map((s, i) => ({
      id: `se-${i}`,
      statement: s,
      severity: 'medium',
    })),
    glossary: Object.entries(config.domain?.glossary || {}).map(([term, definition]) => ({
      term,
      definition,
    })),
  };
}

// ── ProjectLoader class ──────────────────────────────────────────────────

export class ProjectLoader {
  private configs = new Map<string, FactoryConfig>();

  constructor() {
    if (!existsSync(PROJECTS_DIR)) {
      mkdirSync(PROJECTS_DIR, { recursive: true });
    }
  }

  /**
   * List all configured projects.
   * Lists all configured projects.
   */
  async listProjects(): Promise<ProjectInfo[]> {
    if (isCacheValid(projectListCache)) {
      return projectListCache.data;
    }

    const configDirs = findProjectConfigs();
    const projects: ProjectInfo[] = [];

    for (const { name, path: configPath } of configDirs) {
      const config = readConfig(configPath);
      if (!config || !config.project) continue;

      this.configs.set(name, config);
      const paths = this.getRepoLocalPaths(name);
      projects.push(configToProjectInfo(config, paths));
    }

    projectListCache = { data: projects, timestamp: Date.now() };
    console.log(`[project-loader] Found ${projects.length} project(s)`);
    return projects;
  }

  /**
   * Get full project details.
   * Gets full project details.
   */
  async getProject(name: string): Promise<ProjectInfo | null> {
    // Check cache first
    if (this.configs.has(name)) {
      const config = this.configs.get(name)!;
      const paths = this.getRepoLocalPaths(name);
      return configToProjectInfo(config, paths);
    }

    // Find and load
    const configDirs = findProjectConfigs();
    const match = configDirs.find((d) => d.name === name);
    if (!match) {
      console.warn(`[project-loader] Project "${name}" not found`);
      return null;
    }

    const config = readConfig(match.path);
    if (!config) return null;

    this.configs.set(name, config);
    const paths = this.getRepoLocalPaths(name);
    return configToProjectInfo(config, paths);
  }

  /**
   * Ensure workspace exists. Clones repos from GitHub if configured.
   * Clones repos from GitHub if configured.
   */
  async ensureWorkspace(project: string): Promise<WorkspaceStatus> {
    const config = this.getConfig(project);
    const wsPath = this.getWorkspacePath(project);

    if (!existsSync(wsPath)) {
      mkdirSync(wsPath, { recursive: true });
    }

    if (config) {
      // Clone any repos that don't exist yet
      for (const repo of config.repos) {
        const repoPath = this.resolveRepoPath(project, repo);
        if (existsSync(repoPath)) continue;
        if (!repo.github) continue;

        console.log(`[project-loader] Cloning ${repo.github} → ${repoPath}`);
        try {
          await execFileAsync('git', ['clone', `https://github.com/${repo.github}.git`, repoPath], {
            timeout: 120_000,
          });
        } catch (err: any) {
          console.error(`[project-loader] Failed to clone ${repo.github}: ${err.message}`);
        }
      }
    }

    return this.getWorkspaceStatus(project);
  }

  /**
   * Get workspace status.
   * Returns current workspace status.
   */
  getWorkspaceStatus(project: string): WorkspaceStatus {
    const wsPath = this.getWorkspacePath(project);
    const wsExists = existsSync(wsPath);

    if (!wsExists) {
      return { exists: false, path: wsPath, repos: [], lastUpdated: null };
    }

    const repos = scanWorkspaceDir(wsPath);
    let lastUpdated: string | null = null;
    try { lastUpdated = statSync(wsPath).mtime.toISOString(); } catch { /* ok */ }

    return { exists: true, path: wsPath, repos, lastUpdated };
  }

  /**
   * Returns map of repo name → local path.
   * Returns map of repo name to local path.
   */
  getRepoLocalPaths(project: string): Record<string, string> {
    const paths: Record<string, string> = {};
    const config = this.getConfig(project);
    const wsPath = this.getWorkspacePath(project);

    if (config) {
      // Use config-defined paths
      for (const repo of config.repos) {
        const resolved = this.resolveRepoPath(project, repo);
        if (existsSync(resolved)) {
          paths[repo.name] = resolved;
        }
      }
    }

    // Only scan workspace if no repos were found in config
    // (avoids picking up unrelated repos from shared workspace directories)
    if (Object.keys(paths).length === 0 && existsSync(wsPath)) {
      const scanned = scanWorkspaceDir(wsPath);
      for (const repo of scanned) {
        if (!paths[repo.name]) {
          paths[repo.name] = repo.path;
        }
      }
    }

    return paths;
  }

  /**
   * Returns the raw config content as a string for prompt injection.
   * Returns the raw config content for prompt injection.
   */
  getProjectYamlRaw(project: string): string {
    const configDirs = findProjectConfigs();
    const match = configDirs.find((d) => d.name === project);
    if (match) {
      try { return readFileSync(match.path, 'utf-8'); } catch { /* ok */ }
    }
    return '';
  }

  /**
   * Get the FactoryConfig for a project.
   */
  getConfig(project: string): FactoryConfig | null {
    if (this.configs.has(project)) return this.configs.get(project)!;

    const configDirs = findProjectConfigs();
    const match = configDirs.find((d) => d.name === project);
    if (!match) return null;

    const config = readConfig(match.path);
    if (config) this.configs.set(project, config);
    return config;
  }

  /**
   * Get the configured model for a specific stage.
   * Falls back: stage model → default model → 'claude-sonnet-4-6'
   */
  getModelForStage(project: string, stage: string): string {
    const config = this.getConfig(project);
    const models = config?.pipeline?.models;
    if (!models) return 'claude-sonnet-4-6';
    return models[stage] || models['default'] || 'claude-sonnet-4-6';
  }

  /**
   * Get budget config for a project — merges YAML values with defaults.
   */
  getBudgetConfig(project: string): BudgetConfig {
    const config = this.getConfig(project);
    return {
      max_per_run: config?.budget?.max_per_run ?? 100,
      max_per_day: config?.budget?.max_per_day ?? 200,
      alert_at: config?.budget?.alert_at ?? 80,
    };
  }

  /**
   * Save budget config back to factory.yaml.
   */
  saveBudgetConfig(project: string, budget: BudgetConfig): void {
    const configDirs = findProjectConfigs();
    const match = configDirs.find((d) => d.name === project);
    if (!match) return;

    let content: string;
    try {
      content = readFileSync(match.path, 'utf-8');
    } catch { return; }

    const budgetBlock = [
      'budget:',
      `  max_per_run: ${budget.max_per_run}`,
      `  max_per_day: ${budget.max_per_day}`,
      `  alert_at: ${budget.alert_at}`,
    ].join('\n');

    // Replace existing budget section or append
    const budgetRegex = /^budget:\s*\n(?:[ \t]+\S[^\n]*\n?)*/m;
    if (budgetRegex.test(content)) {
      content = content.replace(budgetRegex, budgetBlock + '\n');
    } else {
      content = content.trimEnd() + '\n\n' + budgetBlock + '\n';
    }

    writeFileSync(match.path, content, 'utf-8');
    this.invalidateCache();
  }

  /**
   * Get repo-specific commands from config.
   */
  getRepoCommands(project: string, repoName: string): RepoCommands | null {
    const config = this.getConfig(project);
    if (!config) return null;
    const repo = config.repos.find((r) => r.name === repoName);
    return repo?.commands || null;
  }

  /**
   * Create a project from a directory path — no YAML needed.
   * Scans for git repos, detects languages, persists a minimal factory.yaml.
   * LLM profiling + service mesh inference happen during indexing.
   */
  async createFromDirectory(projectName: string, directoryPath: string): Promise<ProjectInfo | null> {
    const config = createProjectFromScan(projectName, directoryPath);
    if (!config) return null;

    this.configs.set(projectName, config);
    this.invalidateCache();
    const paths = this.getRepoLocalPaths(projectName);
    return configToProjectInfo(config, paths);
  }

  /**
   * Invalidate cache.
   */
  invalidateCache(): void {
    projectListCache = null;
    this.configs.clear();
  }

  // ── Private helpers ────────────────────────────────────────────────────

  private getWorkspacePath(project: string): string {
    const config = this.getConfig(project);
    if (config?.workspace) {
      return config.workspace.startsWith('/') ? config.workspace : join(homedir(), config.workspace);
    }
    return join(getWorkspaceRoot(), project);
  }

  private resolveRepoPath(project: string, repo: RepoConfig): string {
    const wsPath = this.getWorkspacePath(project);
    if (repo.path.startsWith('/')) return repo.path;
    return join(wsPath, repo.path.replace(/^\.\//, ''));
  }
}

export default ProjectLoader;
