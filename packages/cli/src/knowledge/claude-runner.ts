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

import { spawn, ChildProcess } from 'node:child_process';

const CLAUDE_BIN = process.env.ANVIL_AGENT_CMD ?? process.env.FF_AGENT_CMD ?? process.env.CLAUDE_BIN ?? 'claude';
const GEMINI_BIN = process.env.GEMINI_BIN ?? 'gemini';

// Track active child processes for cleanup on exit
const activeProcesses = new Set<ChildProcess>();

function trackProcess(proc: ChildProcess): void {
  activeProcesses.add(proc);
  proc.on('exit', () => activeProcesses.delete(proc));
}

// Kill all tracked processes on SIGINT/SIGTERM
function killAllTracked() {
  for (const proc of activeProcesses) {
    try { proc.kill('SIGTERM'); } catch { /* already dead */ }
  }
  activeProcesses.clear();
}
process.on('SIGINT', killAllTracked);
process.on('SIGTERM', killAllTracked);

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
    trackProcess(proc);

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

// ── Multi-provider support ────────────────────────────────────────────────

export interface LLMRunOptions {
  model?: string;
  timeoutMs?: number;
  provider?: 'claude' | 'gemini';  // default: 'claude'
}

/**
 * Run an LLM CLI with provider selection.
 * Defaults to Claude. Pass `provider: 'gemini'` to use the Gemini CLI instead.
 */
export async function runLLM(
  prompt: string,
  systemPrompt: string,
  opts?: LLMRunOptions,
): Promise<ClaudeResult> {
  const provider = opts?.provider ?? 'claude';

  if (provider === 'gemini') {
    return runGemini(prompt, systemPrompt, opts);
  }
  return runClaude(prompt, systemPrompt, opts);
}

/**
 * Run Gemini CLI with `-p` for the prompt.
 * Attempts to parse JSON output; falls back to plain text.
 */
export async function runGemini(
  prompt: string,
  systemPrompt: string,
  opts?: { model?: string; timeoutMs?: number },
): Promise<ClaudeResult> {
  const model = opts?.model ?? 'gemini-2.5-pro';
  const timeoutMs = opts?.timeoutMs ?? 600_000;

  // Combine system prompt and user prompt since Gemini CLI
  // does not have a separate --system-prompt flag.
  const combinedPrompt = systemPrompt
    ? `${systemPrompt}\n\n---\n\n${prompt}`
    : prompt;

  return new Promise((resolve, reject) => {
    const args = [
      '-p', combinedPrompt,
      '--model', model,
    ];

    const start = Date.now();

    const proc = spawn(GEMINI_BIN, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    trackProcess(proc);

    proc.stdin?.end();

    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`Gemini CLI timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    proc.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
    proc.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });

    proc.on('error', (err) => { clearTimeout(timer); reject(err); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - start;

      if (code !== 0 && !stdout.trim()) {
        reject(new Error(`gemini exited with code ${code}: ${stderr.slice(0, 500)}`));
        return;
      }

      // Try JSON parse first (Gemini may output structured JSON)
      let result = stdout.trim();
      let costUsd = 0;
      let inputTokens = 0;
      let outputTokens = 0;

      try {
        const parsed = JSON.parse(result);
        if (parsed.result) result = parsed.result;
        if (parsed.total_cost_usd) costUsd = parsed.total_cost_usd;
        if (parsed.usage?.input_tokens) inputTokens = parsed.usage.input_tokens;
        if (parsed.usage?.output_tokens) outputTokens = parsed.usage.output_tokens;
      } catch {
        // Plain text output — use as-is
      }

      resolve({ result, costUsd, inputTokens, outputTokens, durationMs });
    });
  });
}
