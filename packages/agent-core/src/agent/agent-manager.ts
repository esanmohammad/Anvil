/**
 * Agent Process Manager — AgentManager facade.
 *
 * Composes spawn, stream-parser, output-buffer, timeout-guard,
 * restart-policy and stage-validator into a single runAgent() call.
 */

import { spawnAgent, type AgentProcess } from './spawn.js';
import { StreamParser } from './stream-parser.js';
import { OutputBuffer } from './output-buffer.js';
import { RestartPolicy } from './restart-policy.js';
import { TimeoutGuard } from './timeout-guard.js';
import { StageValidator } from './stage-validator.js';
import type {
  AgentProcessConfig,
  AgentResult,
  AgentEvent,
} from './types.js';

export type SpawnFn = (config: AgentProcessConfig) => AgentProcess;

export class AgentManager {
  private stageValidator = new StageValidator();
  private spawnFn: SpawnFn;

  constructor(spawnFn?: SpawnFn) {
    this.spawnFn = spawnFn ?? spawnAgent;
  }

  /**
   * Run an agent subprocess to completion, applying timeout, restart-policy
   * and output validation.
   */
  async runAgent(config: AgentProcessConfig): Promise<AgentResult> {
    const restartPolicy = new RestartPolicy(config.maxRestarts);
    const outputBuffer = new OutputBuffer();
    let lastExitCode: number | null = null;
    let finalState: AgentResult['status'] = 'idle' as AgentResult['status'];
    const startTime = Date.now();

    const attempt = async (): Promise<void> => {
      const parser = new StreamParser();
      const guard = new TimeoutGuard();
      const proc = this.spawnFn(config);
      let timedOut = false;

      return new Promise<void>((resolve) => {
        if (config.timeout > 0) {
          guard.start(
            config.timeout,
            () => {
              timedOut = true;
            },
            (signal) => proc.kill(signal),
          );
        }

        proc.events.on('event', (evt: AgentEvent) => {
          if (evt.type === 'output') {
            const parsed = parser.parse(evt.data);
            for (const e of parsed) {
              if (e.type === 'output') outputBuffer.append(e.data + '\n');
            }
          } else if (evt.type === 'error') {
            outputBuffer.append(evt.data);
          } else if (evt.type === 'exit') {
            guard.cancel();

            // Flush remaining parser buffer.
            for (const e of parser.flush()) {
              if (e.type === 'output') outputBuffer.append(e.data + '\n');
            }

            lastExitCode = evt.code;

            if (timedOut) {
              finalState = 'timed-out';
              resolve();
              return;
            }

            if (evt.code === 0) {
              finalState = 'completed';
              resolve();
              return;
            }

            // Crash — check restart policy.
            if (restartPolicy.shouldRestart(evt.code, evt.signal)) {
              restartPolicy.recordRestart();
              finalState = 'restarting';
              resolve();
              return;
            }

            finalState = 'failed';
            resolve();
          }
        });
      });
    };

    // Run (and potentially restart).
    await attempt();
    while (finalState === 'restarting') {
      await attempt();
    }

    const duration = Date.now() - startTime;
    const output = outputBuffer.getFullOutput();
    const validation = this.stageValidator.validateStageOutput(
      config.stage,
      output,
    );

    return {
      status: finalState,
      output,
      duration,
      tokenEstimate: outputBuffer.getTokenEstimate(),
      exitCode: lastExitCode,
      validation,
    };
  }
}
