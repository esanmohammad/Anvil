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
