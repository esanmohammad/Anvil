#!/usr/bin/env node
/**
 * Manual smoke test for the OpenRouter adapter against FREE models
 * that advertise `tools` support. Verifies the agentic loop closes —
 * model requests a tool, BuiltinToolExecutor runs it, model receives
 * the result, file actually lands on disk.
 *
 * Usage:
 *
 *   OPENROUTER_API_KEY=sk-or-v1-... \
 *     node packages/agent-core/scripts/smoke-openrouter-free.mjs
 *
 *   # Pick specific models:
 *   node packages/agent-core/scripts/smoke-openrouter-free.mjs \
 *     qwen/qwen3-coder:free z-ai/glm-4.5-air:free
 *
 * Free OpenRouter models often fail a tool-loop run for non-API
 * reasons: rate limits (`429`), upstream provider quotas, "function
 * calling not stable on this provider", or simply not following the
 * tool-call protocol. The script tries each model, reports per-model
 * pass/fail, and exits non-zero only if ALL fail.
 */

import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OpenRouterAdapter } from '../dist/openrouter-adapter.js';
import { BuiltinToolExecutor } from '../dist/tools/builtin.js';

if (!process.env.OPENROUTER_API_KEY) {
  console.error('OPENROUTER_API_KEY is not set. Add it to ~/.anvil/.env or export it.');
  process.exit(1);
}

// Curated list — free models that have actually shown working tool
// calls in the wild. Order = preference (best agentic first).
const DEFAULT_MODELS = [
  'qwen/qwen3-coder:free',
  'z-ai/glm-4.5-air:free',
  'qwen/qwen3-next-80b-a3b-instruct:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'openai/gpt-oss-120b:free',
];

const models = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_MODELS;

function makeRecorder() {
  const lines = [];
  return {
    sink: {
      write(chunk) {
        const text = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
        for (const line of text.split('\n')) {
          if (line) lines.push(line);
        }
        return true;
      },
      end() {},
      on() {},
    },
    lines,
  };
}

let anyPassed = false;
const summary = [];

for (const model of models) {
  console.log(`\n▶ ${model}`);

  const workdir = mkdtempSync(join(tmpdir(), 'anvil-or-smoke-'));
  const executor = new BuiltinToolExecutor({
    allowedTools: ['read_file', 'write_file', 'edit', 'bash', 'list', 'glob', 'grep'],
  });

  const adapter = new OpenRouterAdapter();
  const recorder = makeRecorder();
  const t0 = Date.now();

  try {
    const result = await adapter.run(
      {
        userPrompt:
          'Use the write_file tool to create a file named hello.txt with exactly the contents "agentic-loop-works". Then briefly confirm with a short message.',
        projectPrompt:
          'You are a coding assistant with file-system tools. When the user asks you to do something, USE the available tools to actually do it — do not just describe the steps. Always pick a tool when one applies.',
        model,
        workingDir: workdir,
        stage: 'build',
        persona: 'engineer',
        toolExecutor: executor,
        maxToolIterations: 8,
      },
      recorder.sink,
    );

    const filePath = join(workdir, 'hello.txt');
    const fileWritten = existsSync(filePath);
    const fileContents = fileWritten ? readFileSync(filePath, 'utf8') : '';
    const toolUses = recorder.lines.filter((l) => l.includes('"tool_use"')).length;
    const toolResults = recorder.lines.filter((l) => l.includes('"tool_result"')).length;

    console.log(`  duration:        ${result.durationMs} ms (wall ${Date.now() - t0} ms)`);
    console.log(`  tokens:          in=${result.inputTokens} out=${result.outputTokens}`);
    console.log(`  tool_use lines:  ${toolUses}`);
    console.log(`  tool_result:     ${toolResults}`);
    console.log(`  cost USD:        ${result.costUsd.toFixed(6)}  (free tier — should be ~0)`);
    console.log(`  hello.txt:       ${fileWritten ? 'WRITTEN' : 'MISSING'}`);
    if (fileWritten) console.log(`  contents:        ${JSON.stringify(fileContents)}`);

    const ok = fileWritten && /agentic-loop-works/.test(fileContents) && toolUses >= 1;
    console.log(`  ${ok ? '✅ PASS' : '❌ FAIL'}`);
    summary.push({ model, ok, toolUses, fileWritten });
    if (ok) anyPassed = true;
  } catch (err) {
    const msg = err.message || String(err);
    const retryable = err.name === 'UpstreamError' && err.retryable === true;
    console.error(`  ❌ FAIL — adapter threw${retryable ? ' (retryable upstream)' : ''}: ${msg.slice(0, 200)}`);
    summary.push({ model, ok: false, error: msg.slice(0, 80) });
  }
}

console.log('\n──────── SUMMARY ────────');
for (const s of summary) {
  const icon = s.ok ? '✅' : '❌';
  const detail = s.ok
    ? `tool_uses=${s.toolUses} file=WRITTEN`
    : (s.error ? `error: ${s.error}` : `tool_uses=${s.toolUses ?? 0} file=${s.fileWritten ? 'WRITTEN' : 'MISSING'}`);
  console.log(`  ${icon} ${s.model.padEnd(50)}  ${detail}`);
}
console.log(`\n${anyPassed ? '✅ At least one free model closed the agentic loop.' : '❌ NO free model completed the loop.'}`);

process.exit(anyPassed ? 0 : 1);
