/**
 * Project registry (P8) — per-project metadata read from
 * `<dataDir>/projects/<name>/project.yaml`:
 *
 *     workspace: /path/to/repos
 *     repos: [a, b]                 # restrict-list — parsed, not enforced
 *     quotas:
 *       max_queries_per_minute: 60  # enforced on /mcp
 *       max_embedding_cost_usd: 5   # parsed, not enforced
 *       max_llm_cost_usd: 5         # parsed, not enforced
 *     scopes: [team-a]              # enforced on /mcp
 *
 * A `config:` block is not read: a project's config is its workspace's
 * `.code-search.yaml` layer (`ProjectEntry.config`).
 *
 * The HTTP server (`server.ts`) loads the registry once at boot and, when the
 * project it serves has an entry, gates every /mcp request on it: scopes via
 * `projectAccessAllowed`, the query quota via `projectQuotaKey`. Nothing else
 * consumes the registry.
 */

import { readdirSync, existsSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  resolveCodeSearchConfig,
  type CodeSearchConfig,
} from '../core/config.js';
import { localRateHit } from '../middleware/rate-limit.js';

export interface ProjectEntry {
  name: string;
  workspaceDir: string;
  /** Restrict-list of repo names as written (not enforced anywhere). */
  repos: string[];
  /** Resolved config (merged DEFAULTS → global → workspace overlay). */
  config: CodeSearchConfig;
  quotas: ProjectQuotas;
  /** Auth scopes required to access this project. Empty → public. */
  scopes: string[];
}

export interface ProjectQuotas {
  maxQueriesPerMinute: number;
  /** Embedding spend ceiling (USD) as written — not enforced. */
  maxEmbeddingCostUsd: number;
  /** LLM spend ceiling (USD) as written — not enforced. */
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

/** Rate-limiter key for the per-(identity, project) query quota. */
export function projectQuotaKey(project: ProjectEntry, identity: string): string {
  return `project:${project.name}|${identity}`;
}

/**
 * Per-project sliding-window query quota, keyed by (identity, project) so a
 * single identity scanning N projects has N separate rates. Same window as
 * the auth limiter (`middleware/rate-limit.ts`); the HTTP server checks it
 * through its (cluster-global) RateLimiter with the same key.
 */
export function checkProjectQuota(project: ProjectEntry, identity: string): { ok: true } | { ok: false; reason: string; retryAfterSec: number } {
  const d = localRateHit(projectQuotaKey(project, identity), project.quotas.maxQueriesPerMinute);
  if (d.ok) return { ok: true };
  return {
    ok: false,
    reason: `quota exceeded for project="${project.name}": ${project.quotas.maxQueriesPerMinute}/min`,
    retryAfterSec: d.retryAfterSec,
  };
}
