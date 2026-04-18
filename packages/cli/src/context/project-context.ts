import type { Project, Invariant, SharpEdge, CriticalFlow } from '../project/types.js';

export interface ProjectContext {
  invariants: Invariant[];
  sharpEdges: SharpEdge[];
  criticalFlows: CriticalFlow[];
  repoSummary: string;
  interfaceSummary: string;
  infraDeps: string;
}

export function extractProjectContext(project: Project): ProjectContext {
  return {
    invariants: project.invariants || [],
    sharpEdges: project.sharp_edges || [],
    criticalFlows: project.critical_flows || [],
    repoSummary: buildRepoSummary(project),
    interfaceSummary: buildInterfaceSummary(project),
    infraDeps: buildInfraDeps(project),
  };
}

function buildRepoSummary(sys: Project): string {
  return sys.repos
    .map(r => `- **${r.name}** (${r.github})${r.description ? `: ${r.description}` : ''}`)
    .join('\n');
}

function buildInterfaceSummary(sys: Project): string {
  const lines: string[] = [];
  for (const repo of sys.repos) {
    const ifaces = repo.interfaces;
    if (!ifaces) continue;
    const parts: string[] = [];
    for (const direction of ['exposes', 'consumes', 'produces', 'subscribes'] as const) {
      const group = ifaces[direction];
      if (!group) continue;
      if (group.http?.length) parts.push(`${group.http.length} HTTP`);
      if (group.kafka?.length) parts.push(`${group.kafka.length} Kafka`);
      if (group.redis_pubsub?.length) parts.push(`${group.redis_pubsub.length} Redis PubSub`);
      if (group.redis_lists?.length) parts.push(`${group.redis_lists.length} Redis Lists`);
      if (group.mongo?.length) parts.push(`${group.mongo.length} Mongo`);
    }
    if (parts.length > 0) {
      lines.push(`- ${repo.name}: ${parts.join(', ')}`);
    }
  }
  return lines.length > 0 ? lines.join('\n') : 'No interfaces defined';
}

function buildInfraDeps(sys: Project): string {
  const deps = new Set<string>();
  for (const repo of sys.repos) {
    if (repo.depends_on) {
      for (const dep of repo.depends_on) {
        deps.add(dep.type || dep.name);
      }
    }
  }
  return deps.size > 0 ? Array.from(deps).sort().join(', ') : 'None';
}

export function projectContextToMarkdown(ctx: ProjectContext): string {
  const sections: string[] = [];

  if (ctx.invariants.length > 0) {
    sections.push('### Invariants\n');
    for (const inv of ctx.invariants) {
      sections.push(`- **${inv.id}** [${inv.criticality || 'unspecified'}]: ${inv.statement}`);
    }
    sections.push('');
  }

  if (ctx.sharpEdges.length > 0) {
    sections.push('### Sharp Edges\n');
    for (const se of ctx.sharpEdges) {
      sections.push(`- **${se.id}** [${se.severity || 'unspecified'}]: ${se.statement}`);
    }
    sections.push('');
  }

  if (ctx.criticalFlows.length > 0) {
    sections.push('### Critical Flows\n');
    for (const cf of ctx.criticalFlows) {
      sections.push(`- **${cf.id}** — ${cf.name}`);
      if (cf.steps) {
        for (const step of cf.steps) {
          sections.push(`  1. [${step.component}] ${step.action}`);
        }
      }
    }
    sections.push('');
  }

  sections.push('### Repositories\n');
  sections.push(ctx.repoSummary);
  sections.push('');

  sections.push('### Interfaces\n');
  sections.push(ctx.interfaceSummary);
  sections.push('');

  sections.push('### Infrastructure Dependencies\n');
  sections.push(ctx.infraDeps);

  return sections.join('\n');
}
