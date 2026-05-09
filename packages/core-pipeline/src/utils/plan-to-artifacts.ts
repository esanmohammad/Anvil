/**
 * plan-to-artifacts — deterministic renderers that turn a Plan into the
 * Markdown artifacts the pipeline expects (REQUIREMENTS.md, SPECS.md,
 * TASKS.md — both cross-repo and per-repo).
 *
 * This is how a validated plan lets the pipeline skip stages 1–4: instead of
 * running agents to produce these artifacts, we render them from the plan.
 *
 * Phase F8 — promoted from `packages/dashboard/server/plan-to-artifacts.ts`
 * into `core-pipeline/utils`. Pure renderers; depends on F7's `Plan`
 * vocabulary. Cli will adopt the same renderers when its consolidation
 * lands.
 */

import type { Plan, PlanRepoImpact, PlanContract } from './plan-types.js';

// ── Cross-repo REQUIREMENTS.md ───────────────────────────────────────────

export function renderRequirements(plan: Plan): string {
  const parts: string[] = [];
  parts.push(`# Requirements — ${plan.title}`);
  parts.push(`_Derived from Plan v${plan.version} (${plan.slug})_\n`);

  parts.push('## Problem');
  parts.push(plan.problem);
  parts.push('');

  parts.push('## Scope');
  parts.push('**In scope:**');
  for (const s of plan.scope.inScope) parts.push(`- ${s}`);
  if (plan.scope.outOfScope.length) {
    parts.push('\n**Out of scope:**');
    for (const s of plan.scope.outOfScope) parts.push(`- ${s}`);
  }
  parts.push('');

  parts.push('## Affected repositories');
  parts.push(`${plan.repos.length} repo(s): ${plan.repos.map((r) => r.name).join(', ')}\n`);

  if (plan.contracts.length) {
    parts.push('## Cross-repo contracts');
    for (const c of plan.contracts) {
      parts.push(`- **${c.kind.toUpperCase()} · ${c.name}** — ${c.producer} → ${c.consumers.join(', ') || '(none)'}: ${c.description}`);
    }
    parts.push('');
  }

  if (plan.architecture.notes || plan.architecture.mermaid) {
    parts.push('## Architecture');
    if (plan.architecture.notes) parts.push(plan.architecture.notes, '');
    if (plan.architecture.mermaid) {
      parts.push('```mermaid');
      parts.push(plan.architecture.mermaid);
      parts.push('```\n');
    }
  }

  if (plan.risks.length) {
    parts.push('## Risks');
    for (const r of plan.risks) {
      parts.push(`- **[${r.severity}] ${r.title}** — ${r.mitigation}`);
    }
    parts.push('');
  }

  parts.push('## Rollout');
  if (plan.rollout.strategy) parts.push(plan.rollout.strategy);
  if (plan.rollout.flags.length) parts.push(`- Feature flags: ${plan.rollout.flags.join(', ')}`);
  if (plan.rollout.order.length) parts.push(`- Deploy order: ${plan.rollout.order.join(' → ')}`);
  if (plan.rollout.rollback) parts.push(`- Rollback: ${plan.rollout.rollback}`);
  parts.push('');

  parts.push('## Success criteria');
  const all = [...plan.tests.unit, ...plan.tests.integration, ...plan.tests.manual];
  for (const t of all) parts.push(`- ${t}`);

  return parts.join('\n');
}

// ── Per-repo artifacts ───────────────────────────────────────────────────

export function renderRepoRequirements(plan: Plan, repoName: string): string {
  const repo = plan.repos.find((r) => r.name === repoName);
  if (!repo) return `# Requirements — ${repoName}\n\n_Repo not referenced in plan v${plan.version}. No changes expected._`;

  const relevantContracts = plan.contracts.filter(
    (c) => c.producer === repoName || c.consumers.includes(repoName),
  );

  const parts: string[] = [];
  parts.push(`# Requirements — ${repoName}`);
  parts.push(`_From Plan v${plan.version} (${plan.slug})_\n`);

  parts.push('## Changes');
  parts.push(repo.changes);
  parts.push('');

  if (repo.files.length) {
    parts.push('## Files to touch');
    for (const f of repo.files) parts.push(`- \`${f}\``);
    parts.push('');
  }

  if (repo.symbols.length) {
    parts.push('## Symbols to modify or add');
    for (const s of repo.symbols) parts.push(`- \`${s}\``);
    parts.push('');
  }

  if (relevantContracts.length) {
    parts.push('## Contracts involving this repo');
    for (const c of relevantContracts) {
      const role = c.producer === repoName ? 'produces' : 'consumes';
      parts.push(`- **${c.kind.toUpperCase()} · ${c.name}** (${role}) — ${c.description}`);
    }
    parts.push('');
  }

  return parts.join('\n');
}

export function renderRepoSpecs(plan: Plan, repoName: string): string {
  const repo = plan.repos.find((r) => r.name === repoName);
  if (!repo) return `# Specs — ${repoName}\n\n_Repo not referenced in plan v${plan.version}._`;

  const relevantContracts = plan.contracts.filter(
    (c) => c.producer === repoName || c.consumers.includes(repoName),
  );

  const parts: string[] = [];
  parts.push(`# Specs — ${repoName}`);
  parts.push(`_From Plan v${plan.version} (${plan.slug})_\n`);

  parts.push('## Approach');
  parts.push(repo.changes);
  parts.push('');

  if (repo.files.length || repo.symbols.length) {
    parts.push('## Implementation targets');
    if (repo.files.length) {
      parts.push('**Files:**');
      for (const f of repo.files) parts.push(`- \`${f}\``);
    }
    if (repo.symbols.length) {
      parts.push('\n**Symbols:**');
      for (const s of repo.symbols) parts.push(`- \`${s}\``);
    }
    parts.push('');
  }

  if (relevantContracts.length) {
    parts.push('## Contract specifications');
    for (const c of relevantContracts) parts.push(renderContractSpec(c, repoName));
    parts.push('');
  }

  if (plan.architecture.notes) {
    parts.push('## Architectural context');
    parts.push(plan.architecture.notes);
    parts.push('');
  }

  return parts.join('\n');
}

export function renderRepoTasks(plan: Plan, repoName: string): string {
  const repo = plan.repos.find((r) => r.name === repoName);
  if (!repo) return `# Tasks — ${repoName}\n\n_No tasks — repo not in plan._`;

  const relevantContracts = plan.contracts.filter(
    (c) => c.producer === repoName || c.consumers.includes(repoName),
  );

  const parts: string[] = [];
  parts.push(`# Tasks — ${repoName}`);
  parts.push(`_Derived from Plan v${plan.version} (${plan.slug})_\n`);

  const tasks: string[] = [];

  // One task per file
  for (const f of repo.files) {
    tasks.push(`Implement changes in \`${f}\``);
  }
  // One task per symbol (if not already covered by file list)
  const fileMentionsSymbol = (sym: string) =>
    repo.files.some((f) => f.toLowerCase().includes(sym.toLowerCase().split(/[./:]/).pop() ?? sym.toLowerCase()));
  for (const s of repo.symbols) {
    if (!fileMentionsSymbol(s)) tasks.push(`Modify or add symbol \`${s}\``);
  }
  // One task per contract the repo owns
  for (const c of relevantContracts) {
    if (c.producer === repoName) {
      tasks.push(`Expose ${c.kind.toUpperCase()} contract \`${c.name}\` — ${c.description}`);
    } else {
      tasks.push(`Consume ${c.kind.toUpperCase()} contract \`${c.name}\` from \`${c.producer}\``);
    }
  }
  // Relevant tests from the plan (best-effort: keyword match on repo name)
  const planTests = [
    ...plan.tests.unit.map((t) => ({ t, kind: 'unit' })),
    ...plan.tests.integration.map((t) => ({ t, kind: 'integration' })),
  ];
  const repoTests = planTests.filter(({ t }) => t.toLowerCase().includes(repoName.toLowerCase()));
  for (const { t, kind } of repoTests) tasks.push(`Write ${kind} test: ${t}`);

  if (tasks.length === 0) {
    tasks.push(`Apply the plan changes for ${repoName}: ${repo.changes}`);
  }

  parts.push('## Task list');
  tasks.forEach((t, i) => parts.push(`${i + 1}. ${t}`));
  parts.push('');

  if (plan.rollout.strategy) {
    parts.push('## Rollout note');
    parts.push(plan.rollout.strategy);
  }

  return parts.join('\n');
}

function renderContractSpec(c: PlanContract, _repoName: string): string {
  const lines: string[] = [];
  lines.push(`\n### ${c.kind.toUpperCase()} · ${c.name}`);
  lines.push(`- Producer: \`${c.producer}\``);
  lines.push(`- Consumers: ${c.consumers.length ? c.consumers.map((x) => `\`${x}\``).join(', ') : '(none)'}`);
  lines.push(`- Description: ${c.description}`);
  return lines.join('\n');
}

// ── Coverage helper — detect if a plan fully covers a repo ────────────────

export function planCoversRepo(plan: Plan, repoName: string): boolean {
  const repo = plan.repos.find((r) => r.name === repoName);
  return !!(repo && repo.changes.trim().length > 0);
}

/** Which stages can be fully derived from the plan for this repo? */
export function planCoversStagesForRepo(plan: Plan, repoName: string): {
  requirements: boolean; specs: boolean; tasks: boolean;
} {
  const covers = planCoversRepo(plan, repoName);
  return { requirements: covers, specs: covers, tasks: covers };
}

export function planCoversCrossRepo(plan: Plan): {
  requirements: boolean;
} {
  return { requirements: plan.problem.trim().length > 0 && plan.repos.length > 0 };
}

// ── Summary of what was derived — useful for agent-output logs ────────────

export function summarisePlanSkip(plan: Plan, repoNames: string[]): string {
  const coveredRepos = repoNames.filter((n) => planCoversRepo(plan, n));
  const skippedRepos = repoNames.filter((n) => !planCoversRepo(plan, n));
  return [
    `🎯 [plan-seed] Deriving artifacts from Plan v${plan.version} (${plan.slug}) — ${coveredRepos.length}/${repoNames.length} repos covered.`,
    coveredRepos.length ? `   Covered: ${coveredRepos.join(', ')}` : '',
    skippedRepos.length ? `   ⚠ Not in plan (will still run agents): ${skippedRepos.join(', ')}` : '',
  ].filter(Boolean).join('\n');
}

export { type PlanRepoImpact };
