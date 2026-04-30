/**
 * Backwards-compat re-export shim. The real types now live in
 * `@anvil/agent-core/agent/session`. Phase 6 of the agent-manager
 * consolidation deletes this file once direct imports flip everywhere.
 *
 * Note: the standalone `AgentProcess` class is gone — its lifecycle role
 * folded into `AgentSession`'s constructor + private wiring (ADR D4). No
 * dashboard call site constructs `AgentProcess` directly today.
 */

export type {
  AgentActivity,
  CostInfo,
} from '@anvil/agent-core';

// Local-only legacy type — agent-core's `SessionSpec` is the canonical
// shape, and dashboard call sites that historically used
// `AgentProcessConfig` are now via `SessionSpec`.
export type AgentProcessConfig = {
  prompt: string;
  model: string;
  sessionId: string;
  cwd: string;
  resume?: boolean;
  projectPrompt?: string;
  permissionMode?: string;
  disallowedTools?: string[];
  allowedTools?: string[];
  maxOutputTokens?: number;
};
