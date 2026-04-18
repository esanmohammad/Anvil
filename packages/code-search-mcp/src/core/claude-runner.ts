/**
 * Shared Claude CLI runner — same pattern as rag-evaluator.ts.
 *
 * Spawns the Claude CLI binary with `-p` for the short prompt and
 * `--system-prompt` for the long context. Parses `stream-json` output
 * for result + cost.
 *
 * Used by: repo-profiler (WS-1), service-mesh-inferrer (WS-2),
 * rag-evaluator, semantic-edge-detector.
 */

import { spawn } from 'node:child_process';

const CLAUDE_BIN = process.env.ANVIL_AGENT_CMD ?? process.env.FF_AGENT_CMD ?? process.env.CLAUDE_BIN ?? 'claude';

export interface ClaudeResult {
  result: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

/**
 * Run Claude CLI with short prompt via `-p` and long context via `--system-prompt`.
 * Uses `--output-format stream-json` and parses the result message.
 */
export async function runClaude(
  prompt: string,
  systemPrompt: string,
  opts?: { model?: string; timeoutMs?: number },
): Promise<ClaudeResult> {
  const model = opts?.model ?? 'claude-sonnet-4-6';
  const timeoutMs = opts?.timeoutMs ?? 600_000;

  return new Promise((resolve, reject) => {
    const args = [
      '-p', prompt,
      '--system-prompt', systemPrompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--model', model,
      '--permission-mode', 'bypassPermissions',
    ];

    const proc = spawn(CLAUDE_BIN, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    proc.stdin?.end();

    let buffer = '';
    let fullText = '';
    let resultData: ClaudeResult | null = null;

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`Claude CLI timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    proc.stdout?.on('data', (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed);

          // Collect text content
          if (msg.type === 'assistant' && msg.message?.content) {
            for (const block of msg.message.content) {
              if (block.type === 'text' && block.text) {
                fullText += block.text;
              }
            }
          }

          // Result message — has cost + usage
          if (msg.type === 'result') {
            resultData = {
              result: msg.result ?? fullText,
              costUsd: msg.total_cost_usd ?? 0,
              inputTokens: msg.usage?.input_tokens ?? 0,
              outputTokens: msg.usage?.output_tokens ?? 0,
              durationMs: msg.duration_ms ?? 0,
            };
          }
        } catch { /* skip unparseable lines */ }
      }
    });

    let stderr = '';
    proc.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });

    proc.on('error', (err) => { clearTimeout(timer); reject(err); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (resultData) {
        resolve(resultData);
      } else if (code === 0 && fullText) {
        resolve({ result: fullText, costUsd: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 });
      } else {
        reject(new Error(`claude exited with code ${code}: ${stderr.slice(0, 500)}`));
      }
    });
  });
}
