/**
 * plan-to-artifacts — deterministic renderers that turn a Plan into the
 * Markdown artifacts the pipeline expects (REQUIREMENTS.md, SPECS.md,
 * TASKS.md — both cross-repo and per-repo).
 *
 * This is how a validated plan lets the pipeline skip stages 1–4:
 * instead of running agents to produce these artifacts, we render them
 * from the plan.
 *
 * Plan v2 — renders the structured contract (mustTouch / mustExist /
 * symbols / acceptance / TestCaseSpec) rather than the v1 string-list
 * shape. Migration on read (see `plan/migrate.ts`) ensures every input
 * is v2-shaped.
 */

import type {
  Plan,
  PlanContract,
  PlanRepoImpact,
  TestCaseSpec,
} from './plan-types.js';
import { planRepoTouchedPaths, planAllTestCases } from './plan-types.js';

// ── Cross-repo REQUIREMENTS.md ───────────────────────────────────────────

export function renderRequirements(plan: Plan): string {
  const parts: string[] = [];
  parts.push(`# Requirements — ${plan.title}`);
  parts.push(`_Derived from Plan v${plan.version} (${plan.slug})_\n`);

  parts.push('## Problem');
  parts.push(plan.problem.statement);
  if (plan.problem.why_now) {
    parts.push('\n**Why now**: ' + plan.problem.why_now);
  }
  if (plan.problem.success_signals.length) {
    parts.push('\n**Success signals**:');
    for (const s of plan.problem.success_signals) parts.push(`- ${s}`);
  }
  parts.push('');

  parts.push('## Scope');
  parts.push('**In scope:**');
  for (const item of plan.scope.inScope) {
    parts.push(`- **${item.id}** — ${item.description}`);
    for (const a of item.acceptance) parts.push(`  - _Acceptance:_ ${a}`);
  }
  if (plan.scope.outOfScope.length) {
    parts.push('\n**Out of scope:**');
    for (const item of plan.scope.outOfScope) {
      parts.push(`- ${item.description}`);
    }
  }
  parts.push('');

  parts.push('## Affected repositories');
  parts.push(`${plan.repos.length} repo(s): ${plan.repos.map((r) => r.name).join(', ')}\n`);

  if (plan.contracts.length) {
    parts.push('## Cross-repo contracts');
    for (const c of plan.contracts) {
      parts.push(`- ${formatContractSummary(c)}`);
    }
    parts.push('');
  }

  if (plan.data.length) {
    parts.push('## Data changes');
    for (const d of plan.data) {
      parts.push(`- **${d.kind}** in \`${d.repo}\` — \`${d.migrationFile}\` (rollback: ${d.rollback || '_not declared_'})`);
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
      parts.push(`- **[${r.severity}/${r.blastRadius}] ${r.title}** — ${r.mitigation}`);
    }
    parts.push('');
  }

  parts.push('## Rollout');
  if (plan.rollout.strategy) parts.push(`- Strategy: \`${plan.rollout.strategy}\``);
  if (plan.rollout.flags.length) parts.push(`- Feature flags: ${plan.rollout.flags.join(', ')}`);
  if (plan.rollout.order.length) parts.push(`- Deploy order: ${plan.rollout.order.join(' → ')}`);
  if (plan.rollout.rollback.command) parts.push(`- Rollback: \`${plan.rollout.rollback.command}\``);
  if (plan.rollout.rollback.verify) parts.push(`  (verify: \`${plan.rollout.rollback.verify}\`)`);
  parts.push('');

  parts.push('## Success criteria');
  const all = planAllTestCases(plan);
  for (const t of all) parts.push(`- ${t.given || ''} _when_ ${t.when || ''} _then_ ${t.then || ''}`);
  for (const m of plan.tests.manual ?? []) parts.push(`- _(manual)_ ${m.description}`);

  return parts.join('\n');
}

// ── Per-repo artifacts ───────────────────────────────────────────────────

export function renderRepoRequirements(plan: Plan, repoName: string): string {
  const repo = plan.repos.find((r) => r.name === repoName);
  if (!repo) return `# Requirements — ${repoName}\n\n_Repo not referenced in plan v${plan.version}. No changes expected._`;

  const relevantContracts = plan.contracts.filter(
    (c) => c.producer === repoName || (c.kind !== 'db' && c.consumers.includes(repoName)),
  );

  const parts: string[] = [];
  parts.push(`# Requirements — ${repoName}`);
  parts.push(`_From Plan v${plan.version} (${plan.slug})_\n`);

  parts.push('## Changes');
  parts.push(repo.changes);
  parts.push('');

  const touched = planRepoTouchedPaths(repo);
  if (touched.length) {
    parts.push('## Files to touch');
    for (const claim of repo.mustTouch) {
      parts.push(`- \`${claim.path}\` _(modified)_ — ${claim.reason || '(no reason given)'}`);
    }
    for (const claim of repo.mustExist) {
      parts.push(`- \`${claim.path}\` _(new)_ — ${claim.reason || '(no reason given)'}`);
    }
    parts.push('');
  }

  if (repo.symbols.length) {
    parts.push('## Symbols to add or modify');
    for (const s of repo.symbols) {
      parts.push(`- \`${s.name}\` (${s.kind}) in \`${s.file}\``);
    }
    parts.push('');
  }

  if (repo.mustNotBreak.length) {
    parts.push('## Public surface to preserve');
    for (const p of repo.mustNotBreak) parts.push(`- \`${p}\``);
    parts.push('');
  }

  if (relevantContracts.length) {
    parts.push('## Contracts involving this repo');
    for (const c of relevantContracts) {
      const role = c.producer === repoName ? 'produces' : 'consumes';
      parts.push(`- ${formatContractSummary(c)} _(${role})_`);
    }
    parts.push('');
  }

  return parts.join('\n');
}

export function renderRepoSpecs(plan: Plan, repoName: string): string {
  const repo = plan.repos.find((r) => r.name === repoName);
  if (!repo) return `# Specs — ${repoName}\n\n_Repo not referenced in plan v${plan.version}._`;

  const relevantContracts = plan.contracts.filter(
    (c) => c.producer === repoName || (c.kind !== 'db' && c.consumers.includes(repoName)),
  );

  const parts: string[] = [];
  parts.push(`# Specs — ${repoName}`);
  parts.push(`_From Plan v${plan.version} (${plan.slug})_\n`);

  parts.push('## Approach');
  parts.push(repo.changes);
  parts.push('');

  const touched = planRepoTouchedPaths(repo);
  if (touched.length || repo.symbols.length) {
    parts.push('## Implementation targets');
    if (repo.mustTouch.length) {
      parts.push('**Modify:**');
      for (const claim of repo.mustTouch) parts.push(`- \`${claim.path}\` — ${claim.reason || ''}`);
    }
    if (repo.mustExist.length) {
      parts.push('\n**Add:**');
      for (const claim of repo.mustExist) parts.push(`- \`${claim.path}\` — ${claim.reason || ''}`);
    }
    if (repo.symbols.length) {
      parts.push('\n**Symbols:**');
      for (const s of repo.symbols) parts.push(`- \`${s.name}\` (${s.kind}) in \`${s.file}\`${s.signature ? ` — \`${s.signature}\`` : ''}`);
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
    (c) => c.producer === repoName || (c.kind !== 'db' && c.consumers.includes(repoName)),
  );

  const parts: string[] = [];
  parts.push(`# Tasks — ${repoName}`);
  parts.push(`_Derived from Plan v${plan.version} (${plan.slug})_\n`);

  const tasks: string[] = [];

  // One task per file claim — modified files first, new files second.
  for (const claim of repo.mustTouch) tasks.push(`Modify \`${claim.path}\`${claim.reason ? ` — ${claim.reason}` : ''}`);
  for (const claim of repo.mustExist) tasks.push(`Create \`${claim.path}\`${claim.reason ? ` — ${claim.reason}` : ''}`);
  // One task per symbol if not already covered by a file claim.
  const touchedFiles = new Set(planRepoTouchedPaths(repo));
  for (const sym of repo.symbols) {
    if (sym.file && touchedFiles.has(sym.file)) continue;
    tasks.push(`Add or modify symbol \`${sym.name}\` (${sym.kind})${sym.file ? ` in \`${sym.file}\`` : ''}`);
  }
  // One task per contract the repo owns.
  for (const c of relevantContracts) {
    if (c.producer === repoName) {
      tasks.push(`Expose ${formatContractSummary(c)}`);
    } else {
      tasks.push(`Consume ${formatContractSummary(c)} from \`${c.producer}\``);
    }
  }
  // Plan tests that target this repo (best-effort: file path or test name mentions it).
  const planTests = planAllTestCases(plan).filter((t) =>
    (t.file && t.file.toLowerCase().includes(repoName.toLowerCase()))
    || t.name.toLowerCase().includes(repoName.toLowerCase()),
  );
  for (const t of planTests) tasks.push(`Implement test \`${t.name}\` in \`${t.file}\``);

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

// ── Contract formatters ─────────────────────────────────────────────────

function formatContractSummary(c: PlanContract): string {
  if (c.kind === 'http') {
    return `**HTTP ${c.method} \`${c.path}\`** — ${c.producer} → ${c.consumers.join(', ') || '(none)'}`;
  }
  if (c.kind === 'kafka') {
    return `**KAFKA \`${c.topic}\`** — ${c.producer} → ${c.consumers.join(', ') || '(none)'}`;
  }
  if (c.kind === 'grpc') {
    return `**GRPC ${c.service}.${c.method}** — ${c.producer} → ${c.consumers.join(', ') || '(none)'}`;
  }
  // db
  return `**DB \`${c.table}\`** — owner: ${c.producer}`;
}

function renderContractSpec(c: PlanContract, _repoName: string): string {
  const lines: string[] = [];
  lines.push(`\n### ${formatContractSummary(c)}`);
  if (c.kind === 'http') {
    lines.push(`- Path: \`${c.path}\` (status codes: ${c.status.join(', ')})`);
    if (c.request) lines.push(`- Request type: \`${c.request.name}\` in \`${c.request.file}\``);
    if (c.response) lines.push(`- Response type: \`${c.response.name}\` in \`${c.response.file}\``);
  } else if (c.kind === 'kafka') {
    lines.push(`- Topic: \`${c.topic}\` (schema: ${c.schemaRef || '_not specified_'})`);
  } else if (c.kind === 'grpc') {
    lines.push(`- Service: \`${c.service}\`, method: \`${c.method}\``);
  } else {
    lines.push(`- Table: \`${c.table}\` (${c.columns.length} column(s))`);
    for (const col of c.columns) {
      lines.push(`  - \`${col.name}\` \`${col.type}\`${col.nullable === false ? ' NOT NULL' : ''}${col.defaultValue ? ` DEFAULT ${col.defaultValue}` : ''}`);
    }
  }
  return lines.join('\n');
}

// ── Coverage helpers ─────────────────────────────────────────────────────

export function planCoversRepo(plan: Plan, repoName: string): boolean {
  const repo = plan.repos.find((r) => r.name === repoName);
  return !!(repo && repo.changes.trim().length > 0);
}

export function planCoversStagesForRepo(plan: Plan, repoName: string): {
  requirements: boolean; specs: boolean; tasks: boolean;
} {
  const covers = planCoversRepo(plan, repoName);
  return { requirements: covers, specs: covers, tasks: covers };
}

export function planCoversCrossRepo(plan: Plan): {
  requirements: boolean;
} {
  return {
    requirements:
      (plan.problem?.statement?.trim().length ?? 0) > 0 && plan.repos.length > 0,
  };
}

export function summarisePlanSkip(plan: Plan, repoNames: string[]): string {
  const coveredRepos = repoNames.filter((n) => planCoversRepo(plan, n));
  const skippedRepos = repoNames.filter((n) => !planCoversRepo(plan, n));
  return [
    `🎯 [plan-seed] Deriving artifacts from Plan v${plan.version} (${plan.slug}) — ${coveredRepos.length}/${repoNames.length} repos covered.`,
    coveredRepos.length ? `   Covered: ${coveredRepos.join(', ')}` : '',
    skippedRepos.length ? `   ⚠ Not in plan (will still run agents): ${skippedRepos.join(', ')}` : '',
  ].filter(Boolean).join('\n');
}

export { type PlanRepoImpact, type TestCaseSpec };
