/**
 * Plan type vocabulary — the typed contract between the dashboard's
 * /plan flow and the pipeline.
 *
 * Phase F7 — types-only promotion from
 * `packages/dashboard/server/plan-store.ts` into `core-pipeline/utils`.
 * The PlanStore CLASS (FS-backed `~/.anvil/plans/` storage) STAYS in
 * dashboard — only the data shapes lift here so cli + dashboard +
 * pipeline-stage code share one canonical Plan vocabulary.
 *
 * Pure data; zero runtime side effects.
 */

export type RiskSeverity = 'low' | 'med' | 'high';
export type ContractKind = 'http' | 'grpc' | 'kafka' | 'db' | 'other';

export interface PlanRepoImpact {
  name: string;
  changes: string;
  files: string[];
  symbols: string[];
}

export interface PlanContract {
  kind: ContractKind;
  name: string;
  producer: string;
  consumers: string[];
  description: string;
}

export interface PlanRisk {
  title: string;
  mitigation: string;
  severity: RiskSeverity;
}

export interface PlanRollout {
  strategy: string;
  flags: string[];
  order: string[];
  rollback: string;
}

export interface PlanTests {
  unit: string[];
  integration: string[];
  manual: string[];
}

export interface PlanEstimate {
  usd: number;
  minutes: number;
  prs: number;
}

export interface Plan {
  version: number;
  slug: string;
  project: string;
  title: string;
  problem: string;
  scope: { inScope: string[]; outOfScope: string[] };
  repos: PlanRepoImpact[];
  contracts: PlanContract[];
  architecture: { mermaid: string; notes: string };
  risks: PlanRisk[];
  rollout: PlanRollout;
  tests: PlanTests;
  estimate: PlanEstimate;
  model: string;
  /** Original feature description. */
  feature: string;
  createdAt: string;
  updatedAt: string;
}

export interface PlanPointer {
  slug: string;
  title: string;
  currentVersion: number;
  updatedAt: string;
}

export type PlanSection =
  | 'problem' | 'scope' | 'repos' | 'contracts' | 'architecture'
  | 'risks' | 'rollout' | 'tests' | 'estimate';

export interface PlanComment {
  /** `c-${Date.now().toString(36)}-${randHex}` */
  id: string;
  /** e.g. "problem", "repos[2].files", "risks[0]" */
  sectionPath: string;
  /** From `ANVIL_USER_NAME` env or 'anonymous'. */
  author: string;
  body: string;
  /** ISO. */
  createdAt: string;
  resolved: boolean;
}

export interface PlanApproval {
  id: string;
  user: string;
  approvedVersion: number;
  approvedAt: string;
  note?: string;
}
