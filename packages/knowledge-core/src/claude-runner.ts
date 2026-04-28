/**
 * LLM runner — supports CLI (claude/gemini binaries) and API (HTTP) modes.
 *
 * Mode is controlled by CODE_SEARCH_LLM_MODE:
 *   - 'cli'  (default) — spawns claude / gemini binary
 *   - 'api'  — direct HTTP calls to Anthropic or OpenAI-compatible endpoints
 *   - 'none' — skips LLM inference entirely (profiling + service mesh disabled)
 *
 * Auto-detection (when the env var is unset):
 *   1. CODE_SEARCH_LLM_API_KEY or ANTHROPIC_API_KEY present → 'api'
 *   2. claude binary resolvable on PATH                     → 'cli'
 *   3. otherwise                                            → 'none'
 *
 * Used by: repo-profiler, service-mesh-inferrer, rag-evaluator.
 *
 * ── Merge note ──────────────────────────────────────────────────────────
 *
 * cli's pre-merge runner spawned binaries only and tracked active children
 * for SIGINT/SIGTERM cleanup. mcp's pre-merge runner added an HTTP transport
 * but dropped the process-tracking and pulled config from a server-side
 * `env-config.ts` module that doesn't exist in cli. The shared version takes
 * mcp's transport-mode dispatch + adds back cli's process tracking + reads
 * env vars directly so there's no dependency on `env-config.ts`.
 */

import { spawn, execSync, ChildProcess } from 'node:child_process';

// ── Config ─────────────────────────────────────────────────────────────────

interface LlmConfig {
  llmMode: 'cli' | 'api' | 'none';
  llmProvider: string;       // 'anthropic' | 'openai' | 'custom'
  llmModel: string;
  llmApiKey: string | undefined;
  llmBaseUrl: string | undefined;
  claudeBin: string;
  geminiBin: string;
}

let _cachedConfig: LlmConfig | null = null;

function resolveLlmMode(
  explicit: string | undefined,
  apiKey: string | undefined,
  claudeBin: string,
): LlmConfig['llmMode'] {
  if (explicit === 'cli' || explicit === 'api' || explicit === 'none') {
    if (explicit === 'api' && !apiKey) {
      process.stderr.write(
        '[claude-runner] WARNING: LLM_MODE=api but no API key found. ' +
        'Set CODE_SEARCH_LLM_API_KEY or ANTHROPIC_API_KEY. Falling back to LLM_MODE=none.\n',
      );
      return 'none';
    }
    return explicit;
  }
  if (apiKey) return 'api';
  try {
    execSync(`which ${claudeBin}`, { stdio: 'pipe', timeout: 3000 });
    return 'cli';
  } catch {
    return 'none';
  }
}

function loadLlmConfig(): LlmConfig {
  if (_cachedConfig) return _cachedConfig;
  const env = (k: string): string | undefined => process.env[`CODE_SEARCH_${k}`];
  const apiKey = env('LLM_API_KEY') ?? process.env.ANTHROPIC_API_KEY;
  const claudeBin =
    process.env.ANVIL_AGENT_CMD ??
    process.env.FF_AGENT_CMD ??
    env('CLAUDE_BIN') ??
    process.env.CLAUDE_BIN ??
    'claude';
  _cachedConfig = {
    llmMode: resolveLlmMode(env('LLM_MODE'), apiKey, claudeBin),
    llmProvider: env('LLM_PROVIDER') ?? 'anthropic',
    llmModel: env('LLM_MODEL') ?? 'sonnet',
    llmApiKey: apiKey,
    llmBaseUrl: env('LLM_BASE_URL'),
    claudeBin,
    geminiBin: process.env.GEMINI_BIN ?? 'gemini',
  };
  return _cachedConfig;
}

/** Test seam — reset cached config (call between tests that override env). */
export function resetLlmConfig(): void {
  _cachedConfig = null;
}

/** Report whether any LLM transport is currently usable. */
export function isLlmAvailable(): boolean {
  return loadLlmConfig().llmMode !== 'none';
}

// ── Process tracking (preserved from cli — robust SIGINT/SIGTERM cleanup) ──

const activeProcesses = new Set<ChildProcess>();

function trackProcess(proc: ChildProcess): void {
  activeProcesses.add(proc);
  proc.on('exit', () => activeProcesses.delete(proc));
}

function killAllTracked() {
  for (const proc of activeProcesses) {
    try { proc.kill('SIGTERM'); } catch { /* already dead */ }
  }
  activeProcesses.clear();
}
process.on('SIGINT', killAllTracked);
process.on('SIGTERM', killAllTracked);

// ── Public API ─────────────────────────────────────────────────────────────

export interface ClaudeResult {
  result: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

export interface LLMRunOptions {
  model?: string;
  timeoutMs?: number;
  provider?: 'claude' | 'gemini';  // default: 'claude'
}

/** Run Claude — dispatches to CLI or API based on `CODE_SEARCH_LLM_MODE`. */
export async function runClaude(
  prompt: string,
  systemPrompt: string,
  opts?: { model?: string; timeoutMs?: number },
): Promise<ClaudeResult> {
  const config = loadLlmConfig();
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

/** Run Gemini CLI — CLI mode only (no Gemini API integration today). */
export async function runGemini(
  prompt: string,
  systemPrompt: string,
  opts?: { model?: string; timeoutMs?: number },
): Promise<ClaudeResult> {
  const config = loadLlmConfig();
  if (config.llmMode === 'none') {
    throw new Error('LLM inference disabled (CODE_SEARCH_LLM_MODE=none)');
  }
  const model = opts?.model ?? 'gemini-2.5-pro';
  const timeoutMs = opts?.timeoutMs ?? 600_000;

  // Combine — Gemini CLI has no separate --system-prompt flag.
  const combinedPrompt = systemPrompt
    ? `${systemPrompt}\n\n---\n\n${prompt}`
    : prompt;

  return new Promise((resolve, reject) => {
    const args = ['-p', combinedPrompt, '--model', model];
    const start = Date.now();
    const proc = spawn(config.geminiBin, args, {
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
      } catch { /* plain text */ }
      resolve({ result, costUsd, inputTokens, outputTokens, durationMs });
    });
  });
}

/** Provider-aware facade — defaults to Claude. */
export async function runLLM(
  prompt: string,
  systemPrompt: string,
  opts?: LLMRunOptions,
): Promise<ClaudeResult> {
  const provider = opts?.provider ?? 'claude';
  if (provider === 'gemini') return runGemini(prompt, systemPrompt, opts);
  return runClaude(prompt, systemPrompt, opts);
}

// ── CLI transport ─────────────────────────────────────────────────────────

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
          if (msg.type === 'assistant' && msg.message?.content) {
            for (const block of msg.message.content) {
              if (block.type === 'text' && block.text) fullText += block.text;
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
        } catch { /* skip unparseable */ }
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

// ── API transport ─────────────────────────────────────────────────────────

async function runViaApi(
  prompt: string,
  systemPrompt: string,
  model: string,
  timeoutMs: number,
  config: LlmConfig,
): Promise<ClaudeResult> {
  if (!config.llmApiKey) {
    throw new Error(
      'CODE_SEARCH_LLM_API_KEY not set. Required for LLM_MODE=api. ' +
      `Set it to your ${config.llmProvider} API key, or use LLM_MODE=cli, or LLM_MODE=none.`,
    );
  }
  const startTime = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const isAnthropic = config.llmProvider === 'anthropic';
    const url = isAnthropic
      ? 'https://api.anthropic.com/v1/messages'
      : `${config.llmBaseUrl ?? 'https://api.openai.com'}/v1/chat/completions`;

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

    const response = await fetch(url, { method: 'POST', headers, body, signal: controller.signal });
    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      throw new Error(`LLM API error ${response.status}: ${errBody.slice(0, 500)}`);
    }
    const json = await response.json() as any;
    const durationMs = Date.now() - startTime;

    if (isAnthropic) {
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
    }
    const text = json.choices?.[0]?.message?.content ?? '';
    return {
      result: text,
      costUsd: 0,
      inputTokens: json.usage?.prompt_tokens ?? 0,
      outputTokens: json.usage?.completion_tokens ?? 0,
      durationMs,
    };
  } finally {
    clearTimeout(timer);
  }
}
