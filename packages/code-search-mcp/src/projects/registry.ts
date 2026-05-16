/**
 * Project registry (P8) — multi-project workspaces inside one daemon /
 * server. Each project has its own config overrides, repos, and (eventually)
 * its own auth scope + spend ceiling.
 *
 * On-disk layout (see CODE-SEARCH-MCP-STANDALONE-PLAN.md §3.9):
 *
 *   <dataDir>/projects/<name>/project.yaml
 *     workspace: /path/to/repos
 *     repos: [a, b]               # optional restrict-list
 *     config:                     # optional partial CodeSearchConfig override
 *       embedding:
 *         provider: codestral
 *     quotas:
 *       max_queries_per_minute: 60
 *       max_embedding_cost_usd: 5
 *     scopes: [team-a]
 *
 * The registry is a thin file-backed reader. Daemon/server iterate the
 * directory at boot to discover projects.
 */

import { readdirSync, existsSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  resolveCodeSearchConfig,
  type CodeSearchConfig,
} from '../core/config.js';

export interface ProjectEntry {
  name: string;
  workspaceDir: string;
  /** Optional restrict-list of repo names; empty → all repos under workspace */
  repos: string[];
  /** Resolved config (merged DEFAULTS → global → workspace overlay). */
  config: CodeSearchConfig;
  quotas: ProjectQuotas;
  /** Auth scopes required to access this project. Empty → public. */
  scopes: string[];
}

export interface ProjectQuotas {
  maxQueriesPerMinute: number;
  /** Hard ceiling on embedding spend (USD). 0 = unlimited. */
  maxEmbeddingCostUsd: number;
  /** Hard ceiling on LLM spend (USD) for profiling+service-mesh. */
  maxLlmCostUsd: number;
}

const DEFAULT_QUOTAS: ProjectQuotas = {
  maxQueriesPerMinute: 100,
  maxEmbeddingCostUsd: 0,
  maxLlmCostUsd: 0,
};

interface ProjectYaml {
  workspace?: string;
  repos?: string[];
  scopes?: string[];
  quotas?: Partial<ProjectQuotas> & {
    max_queries_per_minute?: number;
    max_embedding_cost_usd?: number;
    max_llm_cost_usd?: number;
  };
  // We don't parse a deep config patch here; the workspace's
  // .code-search.yaml is the per-project override the resolver picks up.
}

function parseSimpleYaml(src: string): ProjectYaml {
  // Reuse the same minimal parser as the unified config; for project
  // metadata the surface is small enough that we hand-parse.
  const obj: ProjectYaml = {};
  const lines = src.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].replace(/#.*$/, '').replace(/\s+$/, '');
    if (!line.trim()) { i++; continue; }
    const top = /^(\w+):\s*(.*)$/.exec(line);
    if (!top) { i++; continue; }
    const key = top[1];
    const valRaw = top[2];
    if (!valRaw) {
      // Nested block
      const sub: Record<string, unknown> = {};
      i++;
      while (i < lines.length) {
        const sline = lines[i].replace(/#.*$/, '').replace(/\s+$/, '');
        if (!sline) { i++; continue; }
        const indent = sline.length - sline.trimStart().length;
        if (indent < 2) break;
        const m = /^\s*(\w+):\s*(.*)$/.exec(sline);
        if (!m) { i++; continue; }
        sub[m[1]] = coerce(m[2]);
        i++;
      }
      (obj as Record<string, unknown>)[key] = sub;
    } else {
      (obj as Record<string, unknown>)[key] = coerce(valRaw);
      i++;
    }
  }
  return obj;
}

function coerce(raw: string): unknown {
  let v = raw.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^-?\d+\.\d+$/.test(v)) return parseFloat(v);
  if (v.startsWith('[') && v.endsWith(']')) return v.slice(1, -1).split(',').map((s) => coerce(s.trim()));
  return v;
}

function readProjectYaml(path: string): ProjectYaml {
  if (!existsSync(path)) return {};
  try {
    return parseSimpleYaml(readFileSync(path, 'utf-8'));
  } catch {
    return {};
  }
}

export class ProjectRegistry {
  private projects = new Map<string, ProjectEntry>();

  constructor(private readonly dataDir: string) {}

  /** Re-read the projects/ directory. */
  reload(): ProjectEntry[] {
    this.projects.clear();
    const projectsDir = join(this.dataDir, 'projects');
    if (!existsSync(projectsDir)) return [];

    for (const name of readdirSync(projectsDir)) {
      const dir = join(projectsDir, name);
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch { continue; }

      const yamlPath = join(dir, 'project.yaml');
      const meta = readProjectYaml(yamlPath);
      if (!meta.workspace) continue;
      const workspaceDir = String(meta.workspace);

      const quotas: ProjectQuotas = {
        maxQueriesPerMinute:
          (meta.quotas?.max_queries_per_minute as number | undefined)
            ?? meta.quotas?.maxQueriesPerMinute
            ?? DEFAULT_QUOTAS.maxQueriesPerMinute,
        maxEmbeddingCostUsd:
          (meta.quotas?.max_embedding_cost_usd as number | undefined)
            ?? meta.quotas?.maxEmbeddingCostUsd
            ?? DEFAULT_QUOTAS.maxEmbeddingCostUsd,
        maxLlmCostUsd:
          (meta.quotas?.max_llm_cost_usd as number | undefined)
            ?? meta.quotas?.maxLlmCostUsd
            ?? DEFAULT_QUOTAS.maxLlmCostUsd,
      };

      const config = resolveCodeSearchConfig({ workspaceDir });

      this.projects.set(name, {
        name,
        workspaceDir,
        repos: Array.isArray(meta.repos) ? meta.repos as string[] : [],
        scopes: Array.isArray(meta.scopes) ? meta.scopes as string[] : [],
        config,
        quotas,
      });
    }
    return [...this.projects.values()];
  }

  list(): ProjectEntry[] {
    return [...this.projects.values()];
  }

  get(name: string): ProjectEntry | undefined {
    return this.projects.get(name);
  }
}

/**
 * Authorize an identity's scopes against a project's required scopes.
 *
 * - Empty project scopes → public (anyone authenticated may access).
 * - `*` in identity scopes → admin (full access).
 * - Otherwise: at least one scope must match.
 */
export function projectAccessAllowed(
  project: ProjectEntry,
  identityScopes: string[],
): boolean {
  if (project.scopes.length === 0) return true;
  if (identityScopes.includes('*')) return true;
  for (const s of identityScopes) {
    if (project.scopes.includes(s)) return true;
  }
  return false;
}

/**
 * Per-project sliding-window query quota. Mirrors the auth.ts limiter
 * but keyed by (identity, project) so a single identity scanning N
 * projects can have N separate rates.
 */
const projectRateBuckets = new Map<string, { count: number; resetAt: number }>();

export function checkProjectQuota(project: ProjectEntry, identity: string): { ok: true } | { ok: false; reason: string } {
  if (project.quotas.maxQueriesPerMinute <= 0) return { ok: true };
  const key = `${identity}|${project.name}`;
  const now = Date.now();
  const bucket = projectRateBuckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    projectRateBuckets.set(key, { count: 1, resetAt: now + 60_000 });
    return { ok: true };
  }
  if (bucket.count >= project.quotas.maxQueriesPerMinute) {
    return { ok: false, reason: `quota exceeded for project="${project.name}": ${project.quotas.maxQueriesPerMinute}/min` };
  }
  bucket.count++;
  return { ok: true };
}
