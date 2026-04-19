/**
 * LLM runner — supports CLI (claude binary) and API (HTTP) modes.
 *
 * Mode is controlled by CODE_SEARCH_LLM_MODE:
 *   - 'cli'  (default) — spawns claude binary, requires claude CLI installed + auth
 *   - 'api'  — direct HTTP calls to Anthropic/OpenAI/custom, requires API key
 *   - 'none' — skips all LLM inference (profiling + service mesh disabled)
 *
 * Used by: repo-profiler, service-mesh-inferrer, rag-evaluator.
 */

import { spawn } from 'node:child_process';
import { loadServerConfig } from './env-config.js';

export interface ClaudeResult {
  result: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

/**
 * Run an LLM inference call. Routes to CLI or API based on config.
 * Throws if mode is 'none'.
 */
export async function runClaude(
  prompt: string,
  systemPrompt: string,
  opts?: { model?: string; timeoutMs?: number },
): Promise<ClaudeResult> {
  const config = loadServerConfig();

  if (config.llmMode === 'none') {
    throw new Error('LLM inference disabled (CODE_SEARCH_LLM_MODE=none)');
  }

  const model = opts?.model ?? config.llmModel;
  const timeoutMs = opts?.timeoutMs ?? 600_000;

  if (config.llmMode === 'api') {
    return runViaApi(prompt, systemPrompt, model, timeoutMs, config);
  }

  return runViaCli(prompt, systemPrompt, model, timeoutMs, config.claudeBin);
}

/**
 * Check if LLM inference is available.
 */
export function isLlmAvailable(): boolean {
  const config = loadServerConfig();
  return config.llmMode !== 'none';
}

// ---------------------------------------------------------------------------
// CLI mode — spawns claude binary
// ---------------------------------------------------------------------------

function runViaCli(
  prompt: string,
  systemPrompt: string,
  model: string,
  timeoutMs: number,
  claudeBin: string,
): Promise<ClaudeResult> {
  return new Promise((resolve, reject) => {
    const args = [
      '-p', prompt,
      '--system-prompt', systemPrompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--model', model,
      '--permission-mode', 'bypassPermissions',
    ];

    const proc = spawn(claudeBin, args, {
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

          if (msg.type === 'assistant' && msg.message?.content) {
            for (const block of msg.message.content) {
              if (block.type === 'text' && block.text) {
                fullText += block.text;
              }
            }
          }

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

// ---------------------------------------------------------------------------
// API mode — direct HTTP calls (Anthropic, OpenAI-compatible)
// ---------------------------------------------------------------------------

interface ApiConfig {
  llmProvider: string;
  llmApiKey: string | undefined;
  llmBaseUrl: string | undefined;
}

async function runViaApi(
  prompt: string,
  systemPrompt: string,
  model: string,
  timeoutMs: number,
  config: ApiConfig,
): Promise<ClaudeResult> {
  const startTime = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const isAnthropic = config.llmProvider === 'anthropic';
    const url = isAnthropic
      ? 'https://api.anthropic.com/v1/messages'
      : `${config.llmBaseUrl ?? 'https://api.openai.com'}/v1/chat/completions`;

    if (!config.llmApiKey) {
      throw new Error(
        `CODE_SEARCH_LLM_API_KEY not set. Required for LLM_MODE=api. ` +
        `Set it to your ${config.llmProvider} API key, or use LLM_MODE=cli for Claude CLI, or LLM_MODE=none to disable.`
      );
    }

    let body: string;
    let headers: Record<string, string>;

    if (isAnthropic) {
      headers = {
        'Content-Type': 'application/json',
        'x-api-key': config.llmApiKey,
        'anthropic-version': '2023-06-01',
      };
      body = JSON.stringify({
        model,
        max_tokens: 8192,
        system: [{ type: 'text', text: systemPrompt }],
        messages: [{ role: 'user', content: prompt }],
      });
    } else {
      headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.llmApiKey}`,
      };
      body = JSON.stringify({
        model,
        max_tokens: 8192,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
      });
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      throw new Error(`LLM API error ${response.status}: ${errBody.slice(0, 500)}`);
    }

    const json = await response.json() as any;
    const durationMs = Date.now() - startTime;

    if (isAnthropic) {
      // Concatenate all text blocks (model may return multiple)
      const text = (json.content as Array<{ type: string; text?: string }> ?? [])
        .filter((b: any) => b.type === 'text' && b.text)
        .map((b: any) => b.text)
        .join('');
      return {
        result: text,
        costUsd: 0,
        inputTokens: json.usage?.input_tokens ?? 0,
        outputTokens: json.usage?.output_tokens ?? 0,
        durationMs,
      };
    } else {
      const text = json.choices?.[0]?.message?.content ?? '';
      return {
        result: text,
        costUsd: 0,
        inputTokens: json.usage?.prompt_tokens ?? 0,
        outputTokens: json.usage?.completion_tokens ?? 0,
        durationMs,
      };
    }
  } finally {
    clearTimeout(timer);
  }
}
