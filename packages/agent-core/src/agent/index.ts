/**
 * `@anvil/agent-core/agent` — barrel exports for the agent-lifecycle layer.
 *
 * The pre-existing single-shot `AgentManager` class and its supporting
 * subprocess machinery (spawn, stream-parser, output-buffer, restart-policy,
 * timeout-guard, stage-validator) lived alongside the new `AgentSession` /
 * `AgentSessionRegistry` surface for one release. Both had zero production
 * consumers — the cli-style runner was a dead extract leftover. The post-
 * Phase 4/5 cleanup (Deferred #1) deletes them.
 *
 * The canonical agent-lifecycle surface lives under `./session/`.
 */

export * from './session/index.js';
