/**
 * Single-shot LLM runner — agent-core's analytical-shape entry point.
 *
 * Used by knowledge-core consumers (repo-profiler, service-mesh-inferrer,
 * rag-evaluator) that want a `prompt + system → text + cost` round trip
 * without managing the streaming surface themselves.
 *
 * Two transports:
 *   - 'cli' (default) — spawns claude / gemini binary
 *   - 'api'           — direct HTTP calls to Anthropic or OpenAI-compat endpoint
 *   - 'none'          — disabled; throws on every call
 *
 * Mode resolution (ANVIL_LLM_MODE → CODE_SEARCH_LLM_MODE → auto-detect):
 *   1. explicit 'cli'/'api'/'none' wins
 *   2. else if API key present → 'api'
 *   3. else if claude binary on PATH → 'cli'
 *   4. else 'none'
 *
 * Env-var aliasing (Phase 5): ANVIL_* is canonical; CODE_SEARCH_LLM_* + a few
 * unscoped legacy names (CLAUDE_BIN, GEMINI_BIN, ANVIL_AGENT_CMD, FF_AGENT_CMD,
 * ANTHROPIC_API_KEY, GEMINI_API_KEY, GOOGLE_API_KEY) are kept as aliases. A
 * deprecation warning is emitted to stderr if a legacy var is set without its
 * canonical counterpart.
 *
 * Note on the unification path: this runner currently spawns subprocesses + makes
 * HTTP calls directly (lift-and-shift from the original
 * knowledge-core/claude-runner.ts). It does NOT yet route through
 * `ProviderRegistry` + `LanguageModel.invoke()` — that requires every adapter
 * to grow an `invoke()` impl, which is a follow-up phase. Both paths produce
 * the same `ClaudeResult` shape, so callers don't see the difference.
 */

import { spawn, execSync, ChildProcess } from 'node:child_process';
import { withInvokeSpan } from './telemetry/instrument.js';
import { GenAi } from './telemetry/attributes.js';
import { calculateCostBreakdown } from './cost.js';
import {
  getFetchPool,
  recycleFetchPoolOnFailure,
  type ProviderId,
} from './fetch-pool.js';

// ── Env-var aliasing ───────────────────────────────────────────────────────

const ALIASED_VARS_LOGGED = new Set<string>();

/**
 * Read an env var, preferring the canonical `ANVIL_*` name, falling back to
 * one or more legacy names. Emits a one-time deprecation warning to stderr if
 * a legacy var is set without its canonical counterpart.
 */
function readAliased(canonical: string, ...legacy: string[]): string | undefined {
  const canonicalValue = process.env[canonical];
  if (canonicalValue !== undefined) return canonicalValue;
  for (const name of legacy) {
    const value = process.env[name];
    if (value !== undefined) {
      const key = `${name}->${canonical}`;
      if (!ALIASED_VARS_LOGGED.has(key)) {
        ALIASED_VARS_LOGGED.add(key);
        process.stderr.write(
          `[anvil-llm] DEPRECATED: ${name} is set without ${canonical}. ` +
          `Migrate to ${canonical} (legacy alias removed in 1.0).\n`,
        );
      }
      return value;
    }
  }
  return undefined;
}

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
        '[anvil-llm] WARNING: ANVIL_LLM_MODE=api but no API key found. ' +
        'Set ANVIL_LLM_API_KEY or ANVIL_ANTHROPIC_API_KEY (or ANTHROPIC_API_KEY). ' +
        'Falling back to ANVIL_LLM_MODE=none.\n',
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

  const apiKey =
    readAliased('ANVIL_LLM_API_KEY', 'CODE_SEARCH_LLM_API_KEY') ??
    readAliased('ANVIL_ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY');

  const claudeBin =
    readAliased('ANVIL_CLAUDE_BIN', 'ANVIL_AGENT_CMD', 'FF_AGENT_CMD', 'CODE_SEARCH_CLAUDE_BIN', 'CLAUDE_BIN') ??
    'claude';

  const geminiBin =
    readAliased('ANVIL_GEMINI_BIN', 'GEMINI_BIN', 'GEMINI_CLI_BIN') ??
    'gemini';

  _cachedConfig = {
    llmMode: resolveLlmMode(
      readAliased('ANVIL_LLM_MODE', 'CODE_SEARCH_LLM_MODE'),
      apiKey,
      claudeBin,
    ),
    llmProvider: readAliased('ANVIL_LLM_PROVIDER', 'CODE_SEARCH_LLM_PROVIDER') ?? 'anthropic',
    llmModel: readAliased('ANVIL_LLM_MODEL', 'CODE_SEARCH_LLM_MODEL') ?? 'sonnet',
    llmApiKey: apiKey,
    llmBaseUrl: readAliased('ANVIL_LLM_BASE_URL', 'CODE_SEARCH_LLM_BASE_URL'),
    claudeBin,
    geminiBin,
  };
  return _cachedConfig;
}

/** Test seam — reset cached config (call between tests that override env). */
export function resetLlmConfig(): void {
  _cachedConfig = null;
  ALIASED_VARS_LOGGED.clear();
}

/** Report whether any LLM transport is currently usable. */
export function isLlmAvailable(): boolean {
  return loadLlmConfig().llmMode !== 'none';
}

// ── Process tracking — robust SIGINT/SIGTERM cleanup ───────────────────────

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

/** Run Claude — dispatches to CLI or API based on resolved LLM mode. */
export async function runClaude(
  prompt: string,
  systemPrompt: string,
  opts?: { model?: string; timeoutMs?: number },
): Promise<ClaudeResult> {
  const config = loadLlmConfig();
  if (config.llmMode === 'none') {
    throw new Error('LLM inference disabled (ANVIL_LLM_MODE=none)');
  }
  const model = opts?.model ?? config.llmModel;
  const timeoutMs = opts?.timeoutMs ?? 600_000;
  return withInvokeSpan(
    { provider: 'claude', model, prompt, systemPrompt },
    () => config.llmMode === 'api'
      ? runViaApi(prompt, systemPrompt, model, timeoutMs, config)
      : runViaCli(prompt, systemPrompt, model, timeoutMs, config.claudeBin),
    (r) => {
      const bd = calculateCostBreakdown(model, {
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
      });
      return {
        [GenAi.USAGE_INPUT_TOKENS]: r.inputTokens,
        [GenAi.USAGE_OUTPUT_TOKENS]: r.outputTokens,
        [GenAi.USAGE_COST_USD]: bd.totalUsd > 0 ? bd.totalUsd : r.costUsd,
        [GenAi.USAGE_COST_INPUT_USD]: bd.inputUsd,
        [GenAi.USAGE_COST_OUTPUT_USD]: bd.outputUsd,
        'anvil.duration_ms': r.durationMs,
        'anvil.transport': config.llmMode,
      };
    },
  );
}

/** Run Gemini CLI — CLI mode only (no Gemini API integration today). */
export async function runGemini(
  prompt: string,
  systemPrompt: string,
  opts?: { model?: string; timeoutMs?: number },
): Promise<ClaudeResult> {
  const config = loadLlmConfig();
  if (config.llmMode === 'none') {
    throw new Error('LLM inference disabled (ANVIL_LLM_MODE=none)');
  }
  const model = opts?.model ?? 'gemini-2.5-pro';
  const timeoutMs = opts?.timeoutMs ?? 600_000;

  // Combine — Gemini CLI has no separate --system-prompt flag.
  const combinedPrompt = systemPrompt
    ? `${systemPrompt}\n\n---\n\n${prompt}`
    : prompt;

  return withInvokeSpan(
    { provider: 'gemini-cli', model, prompt, systemPrompt },
    () => runGeminiInner(config, model, combinedPrompt, timeoutMs),
    (r) => {
      const bd = calculateCostBreakdown(model, {
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
      });
      return {
        [GenAi.USAGE_INPUT_TOKENS]: r.inputTokens,
        [GenAi.USAGE_OUTPUT_TOKENS]: r.outputTokens,
        [GenAi.USAGE_COST_USD]: bd.totalUsd > 0 ? bd.totalUsd : r.costUsd,
        [GenAi.USAGE_COST_INPUT_USD]: bd.inputUsd,
        [GenAi.USAGE_COST_OUTPUT_USD]: bd.outputUsd,
        'anvil.duration_ms': r.durationMs,
        'anvil.transport': 'cli',
      };
    },
  );
}

function runGeminiInner(
  config: LlmConfig,
  model: string,
  combinedPrompt: string,
  timeoutMs: number,
): Promise<ClaudeResult> {
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
      'ANVIL_LLM_API_KEY not set. Required for ANVIL_LLM_MODE=api. ' +
      `Set it to your ${config.llmProvider} API key, or use ANVIL_LLM_MODE=cli, or ANVIL_LLM_MODE=none.`,
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

    const poolId: ProviderId = isAnthropic
      ? 'anthropic'
      : config.llmProvider === 'gemini'
      ? 'gemini'
      : config.llmProvider === 'openai'
      ? 'openai'
      : 'unknown';
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
        // @ts-expect-error — undici dispatcher accepted by Node fetch at runtime
        dispatcher: getFetchPool(poolId),
      });
    } catch (err) {
      if (controller.signal.aborted) throw err;
      void recycleFetchPoolOnFailure(poolId, err);
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`LLM API fetch failed (${poolId}): ${msg}`);
    }
    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      throw new Error(`LLM API error ${response.status}: ${errBody.slice(0, 500)}`);
    }
    const json = await response.json() as Record<string, unknown>;
    const durationMs = Date.now() - startTime;

    if (isAnthropic) {
      const content = (json.content as Array<{ type: string; text?: string }> | undefined) ?? [];
      const text = content
        .filter((b) => b.type === 'text' && b.text)
        .map((b) => b.text)
        .join('');
      const usage = (json.usage as { input_tokens?: number; output_tokens?: number } | undefined) ?? {};
      return {
        result: text,
        costUsd: 0,
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        durationMs,
      };
    }
    const choices = json.choices as Array<{ message?: { content?: string } }> | undefined;
    const text = choices?.[0]?.message?.content ?? '';
    const usage = (json.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined) ?? {};
    return {
      result: text,
      costUsd: 0,
      inputTokens: usage.prompt_tokens ?? 0,
      outputTokens: usage.completion_tokens ?? 0,
      durationMs,
    };
  } finally {
    clearTimeout(timer);
  }
}
