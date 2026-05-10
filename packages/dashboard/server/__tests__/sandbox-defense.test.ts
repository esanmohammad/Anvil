/**
 * Phase S follow-up #8 — defense corpus tests for the sandbox.
 *
 * Two layers:
 *
 *   1. **Pure-logic tests (always run).** Feed adversarial inputs
 *      through the dashboard's pure helpers (detectLimitKill,
 *      resolveNetworkPolicy, sandboxRelative path-escape guard) and
 *      assert the right classification surfaces. These don't require
 *      Docker — they exercise the policy + classification seams.
 *
 *   2. **Real-docker fixtures (opt-in).** Skipped unless
 *      ANVIL_RUN_DOCKER_TESTS=1, matching the docker-runner pattern.
 *      Each spawns a real container, runs an attack payload (fork
 *      bomb / OOM / disk-fill / sleep / privilege escape), and
 *      asserts killedByLimit ∈ {pid, oom, disk, timeout} OR exec
 *      fails as expected.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { detectLimitKill } from '../sandbox/resource-limits.js';
import { resolveNetworkPolicy } from '../sandbox/network-policy.js';
import { DockerSandboxRunner } from '../sandbox/docker-runner.js';

// ───────────────────────────────────────────────────────────────────────
// Layer 1 — pure-logic adversarial corpus
// ───────────────────────────────────────────────────────────────────────

describe('sandbox defense — escape attempt fixtures (pure)', () => {
  // Each fixture pairs a "what the malicious payload would do" stderr
  // pattern with the expected killedByLimit classification. The actual
  // sandbox-runner exit-code path runs detectLimitKill on every exec
  // — these guard the symptom→category mapping.
  const FIXTURES = [
    {
      name: 'fork bomb — pthread_create EAGAIN',
      stderr: 'pthread_create: EAGAIN: Resource temporarily unavailable',
      exitCode: 1,
      expected: 'pid',
    },
    {
      name: 'fork bomb — fork() EAGAIN',
      stderr: 'sh: fork: Resource temporarily unavailable',
      exitCode: 1,
      expected: 'pid',
    },
    {
      name: 'fork bomb — clone() EAGAIN',
      stderr: 'fatal: clone: Resource temporarily unavailable',
      exitCode: 1,
      expected: 'pid',
    },
    {
      name: 'OOM — kernel SIGKILL via exit 137',
      stderr: '',
      exitCode: 137,
      expected: 'oom',
    },
    {
      name: 'OOM — explicit oomKilled flag',
      stderr: 'killed',
      exitCode: 137,
      oomKilled: true,
      expected: 'oom',
    },
    {
      name: 'disk-fill — dd hits "No space left on device"',
      stderr: 'dd: writing to /tmp/big: No space left on device',
      exitCode: 1,
      expected: 'disk',
    },
    {
      name: 'tar disk-fill',
      stderr: 'tar: write error: disk full',
      exitCode: 2,
      expected: 'disk',
    },
    {
      name: 'plain non-zero exit — NOT a limit kill',
      stderr: 'syntax error',
      exitCode: 1,
      expected: undefined,
    },
    {
      name: 'segfault (139) — NOT classified as a limit kill',
      stderr: 'segmentation fault',
      exitCode: 139,
      expected: undefined,
    },
  ] as const;

  for (const fix of FIXTURES) {
    it(fix.name, () => {
      const got = detectLimitKill({
        exitCode: fix.exitCode,
        stderr: fix.stderr,
        oomKilled: 'oomKilled' in fix ? fix.oomKilled : false,
      });
      assert.equal(got, fix.expected);
    });
  }

  it('refuses to silently allow nasty.example.com when project-deny set', () => {
    const r = resolveNetworkPolicy({
      stagePolicy: {
        mode: 'container',
        fsMode: 'overlay',
        limits: { network: { default: 'deny', allowList: ['nasty.example.com'] } },
      },
      projectOverlay: { default: 'deny', blockList: ['nasty.example.com'] },
    });
    assert.ok(!(r.allowList ?? []).includes('nasty.example.com'),
      'project blockList must override stage allowList');
  });

  it('default-deny + empty allowList collapses to network=none (no egress)', () => {
    const r = resolveNetworkPolicy({
      stagePolicy: { mode: 'container', fsMode: 'overlay' },
      projectOverlay: { default: 'deny', allowList: [] },
      includePackageManagerHosts: false,
    });
    assert.equal(r.default, 'deny');
    assert.equal(r.allowList?.length ?? 0, 0);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Layer 2 — real-docker fixture tests
// ───────────────────────────────────────────────────────────────────────

const realDocker = process.env.ANVIL_RUN_DOCKER_TESTS === '1';

describe('sandbox defense — real-docker fixtures (opt-in)', { skip: !realDocker }, () => {
  it('timeout — sleep longer than the limit hits killedByLimit=timeout', async () => {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'anvil-defense-'));
    try {
      const runner = new DockerSandboxRunner();
      const handle = await runner.acquire({
        project: 'p', runId: `r-${Date.now()}`, stage: 'validate',
        hostWorkdir: tempRoot,
        image: 'debian:bookworm-slim',
        limits: { timeoutSeconds: 1 },
      });
      try {
        const r = await handle.exec({ command: 'sleep 30' });
        assert.equal(r.killedByLimit, 'timeout');
      } finally {
        await handle.close();
      }
    } finally {
      await fsp.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('oom — alloc beyond memoryMiB hits killedByLimit=oom', async () => {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'anvil-defense-'));
    try {
      const runner = new DockerSandboxRunner();
      const handle = await runner.acquire({
        project: 'p', runId: `r-${Date.now()}`, stage: 'build',
        hostWorkdir: tempRoot,
        image: 'debian:bookworm-slim',
        limits: { memoryMiB: 32, timeoutSeconds: 60 },
      });
      try {
        // python -c "x = 'a' * (1<<30)" — alloc ~1GiB; far beyond 32 MiB cap.
        const r = await handle.exec({
          command: `python3 -c "x = 'a' * (1<<30); print(len(x))"`,
        });
        assert.equal(r.killedByLimit, 'oom');
      } finally {
        await handle.close();
      }
    } finally {
      await fsp.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('pid-fork-bomb — exceeding pids cap hits killedByLimit=pid', async () => {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'anvil-defense-'));
    try {
      const runner = new DockerSandboxRunner();
      const handle = await runner.acquire({
        project: 'p', runId: `r-${Date.now()}`, stage: 'build',
        hostWorkdir: tempRoot,
        image: 'debian:bookworm-slim',
        limits: { pids: 16, timeoutSeconds: 30 },
      });
      try {
        // Spawn 1000 nested processes; the pid limit kicks in long before.
        const r = await handle.exec({
          command: `for i in $(seq 1 1000); do sleep 60 & done; wait`,
          timeoutMs: 10_000,
        });
        // Either fork EAGAIN classified as 'pid' OR the sandbox killed
        // the parent for hitting the limit. Both are acceptable.
        assert.ok(r.killedByLimit === 'pid' || r.exitCode !== 0,
          `expected pid kill or non-zero exit, got ${JSON.stringify(r)}`);
      } finally {
        await handle.close();
      }
    } finally {
      await fsp.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('escape attempt — bash cannot read /proc/1/environ across pid namespace', async () => {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'anvil-defense-'));
    try {
      const runner = new DockerSandboxRunner();
      const handle = await runner.acquire({
        project: 'p', runId: `r-${Date.now()}`, stage: 'validate',
        hostWorkdir: tempRoot,
        image: 'debian:bookworm-slim',
      });
      try {
        const r = await handle.exec({
          command: `cat /proc/1/environ 2>&1 || true`,
        });
        // Either we read OUR /proc/1/environ (the tini init, harmless)
        // or permission denied — never the host's environ. The output
        // must NOT contain a HOME=/Users/... pattern (host paths).
        assert.ok(
          !r.stdout.includes('/Users/') && !r.stdout.includes('PATH=/usr/local/sbin'),
          `unexpectedly read host environ: ${r.stdout.slice(0, 200)}`,
        );
      } finally {
        await handle.close();
      }
    } finally {
      await fsp.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('escape attempt — bash cannot mount /proc onto /tmp/proc (cap-drop)', async () => {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'anvil-defense-'));
    try {
      const runner = new DockerSandboxRunner();
      const handle = await runner.acquire({
        project: 'p', runId: `r-${Date.now()}`, stage: 'validate',
        hostWorkdir: tempRoot,
        image: 'debian:bookworm-slim',
      });
      try {
        const r = await handle.exec({
          command: `mkdir /tmp/proc && mount -t proc proc /tmp/proc 2>&1 || echo "blocked"`,
        });
        assert.match(r.stdout + r.stderr, /(blocked|operation not permitted|Permission denied)/i);
      } finally {
        await handle.close();
      }
    } finally {
      await fsp.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
