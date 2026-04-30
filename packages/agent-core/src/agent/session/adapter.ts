/**
 * `AgentAdapter` — minimal adapter contract `AgentSession` consumes.
 *
 * Mirrors the public surface of dashboard's `BaseAdapter` (EventEmitter +
 * `start()` / `kill()` / `setMaxOutputTokens()`). Defining it in agent-core
 * lets both consumers wire their own adapters:
 *
 *   - Dashboard injects its existing `BaseAdapter`-derived adapters
 *     (claude / openai / etc.) which already satisfy this shape.
 *   - cli (Phase 5) injects a thin wrapper that drives agent-core's
 *     `LanguageModel.invokeStream()` and re-emits the same 5 events.
 *
 * The structural interface (vs a class) avoids forcing consumers to inherit
 * from agent-core just to plug in.
 */

import type { EventEmitter } from 'node:events';
import type { AgentActivity, CostInfo, SpawnConfig } from './types.js';

/**
 * The 5 events an adapter emits during a run. Same shape as dashboard's
 * `AdapterEvents` (and dashboard's `AgentProcessEvents`).
 */
export interface AgentAdapterEvents {
  content: (text: string) => void;
  activity: (activity: AgentActivity) => void;
  result: (data: { result: string; cost: CostInfo; sessionId: string }) => void;
  'error-output': (text: string) => void;
  exit: (code: number | null) => void;
}

/**
 * Public surface of an adapter `AgentSession` knows how to drive. We depend
 * structurally on `EventEmitter` so consumers can subclass `EventEmitter`
 * directly (the dashboard already does).
 */
export interface AgentAdapter extends EventEmitter {
  /** Begin running. May spawn a subprocess, open a stream, etc. */
  start(): void;
  /** Stop running and release resources. Idempotent. */
  kill(signal?: string): void;
  /** Optional output-token ceiling. Adapters that don't honor it ignore it. */
  setMaxOutputTokens?(n: number): void;
  readonly pid?: number;
  readonly killed?: boolean;
}

/**
 * Options forwarded to the adapter factory when `AgentSession` builds its
 * underlying adapter. Mirrors dashboard's `AgentProcessConfig` — a flattened
 * subset of `SpawnConfig` plus a `resume` flag.
 */
export interface AdapterRequest {
  prompt: string;
  model: string;
  sessionId: string;
  cwd: string;
  /** When true, the adapter resumes the prior session rather than starting fresh. */
  resume?: boolean;
  projectPrompt?: string;
  permissionMode?: string;
  disallowedTools?: string[];
  allowedTools?: string[];
  maxOutputTokens?: number;
}

/**
 * Factory the registry uses to construct adapters per spawn. Keeps the
 * adapter family out of agent-core's dependency graph.
 *
 * Consumers wire this once when constructing the registry:
 *
 *   const registry = new AgentSessionRegistry({
 *     adapterFactory: (req) => createAdapter(req),
 *   });
 */
export type AgentAdapterFactory = (req: AdapterRequest) => AgentAdapter;

/**
 * Convenience helper — constructs an `AdapterRequest` from a `SpawnConfig`
 * plus a generated session id.
 */
export function buildAdapterRequest(
  spec: SpawnConfig,
  sessionId: string,
  opts?: { resume?: boolean; cwdOverride?: string },
): AdapterRequest {
  return {
    prompt: spec.prompt,
    model: spec.model,
    sessionId,
    cwd: opts?.cwdOverride ?? spec.cwd,
    resume: opts?.resume,
    projectPrompt: spec.projectPrompt,
    permissionMode: spec.permissionMode,
    disallowedTools: spec.disallowedTools,
    allowedTools: spec.allowedTools,
    maxOutputTokens: spec.maxOutputTokens,
  };
}
