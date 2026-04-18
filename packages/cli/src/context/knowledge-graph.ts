/**
 * Knowledge Graph loader — reads GRAPH_REPORT.md files produced by Graphify.
 *
 * Loads pre-computed knowledge base reports from:
 *   ~/.anvil/knowledge-base/<project>/<repo>/GRAPH_REPORT.md
 *
 * Supports two modes:
 *   1. Index + query-matched context (when project_index.json is available)
 *   2. Full blob fallback (backward compat)
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const ANVIL_HOME = process.env.ANVIL_HOME || process.env.FF_HOME || join(homedir(), '.anvil');
const KB_DIR = join(ANVIL_HOME, 'knowledge-base');

// ── Types (mirrors dashboard server types) ───────────────────────────

interface CommunityInfo {
  id: string;
  repo: string;
  nodeCount: number;
  keywords: string[];
  entryPoints: string[];
  summary: string;
}

interface TransportEdge {
  type: string;
  name: string;
  producers: string[];
  consumers: string[];
}

interface ProjectIndex {
  project: string;
  generatedAt: string;
  repos: Array<{ name: string; nodeCount: number; communityCount: number; language: string }>;
  communities: CommunityInfo[];
  transports: TransportEdge[];
  entryPoints: Array<{ nodeId: string; repo: string; degree: number; label: string }>;
  keywordIndex: Record<string, string[]>;
}

// ── Project Index ─────────────────────────────────────────────────────

/**
 * Load the project index if available.
 */
export function loadProjectIndex(project: string): ProjectIndex | null {
  const indexPath = join(KB_DIR, project, 'project_index.json');
  if (!existsSync(indexPath)) return null;
  try {
    return JSON.parse(readFileSync(indexPath, 'utf-8'));
  } catch { return null; }
}

/**
 * Format the project index as a compact human-readable string for prompt injection.
 */
export function formatIndexForPrompt(index: ProjectIndex): string {
  const parts: string[] = [];
  parts.push(`# Project Knowledge Index: ${index.project}`);
  parts.push(`> ${index.repos.length} repos, ${index.communities.length} communities, ${index.transports.length} transports\n`);

  parts.push('## Repositories');
  for (const r of index.repos) {
    parts.push(`- **${r.name}**: ${r.nodeCount} nodes, ${r.communityCount} communities`);
  }

  parts.push('\n## Key Module Clusters');
  for (const c of index.communities.slice(0, 20)) {
    parts.push(`- **${c.id}** (${c.nodeCount} nodes): ${c.summary}`);
    parts.push(`  Keywords: ${c.keywords.join(', ')}`);
    parts.push(`  Entry points: ${c.entryPoints.join(', ')}`);
  }

  if (index.transports.length > 0) {
    parts.push('\n## Cross-Repo Transports');
    for (const t of index.transports) {
      const prods = t.producers.join(', ') || '(external)';
      const cons = t.consumers.join(', ') || '(external)';
      parts.push(`- **${t.type}:${t.name}**: ${prods} → ${cons}`);
    }
  }

  parts.push('\n## Top Entry Points (highest connectivity)');
  for (const ep of index.entryPoints.slice(0, 10)) {
    parts.push(`- ${ep.label} (${ep.repo}, degree: ${ep.degree})`);
  }

  return parts.join('\n');
}

// ── Query ────────────────────────────────────────────────────────────

/**
 * Query the KB index for a specific topic and return focused context chunks.
 */
export function queryKnowledgeBase(project: string, query: string, maxChars = 15000): string {
  const index = loadProjectIndex(project);
  if (!index) return '';

  const keywords = query.toLowerCase()
    .replace(/[^a-z0-9_\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 2);

  // Score communities
  const scored = index.communities.map((c) => {
    let score = 0;
    for (const kw of keywords) {
      if (c.keywords.some((ck) => ck.includes(kw) || kw.includes(ck))) score += 3;
      if (c.summary.toLowerCase().includes(kw)) score += 2;
      if (c.entryPoints.some((ep) => ep.toLowerCase().includes(kw))) score += 2;
    }
    return { community: c, score };
  });

  const matched = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  // Score transports
  const matchedTransports = index.transports
    .map((t) => {
      let score = 0;
      for (const kw of keywords) {
        if (t.name.toLowerCase().includes(kw)) score += 3;
        if (t.type.toLowerCase().includes(kw)) score += 1;
      }
      return { transport: t, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  // Build context
  const parts: string[] = [];
  parts.push(`# Knowledge Base Context (query-matched for: "${query.slice(0, 100)}")\n`);

  if (matchedTransports.length > 0) {
    parts.push('## Relevant Cross-Repo Transports');
    for (const { transport: t } of matchedTransports) {
      parts.push(`- **${t.type}:${t.name}**: ${t.producers.join(', ') || '(external)'} → ${t.consumers.join(', ') || '(external)'}`);
    }
    parts.push('');
  }

  if (matched.length > 0) {
    parts.push('## Matched Module Clusters');
    for (const { community: c } of matched) {
      parts.push(`- **${c.id}** (${c.repo}, ${c.nodeCount} nodes): ${c.summary}`);
    }
    parts.push('');
  }

  // Load GRAPH_REPORT sections for matched communities
  let totalChars = 0;
  const repoComms = new Map<string, CommunityInfo[]>();
  for (const { community } of matched) {
    const list = repoComms.get(community.repo) || [];
    list.push(community);
    repoComms.set(community.repo, list);
  }

  parts.push('## Detailed Context\n');
  for (const [repo, comms] of repoComms) {
    if (totalChars >= maxChars) break;
    const reportPath = join(KB_DIR, project, repo, 'GRAPH_REPORT.md');
    if (!existsSync(reportPath)) continue;
    let report: string;
    try { report = readFileSync(reportPath, 'utf-8'); } catch { continue; }

    const sections = report.split(/(?=###?\s+Community\s+\d)/i);
    let repoHasChunk = false;

    for (const comm of comms) {
      if (totalChars >= maxChars) break;
      const commNum = comm.id.split('::')[1] || '';
      const section = sections.find((s) => s.match(new RegExp(`community\\s+${commNum}\\b`, 'i')));
      if (section) {
        const chunk = section.slice(0, Math.min(section.length, maxChars - totalChars));
        parts.push(`### ${repo} (${comm.id})\n`);
        parts.push(chunk);
        totalChars += chunk.length;
        repoHasChunk = true;
      }
    }

    // Fallback: include portion of full report
    if (!repoHasChunk && totalChars < maxChars) {
      const chunk = report.slice(0, Math.min(report.length, maxChars - totalChars));
      parts.push(`### ${repo}\n`);
      parts.push(chunk);
      totalChars += chunk.length;
    }
  }

  return parts.join('\n');
}

// ── Main Loader ──────────────────────────────────────────────────────

/**
 * Load knowledge graph for prompt injection.
 * Prefers index + query-matched context when available, falls back to full blob.
 */
export async function loadKnowledgeGraph(project: string, featureQuery?: string): Promise<string> {
  // Prefer compact index + query if available
  const index = loadProjectIndex(project);
  if (index) {
    const indexStr = formatIndexForPrompt(index);
    const queryCtx = featureQuery ? queryKnowledgeBase(project, featureQuery) : '';
    return queryCtx ? `${indexStr}\n\n---\n\n${queryCtx}` : indexStr;
  }

  // Fallback: full blob
  const projectDir = join(KB_DIR, project);
  if (!existsSync(projectDir)) return '';

  const sections: string[] = [];

  // Load project-level synthesis (cross-repo relationships) if available
  const projectReportPath = join(projectDir, 'SYSTEM_REPORT.md');
  if (existsSync(projectReportPath)) {
    try {
      const projectReport = readFileSync(projectReportPath, 'utf-8');
      if (projectReport.trim()) sections.push(projectReport);
    } catch { /* ignore */ }
  }

  const repos = readdirSync(projectDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  // Load reports, filter out junk (0 nodes), sort largest first
  const reports: Array<{ repo: string; report: string }> = [];
  for (const repo of repos) {
    const reportPath = join(projectDir, repo, 'GRAPH_REPORT.md');
    if (!existsSync(reportPath)) continue;

    let report: string;
    try {
      report = readFileSync(reportPath, 'utf-8');
    } catch {
      continue;
    }

    if (!report.trim()) continue;
    // Skip junk reports: 0 nodes means this isn't a real repo KB
    if (/0 nodes/i.test(report) && report.length < 1000) continue;

    reports.push({ repo, report });
  }
  reports.sort((a, b) => b.report.length - a.report.length);

  for (const { repo, report } of reports) {
    sections.push(`## ${repo}\n\n${report}`);
  }

  return sections.join('\n\n---\n\n');
}

/**
 * Load knowledge graph report for a specific repo.
 */
export async function loadRepoKnowledgeGraph(project: string, repo: string): Promise<string> {
  const reportPath = join(KB_DIR, project, repo, 'GRAPH_REPORT.md');
  if (!existsSync(reportPath)) return '';
  try {
    return readFileSync(reportPath, 'utf-8');
  } catch {
    return '';
  }
}
