/**
 * @anvil/agent-core/headless — public `runAgent` entry point.
 *
 * Inspect-AI-compatible trajectory shape (ADR §6) lets external eval
 * harnesses ingest Anvil runs without conversion.
 */

export { runAgent } from './runner.js';
export type {
  AgentTask,
  AgentTrajectory,
  WorkspaceConfig,
  TrajectoryMessage,
  TrajectoryToolCall,
  TrajectoryUsage,
  RunAgentOptions,
  BuiltInToolDispatcher,
} from './types.js';
