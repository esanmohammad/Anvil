#!/usr/bin/env node
/**
 * Manual smoke test for the ADK adapter (Anthropic + Gemini).
 *
 * Spends a small amount of provider quota. Not part of `npm test`.
 *
 * Usage:
 *
 *   # both:
 *   ANTHROPIC_API_KEY=sk-ant-... GEMINI_API_KEY=AIzaSy... \
 *     node packages/agent-core/scripts/smoke-adk.mjs
 *
 *   # only Anthropic:
 *   ANTHROPIC_API_KEY=sk-ant-... node packages/agent-core/scripts/smoke-adk.mjs anthropic
 *
 *   # only Gemini:
 *   GEMINI_API_KEY=AIzaSy... node packages/agent-core/scripts/smoke-adk.mjs gemini
 *
 * For each requested provider:
 *   1. Builds a BuiltinToolExecutor scoped to a temp working dir.
 *   2. Runs the AdkAdapter against a prompt that REQUIRES a tool call
 *      ("write hello.txt with the contents 'agentic-loop-works'").
 *   3. Verifies the file was actually written and that the agent's
 *      transcript shows tool_use → tool_result.
 */

import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AdkAdapter } from '../dist/adk-adapter.js';
import { BuiltinToolExecutor } from '../dist/tools/builtin.js';

// ── Choose providers based on argv + env ──
const argv = process.argv.slice(2).map((a) => a.toLowerCase());
const requested = argv.length > 0 ? argv : ['anthropic', 'gemini'];

const cases = [];
if (requested.includes('anthropic')) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('[skip] anthropic — ANTHROPIC_API_KEY not set');
  } else {
    cases.push({
      label: 'anthropic',
      model: 'adk:claude-haiku-4-5',
    });
  }
}
if (requested.includes('gemini')) {
  if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_GENAI_API_KEY && !process.env.GOOGLE_API_KEY) {
    console.error('[skip] gemini — set GEMINI_API_KEY, GOOGLE_GENAI_API_KEY, or GOOGLE_API_KEY');
  } else {
    cases.push({
      label: 'gemini',
      model: 'adk:gemini-2.5-flash',
    });
  }
}

if (cases.length === 0) {
  console.error('No provider env keys present — nothing to test.');
  process.exit(1);
}

// ── Stub Writable that records every NDJSON line ──
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

let anyFailed = false;
for (const c of cases) {
  console.log(`\n▶ ${c.label} (${c.model})`);

  const workdir = mkdtempSync(join(tmpdir(), 'anvil-adk-smoke-'));
  const executor = new BuiltinToolExecutor({
    allowedTools: ['read_file', 'write_file', 'edit', 'bash', 'list', 'glob', 'grep'],
  });

  const adapter = new AdkAdapter();
  const recorder = makeRecorder();
  const t0 = Date.now();

  try {
    const result = await adapter.run(
      {
        userPrompt:
          'Use the write_file tool to create a file named hello.txt with exactly the contents "agentic-loop-works". Then briefly confirm.',
        projectPrompt: 'You are a coding assistant. Use the available tools to do the requested job. Do not just describe — execute.',
        model: c.model,
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
    console.log(`  cost USD:        ${result.costUsd.toFixed(6)}`);
    console.log(`  hello.txt:       ${fileWritten ? 'WRITTEN' : 'MISSING'}`);
    if (fileWritten) {
      console.log(`  contents:        ${JSON.stringify(fileContents)}`);
    }

    const ok = fileWritten && /agentic-loop-works/.test(fileContents) && toolUses >= 1;
    console.log(`  ${ok ? '✅ PASS' : '❌ FAIL'} — agentic loop ${ok ? 'fired a tool and produced a real file change' : 'did NOT close the loop'}`);
    if (!ok) anyFailed = true;
  } catch (err) {
    console.error(`  ❌ FAIL — adapter threw: ${err.message}`);
    if (process.env.DEBUG) console.error(err.stack);
    anyFailed = true;
  }
}

process.exit(anyFailed ? 1 : 0);
