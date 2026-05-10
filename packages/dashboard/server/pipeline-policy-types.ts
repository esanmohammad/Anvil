/**
 * Types for Anvil's declarative pipeline policy — Phase 2 of the confidence
 * gated pipeline. Describes per-project pause rules, cost limits, and reviewers.
 */

export type PipelineStage = 'plan' | 'implement' | 'review' | 'test' | 'ship';

export type PauseMode = 'always' | 'never' | 'high-risk' | `confidence<${number}`;

export interface PathRule {
  match: string;              // glob pattern
  pauseAfter?: PipelineStage[];
  autoApprove?: boolean;
  reviewers?: string[];       // usernames/group tags
}

export interface CostLimits {
  perRun?: number;            // USD
  perProjectDaily?: number;
  perStage?: Partial<Record<PipelineStage, number>>;
}

export interface NotificationConfig {
  slack?: boolean;
  email?: boolean;
  timeoutHours?: number;      // auto-action after no response
}

export interface CostPolicy {
  limits?: CostLimits;
  graceWindowSeconds?: number;         // keep agents running while asking
  onBreach?: 'ask' | 'auto-approve' | 'auto-reject';
  autoApproveBelow?: number;           // USD delta that never asks
  /** Per-tool budget caps (Phase H — browser/web tools). */
  tools?: ToolCostLimits;
}

export interface ToolCostLimits {
  /** Hard cap on tool spend per run (USD). */
  perRunUsd?: number;
  /** Per-stage cap (USD). */
  perStageUsd?: number;
  /** Ceiling per single tool invocation (USD). */
  perToolPerCallUsd?: number;
}

/**
 * Browser/web tool surface policy. Each block opts a stage into the
 * matching permission class (network / browseHeadless / browseEval /
 * browsePixel) on top of the built-in stage defaults in core-pipeline's
 * `STAGE_WEB_PERMISSIONS`. Empty/absent block = use built-in defaults.
 */
export interface ToolsPolicy {
  network?: WebToolBlock;
  browseHeadless?: WebToolBlock;
  browseEval?: WebToolBlock;
  browsePixel?: WebToolBlock;
}

export interface WebToolBlock {
  /** Master switch — set false to disable this class for the project. */
  enabled?: boolean;
  /** Override the per-stage allow-list (replaces built-in defaults). */
  stages?: string[];
  /** Glob patterns of allowed domains (e.g. "*.docs.example.com"). */
  allowedDomains?: string[];
  /** Glob patterns of always-blocked domains. */
  blockedDomains?: string[];
  /** Named contexts (e.g. authenticated docs portal cookie jars). */
  contexts?: string[];
}

export interface PolicyDefaults {
  pauseAfter?: PipelineStage[];
  autoApproveIfRisk?: 'low' | 'med';
  autoApproveIfConfidence?: number;    // 0..1
}

export interface AgentQuestionPolicy {
  /** Master toggle for Q&A across planning stages. Default true. */
  enabled?: boolean;
  /** Hard cap on how many questions an agent may ask per stage. Default 5. */
  maxQuestionsPerStage?: number;
}

export interface PipelinePolicy {
  version: string;            // schema version
  /** Master switch for review pauses. Default true. When false, no pause ever fires. */
  enabled?: boolean;
  defaults: PolicyDefaults;
  paths: PathRule[];
  cost?: CostPolicy;
  notifications?: NotificationConfig;
  reviewers?: Array<{ match: string; users: string[] }>;
  /** Agent Q&A controls — applies to clarify/requirements/repo-requirements/specs stages. */
  qa?: AgentQuestionPolicy;
  /** Browser/web tool gating overlay (Phase H). */
  tools?: ToolsPolicy;
  /** Sandbox isolation overlay (Phase S — see docs/sandbox-isolation-plan.md §F). */
  sandbox?: SandboxPolicy;
}

/**
 * Sandbox isolation policy — overlay on top of core-pipeline's
 * `STAGE_SANDBOX_POLICY` table. Set `default.runtime` to globally pin
 * a runtime; set `perStage[<stage>]` to override the canonical entry
 * for one stage; set `network.allowList`/`blockList` to scope egress.
 */
export interface SandboxPolicy {
  /** Sandbox-wide defaults applied to every stage's resolved entry. */
  default?: SandboxDefaultBlock;
  /** Per-stage overrides keyed by stage name (e.g. "build", "ship"). */
  perStage?: Record<string, SandboxStageOverrideBlock>;
  /** Project-wide network policy layered under the per-stage policy. */
  network?: SandboxNetworkBlock;
  /** Cost / quota controls (sum across all sandboxes per run). */
  limits?: SandboxBudgetLimits;
}

export interface SandboxDefaultBlock {
  /** Concrete runtime to vend by default. */
  runtime?: 'none' | 'docker' | 'podman' | 'firecracker' | 'gvisor';
  /** Default resource limits applied per stage. */
  limits?: SandboxResourceLimits;
}

export interface SandboxStageOverrideBlock {
  /** Override the per-stage runtime mode. */
  mode?: 'none' | 'container' | 'microVM';
  /** Override the runtime backing the mode. */
  runtime?: 'none' | 'docker' | 'podman' | 'firecracker' | 'gvisor';
  /** Override the filesystem propagation mode. */
  fsMode?: 'overlay' | 'bind' | 'none';
  /** Override the resource limits. */
  limits?: SandboxResourceLimits;
  /** Per-stage network policy. Overrides project + table defaults. */
  network?: SandboxNetworkBlock;
}

export interface SandboxResourceLimits {
  memoryMiB?: number;
  cpus?: number;
  timeoutSeconds?: number;
  pids?: number;
  diskMiB?: number;
}

export interface SandboxNetworkBlock {
  default?: 'deny' | 'allow';
  allowList?: string[];
  blockList?: string[];
  allowLoopback?: boolean;
  dnsResolver?: string;
}

export interface SandboxBudgetLimits {
  /** Hard cap on summed exec wall time per run (seconds). */
  perRunWallSeconds?: number;
  /** Per-stage cap (seconds) — overrides §F default when stricter. */
  perStageWallSeconds?: number;
  /** Sum across all sandboxes for the run (MiB). */
  totalDiskMiB?: number;
}

export interface PolicyEvaluationInput {
  stage: PipelineStage;
  touchedFiles: string[];
  riskTier?: 'low' | 'med' | 'high';
  confidence?: number;        // 0..1
}

export interface PolicyDecision {
  pause: boolean;
  reason: string;
  matchedRules: string[];     // globs / "defaults" that triggered
  reviewers: string[];
}

export const POLICY_SCHEMA_VERSION = '1.0.0';
