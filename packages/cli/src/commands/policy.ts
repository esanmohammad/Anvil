/**
 * `anvil-loc policy` — manage the declarative pipeline policy file for a
 * project. Subcommands: init, validate, show. Mirrors the project-resolution
 * pattern used by `incidents.ts` and the type-duplication pattern used by
 * `incident-stats-formatter.ts` (CLI does not import from the dashboard
 * package at runtime — see that file's header for the rationale).
 */

import { Command } from 'commander';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import pc from 'picocolors';
import YAML from 'yaml';

import { info, success, error } from '../logger.js';
import { getAnvilHome } from '../home.js';

// ── Types (duplicated from pipeline-policy-types.ts) ─────────────────────

type PipelineStage = 'plan' | 'implement' | 'review' | 'test' | 'ship';

interface PipelinePolicy {
  version: string;
  defaults: {
    pauseAfter?: PipelineStage[];
    autoApproveIfRisk?: 'low' | 'med';
    autoApproveIfConfidence?: number;
  };
  paths: Array<{
    match: string;
    pauseAfter?: PipelineStage[];
    autoApprove?: boolean;
    reviewers?: string[];
  }>;
  cost?: {
    limits?: { perRun?: number; perProjectDaily?: number; perStage?: Partial<Record<PipelineStage, number>> };
    graceWindowSeconds?: number;
    onBreach?: 'ask' | 'auto-approve' | 'auto-reject';
    autoApproveBelow?: number;
  };
  notifications?: { slack?: boolean; email?: boolean; timeoutHours?: number };
  reviewers?: Array<{ match: string; users: string[] }>;
}

const POLICY_SCHEMA_VERSION = '1.0.0';

// ── Project resolution (mirrors incidents.ts) ────────────────────────────

function readProjectField(path: string): string | null {
  try {
    const raw = readFileSync(path, 'utf-8');
    const m = raw.match(/^\s*project:\s*["']?([^"'\r\n#]+)["']?\s*$/m);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

function resolveProjectSlug(explicit?: string): string {
  if (explicit) return explicit;
  const cwd = process.cwd();
  const yamlCandidates = [
    join(cwd, 'factory.yaml'),
    join(cwd, 'anvil.yaml'),
    join(cwd, '.factory', 'config.yaml'),
    join(cwd, '.anvil', 'config.yaml'),
  ];
  for (const path of yamlCandidates) {
    if (!existsSync(path)) continue;
    const name = readProjectField(path);
    if (name) return name;
  }
  // Plain-text .anvil/project marker
  const marker = join(cwd, '.anvil', 'project');
  if (existsSync(marker)) {
    const raw = readFileSync(marker, 'utf-8').trim();
    if (raw) return raw;
  }
  error('No project specified and no factory.yaml/anvil.yaml in the current directory.');
  error('Pass --project <name> or run `anvil init`.');
  process.exit(1);
}

function policyPath(slug: string): string {
  return join(getAnvilHome(), 'projects', slug, 'pipeline-policy.yaml');
}

// ── Sample YAML (kept in sync with dashboard/server/pipeline-policy.ts) ──

function samplePolicyYaml(): string {
  return `# Anvil pipeline policy — declarative rules for when the pipeline pauses,
# who reviews, and cost limits. See docs for the full schema.
version: ${POLICY_SCHEMA_VERSION}

defaults:
  # Stages after which Anvil should ask for confirmation by default.
  pauseAfter: [plan]
  # Skip the default pause when the change is low-risk.
  autoApproveIfRisk: low
  # Skip the default pause when agent confidence is at or above this threshold.
  autoApproveIfConfidence: 0.9

# Per-path overrides — the FIRST matching rule wins.
paths:
  - match: "**/auth/**"
    pauseAfter: [plan, implement, review]
    reviewers: [security-team]
  - match: "**/*.md"
    autoApprove: true
  - match: "src/migrations/**"
    pauseAfter: [plan, ship]
    reviewers: [db-owners]

cost:
  limits:
    perRun: 5.00
    perProjectDaily: 50.00
    perStage:
      implement: 2.50
      test: 1.00
  graceWindowSeconds: 30
  onBreach: ask
  autoApproveBelow: 0.25

notifications:
  slack: true
  email: false
  timeoutHours: 4

# Reviewers picked up in addition to any matching path rule.
reviewers:
  - match: "packages/billing/**"
    users: [billing-team, finance-leads]
`;
}

// ── Load policy (uses the full `yaml` package — CLI is not size-constrained) ──

function loadPolicyFromPath(path: string): PipelinePolicy {
  const raw = readFileSync(path, 'utf-8');
  const parsed = YAML.parse(raw) as unknown;
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Policy root must be a mapping.');
  }
  // Trust the YAML to carry the right shape; the dashboard-side loader does
  // proper schema enforcement at runtime.
  return parsed as PipelinePolicy;
}

// ── Subcommand: init ─────────────────────────────────────────────────────

const initCmd = new Command('init')
  .description('Write a starter pipeline-policy.yaml for the current project')
  .option('--project <name>', 'Project slug')
  .option('--force', 'Overwrite an existing policy file', false)
  .action((opts: { project?: string; force?: boolean }) => {
    const slug = resolveProjectSlug(opts.project);
    const target = policyPath(slug);
    if (existsSync(target) && !opts.force) {
      error(`Policy already exists at ${target} — pass --force to overwrite.`);
      process.exitCode = 1;
      return;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, samplePolicyYaml(), 'utf-8');
    success(`Wrote ${pc.bold(target)}`);
  });

// ── Subcommand: validate ─────────────────────────────────────────────────

const validateCmd = new Command('validate')
  .description('Parse the pipeline-policy.yaml and report any errors')
  .option('--project <name>', 'Project slug')
  .action((opts: { project?: string }) => {
    const slug = resolveProjectSlug(opts.project);
    const path = policyPath(slug);
    if (!existsSync(path)) {
      error(`No policy file at ${path} — run \`anvil policy init\`.`);
      process.exitCode = 1;
      return;
    }
    try {
      const policy = loadPolicyFromPath(path);
      success(`Policy for ${pc.bold(slug)} is valid (schema ${policy.version || '?'}).`);
    } catch (err) {
      error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

// ── Subcommand: show ─────────────────────────────────────────────────────

function printPolicy(slug: string, policy: PipelinePolicy): void {
  console.log(pc.bold(`Policy for ${slug}`));
  console.log(`  version: ${policy.version}`);
  console.log('');
  console.log(pc.bold('defaults'));
  const d = policy.defaults ?? {};
  console.log(`  pauseAfter:              ${d.pauseAfter?.join(', ') || pc.dim('(none)')}`);
  console.log(`  autoApproveIfRisk:       ${d.autoApproveIfRisk || pc.dim('(unset)')}`);
  console.log(`  autoApproveIfConfidence: ${d.autoApproveIfConfidence ?? pc.dim('(unset)')}`);
  console.log('');
  console.log(pc.bold('paths'));
  const paths = policy.paths ?? [];
  if (paths.length === 0) {
    console.log(`  ${pc.dim('(none)')}`);
  } else {
    for (const p of paths) {
      console.log(`  - ${pc.cyan(p.match)}`);
      if (p.pauseAfter?.length) console.log(`      pauseAfter:  ${p.pauseAfter.join(', ')}`);
      if (p.autoApprove) console.log(`      autoApprove: ${p.autoApprove}`);
      if (p.reviewers?.length) console.log(`      reviewers:   ${p.reviewers.join(', ')}`);
    }
  }
  if (policy.cost) {
    console.log('');
    console.log(pc.bold('cost'));
    const c = policy.cost;
    if (c.limits?.perRun != null) console.log(`  perRun:           $${c.limits.perRun}`);
    if (c.limits?.perProjectDaily != null) console.log(`  perProjectDaily:  $${c.limits.perProjectDaily}`);
    if (c.graceWindowSeconds != null) console.log(`  graceWindowSecs:  ${c.graceWindowSeconds}`);
    if (c.onBreach) console.log(`  onBreach:         ${c.onBreach}`);
    if (c.autoApproveBelow != null) console.log(`  autoApproveBelow: $${c.autoApproveBelow}`);
  }
  if (policy.reviewers?.length) {
    console.log('');
    console.log(pc.bold('reviewers'));
    for (const r of policy.reviewers) {
      console.log(`  - ${pc.cyan(r.match)} → ${r.users.join(', ')}`);
    }
  }
}

const showCmd = new Command('show')
  .description('Pretty-print the resolved pipeline policy')
  .option('--project <name>', 'Project slug')
  .action((opts: { project?: string }) => {
    const slug = resolveProjectSlug(opts.project);
    const path = policyPath(slug);
    if (!existsSync(path)) {
      info(`No policy file at ${path} — run \`anvil policy init\`.`);
      return;
    }
    try {
      const policy = loadPolicyFromPath(path);
      printPolicy(slug, policy);
    } catch (err) {
      error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

// ── Command group ────────────────────────────────────────────────────────

export const policyCommand = new Command('policy')
  .description('Manage the declarative pipeline policy for a project')
  .addCommand(initCmd)
  .addCommand(validateCmd)
  .addCommand(showCmd);
