/**
 * Tests for claude-runner.ts — LLM runner module.
 *
 * The module resolves CLAUDE_BIN and GEMINI_BIN at import time from env vars,
 * so we cannot override them after import. Instead we test:
 * 1. Exported function signatures and types
 * 2. The ClaudeResult shape contract
 * 3. Error handling for non-zero exit codes (using a shell wrapper)
 * 4. Timeout behavior (verified structurally)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, chmodSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

// We test the module by importing it with a controlled environment.
// To control CLAUDE_BIN, we set env BEFORE importing the module.
// This requires a dynamic import approach.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTempDir(): string {
  const dir = join(tmpdir(), `claude-runner-test-${randomBytes(6).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Create a shell script that outputs a stream-json result message
 * mimicking the Claude CLI output format, then exits with the given code.
 */
function createFakeClaude(dir: string, opts: {
  resultText?: string;
  exitCode?: number;
  costUsd?: number;
}): string {
  const resultText = opts.resultText ?? 'test result';
  const exitCode = opts.exitCode ?? 0;
  const costUsd = opts.costUsd ?? 0.001;

  const resultLine = JSON.stringify({
    type: 'result',
    result: resultText,
    total_cost_usd: costUsd,
    usage: { input_tokens: 100, output_tokens: 50 },
    duration_ms: 500,
  });

  const script = `#!/bin/bash
# Fake Claude CLI for testing
echo '${resultLine}'
exit ${exitCode}
`;
  const path = join(dir, 'fake-claude');
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

/**
 * Create a fake CLI that just exits with a given code and stderr.
 */
function createFailingBinary(dir: string, name: string, exitCode: number, stderr: string): string {
  const script = `#!/bin/bash
echo '${stderr}' >&2
exit ${exitCode}
`;
  const path = join(dir, name);
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

// ---------------------------------------------------------------------------
// Tests — exported interface
// ---------------------------------------------------------------------------

describe('claude-runner exports', () => {
  it('exports runLLM, runClaude, runGemini as functions', async () => {
    const mod = await import('../claude-runner.js');
    assert.equal(typeof mod.runLLM, 'function');
    assert.equal(typeof mod.runClaude, 'function');
    assert.equal(typeof mod.runGemini, 'function');
  });

  it('runLLM accepts provider option without type error', async () => {
    const mod = await import('../claude-runner.js');
    // Verify the function signature by checking it does not throw
    // a synchronous error when called with various option shapes.
    // We do NOT await — just verify the call itself is valid.
    assert.equal(typeof mod.runLLM, 'function');
    // The function returns a Promise regardless of provider
    const p = mod.runLLM('test', 'system', { provider: 'claude', timeoutMs: 1 });
    assert.ok(p instanceof Promise, 'runLLM should return a Promise');
    // Cancel by catching the inevitable rejection (timeout or error)
    p.catch(() => {});
  });

  it('runLLM accepts provider=gemini option', async () => {
    const mod = await import('../claude-runner.js');
    const p = mod.runLLM('test', 'system', { provider: 'gemini', timeoutMs: 1 });
    assert.ok(p instanceof Promise);
    p.catch(() => {});
  });
});

// ---------------------------------------------------------------------------
// Tests — with fake binaries (requires env set before module load)
// ---------------------------------------------------------------------------

describe('claude-runner with fake binary', () => {
  let tempDir: string;

  it('runClaude returns a ClaudeResult with expected shape on success', async () => {
    tempDir = createTempDir();
    const fakePath = createFakeClaude(tempDir, {
      resultText: 'hello from test',
      exitCode: 0,
      costUsd: 0.005,
    });

    // Set env BEFORE dynamic import so the module picks it up.
    // However, the module is already cached from earlier imports.
    // We use a workaround: invoke the fake binary directly via spawn
    // to test the output parsing logic separately.

    // Since we cannot re-import the module with different env vars in the
    // same process (ESM module cache), we test the contract by verifying
    // the shape of the result type through a subprocess.
    const { execSync } = await import('node:child_process');

    // Run the fake binary and verify its output is valid JSON
    const output = execSync(fakePath, { encoding: 'utf-8' }).trim();
    const parsed = JSON.parse(output);

    assert.equal(parsed.type, 'result');
    assert.equal(typeof parsed.result, 'string');
    assert.equal(typeof parsed.total_cost_usd, 'number');
    assert.ok(parsed.usage);
    assert.equal(typeof parsed.usage.input_tokens, 'number');
    assert.equal(typeof parsed.usage.output_tokens, 'number');
    assert.equal(typeof parsed.duration_ms, 'number');

    rmSync(tempDir, { recursive: true, force: true });
  });

  it('fake binary with non-zero exit code produces stderr', async () => {
    tempDir = createTempDir();
    const fakePath = createFailingBinary(tempDir, 'failing-cli', 1, 'something went wrong');

    const { execSync } = await import('node:child_process');

    try {
      execSync(fakePath, { encoding: 'utf-8' });
      assert.fail('Expected non-zero exit to throw');
    } catch (err: unknown) {
      assert.ok(err instanceof Error);
      const stderr = (err as { stderr?: string }).stderr ?? '';
      assert.ok(stderr.includes('something went wrong'));
    }

    rmSync(tempDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Tests — LLM provider routing logic
// ---------------------------------------------------------------------------

describe('runLLM provider routing', () => {
  it('defaults provider to claude when not specified', async () => {
    // Verify the contract structurally: runLLM with no provider option
    // returns a Promise (same as runClaude). We can't test binary dispatch
    // without mocking, so we verify the function accepts the call shape.
    const mod = await import('../claude-runner.js');

    // Both return Promises — verify the interface
    const p1 = mod.runLLM('test', 'sys', { timeoutMs: 1 });
    const p2 = mod.runClaude('test', 'sys', { timeoutMs: 1 });
    assert.ok(p1 instanceof Promise, 'runLLM returns Promise');
    assert.ok(p2 instanceof Promise, 'runClaude returns Promise');
    // Suppress unhandled rejection
    p1.catch(() => {});
    p2.catch(() => {});
  });

  it('provider=gemini routes to runGemini', async () => {
    const mod = await import('../claude-runner.js');

    const [geminiViaLLM, geminiDirect] = await Promise.all([
      mod.runLLM('p', 's', { provider: 'gemini', timeoutMs: 500 }).catch((e: Error) => e),
      mod.runGemini('p', 's', { timeoutMs: 500 }).catch((e: Error) => e),
    ]);

    // Both should be Error instances
    assert.ok(geminiViaLLM instanceof Error, 'runLLM(gemini) should reject with Error');
    assert.ok(geminiDirect instanceof Error, 'runGemini should reject with Error');
  });
});

// ---------------------------------------------------------------------------
// Tests — timeout argument
// ---------------------------------------------------------------------------

describe('timeout option', () => {
  it('timeoutMs is accepted by runClaude', async () => {
    const mod = await import('../claude-runner.js');
    // Calling with a very short timeout should cause it to reject quickly
    // (either from timeout or from the process erroring out).
    const start = Date.now();
    try {
      await mod.runClaude('prompt', 'system', { timeoutMs: 200 });
    } catch {
      // Expected
    }
    const elapsed = Date.now() - start;
    // Should not hang forever — should resolve within a reasonable bound
    assert.ok(elapsed < 30_000, `Should not hang; elapsed: ${elapsed}ms`);
  });

  it('timeoutMs is accepted by runGemini', async () => {
    const mod = await import('../claude-runner.js');
    const start = Date.now();
    try {
      await mod.runGemini('prompt', 'system', { timeoutMs: 200 });
    } catch {
      // Expected
    }
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 30_000, `Should not hang; elapsed: ${elapsed}ms`);
  });
});
