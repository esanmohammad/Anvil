/**
 * Phase 4f.6 tests — workspace-ops helpers replace the git/shell-side
 * methods that `pipeline-runner.ts` used to own.
 *
 * Tests use a fake `ShellRunner` so we exercise the command-resolution
 * + auto-detection paths without invoking real git or shell tools.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  pullBaseBranchForRepos,
  runPostBuildGuards,
  deployProject,
  createFeatureBranches,
  runSilent,
  fileExists,
  type ShellRunner,
} from '../steps/workspace-ops.js';

interface FakeRun { cmd: string; cwd: string; timeout?: number }

interface FakeRunnerOpts {
  /** Map cmd-substring → "throw" or fake stdout. */
  responses?: Array<{ match: RegExp | string; reply: string | 'throw' }>;
}

function fakeRunner(opts: FakeRunnerOpts = {}): {
  runner: ShellRunner;
  calls: FakeRun[];
} {
  const calls: FakeRun[] = [];
  const runner: ShellRunner = {
    run: (cmd, runOpts) => {
      calls.push({ cmd, cwd: runOpts.cwd, timeout: runOpts.timeout });
      const match = opts.responses?.find((r) =>
        typeof r.match === 'string' ? cmd.includes(r.match) : r.match.test(cmd),
      );
      if (match?.reply === 'throw') {
        throw new Error(`fake fail for "${cmd}"`);
      }
      return match?.reply ?? '';
    },
  };
  return { runner, calls };
}

// ── runSilent + fileExists ─────────────────────────────────────────────

describe('runSilent', () => {
  it('swallows runner failures (best-effort semantics)', () => {
    const { runner, calls } = fakeRunner({ responses: [{ match: 'lint', reply: 'throw' }] });
    runSilent('lint', '/tmp', runner);
    assert.equal(calls.length, 1); // Called once, didn't propagate the throw.
  });

  it('forwards cwd and a 60s timeout to the runner', () => {
    const { runner, calls } = fakeRunner();
    runSilent('echo hi', '/tmp/r', runner);
    assert.equal(calls[0].cwd, '/tmp/r');
    assert.equal(calls[0].timeout, 60_000);
  });
});

describe('fileExists', () => {
  it('returns true for files that exist on disk', () => {
    const root = mkdtempSync(join(tmpdir(), 'anvil-fe-'));
    writeFileSync(join(root, 'go.mod'), 'module x', 'utf-8');
    assert.equal(fileExists(root, 'go.mod'), true);
    assert.equal(fileExists(root, 'absent.txt'), false);
    rmSync(root, { recursive: true, force: true });
  });
});

// ── pullBaseBranchForRepos ─────────────────────────────────────────────

describe('pullBaseBranchForRepos', () => {
  it('uses the explicit baseBranch when provided (no fallback to master)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'anvil-pull-'));
    const apiPath = join(root, 'api');
    mkdirSync(apiPath, { recursive: true });
    const { runner, calls } = fakeRunner();
    await pullBaseBranchForRepos({
      baseBranch: 'develop',
      repoPaths: { api: apiPath },
      repoNames: ['api'],
      workspaceDir: root,
      runner,
    });
    assert.equal(calls.length, 1);
    assert.match(calls[0].cmd, /git checkout "develop"/);
    assert.equal(calls[0].cwd, apiPath);
    rmSync(root, { recursive: true, force: true });
  });

  it('auto-detects main → master when no explicit baseBranch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'anvil-pull-'));
    const apiPath = join(root, 'api');
    mkdirSync(apiPath, { recursive: true });
    // Make `git checkout main` fail; master succeeds.
    const { runner, calls } = fakeRunner({
      responses: [{ match: 'checkout main', reply: 'throw' }],
    });
    await pullBaseBranchForRepos({
      repoPaths: { api: apiPath },
      repoNames: ['api'],
      workspaceDir: root,
      runner,
    });
    assert.equal(calls.length, 2);
    assert.match(calls[0].cmd, /checkout main/);
    assert.match(calls[1].cmd, /checkout master/);
    rmSync(root, { recursive: true, force: true });
  });

  it('falls back to workspace root when no repos', async () => {
    const root = mkdtempSync(join(tmpdir(), 'anvil-pull-'));
    const { runner, calls } = fakeRunner();
    await pullBaseBranchForRepos({
      baseBranch: 'main',
      repoPaths: {},
      repoNames: [],
      workspaceDir: root,
      runner,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cwd, root);
    rmSync(root, { recursive: true, force: true });
  });

  it('skips repos whose path does not exist on disk', async () => {
    const root = mkdtempSync(join(tmpdir(), 'anvil-pull-'));
    const { runner, calls } = fakeRunner();
    await pullBaseBranchForRepos({
      baseBranch: 'main',
      repoPaths: { ghost: join(root, 'no-such') },
      repoNames: ['ghost'],
      workspaceDir: root,
      runner,
    });
    assert.equal(calls.length, 0);
    rmSync(root, { recursive: true, force: true });
  });
});

// ── runPostBuildGuards ─────────────────────────────────────────────────

describe('runPostBuildGuards', () => {
  it('uses factory.yaml format/lint commands when provided', () => {
    const { runner, calls } = fakeRunner();
    runPostBuildGuards({
      repos: [{ name: 'api', path: '/tmp/api' }],
      getRepoCommands: () => ({ format: 'my-format', lint: 'my-lint' }),
      runner,
    });
    const cmds = calls.map((c) => c.cmd);
    assert.deepEqual(cmds, ['my-format', 'my-lint']);
  });

  it('falls back to language detection when no config commands', () => {
    const root = mkdtempSync(join(tmpdir(), 'anvil-guards-'));
    const goPath = join(root, 'go-repo');
    mkdirSync(goPath, { recursive: true });
    writeFileSync(join(goPath, 'go.mod'), 'module x', 'utf-8');
    const tsPath = join(root, 'ts-repo');
    mkdirSync(tsPath, { recursive: true });
    writeFileSync(join(tsPath, 'package.json'), '{}', 'utf-8');
    const pyPath = join(root, 'py-repo');
    mkdirSync(pyPath, { recursive: true });
    writeFileSync(join(pyPath, 'pyproject.toml'), '[tool.ruff]', 'utf-8');

    const { runner, calls } = fakeRunner();
    runPostBuildGuards({
      repos: [
        { name: 'go-repo', path: goPath },
        { name: 'ts-repo', path: tsPath },
        { name: 'py-repo', path: pyPath },
      ],
      runner,
    });
    const goCalls = calls.filter((c) => c.cwd === goPath).map((c) => c.cmd);
    const tsCalls = calls.filter((c) => c.cwd === tsPath).map((c) => c.cmd);
    const pyCalls = calls.filter((c) => c.cwd === pyPath).map((c) => c.cmd);
    assert.ok(goCalls.some((c) => /^gofmt /.test(c)));
    assert.ok(goCalls.some((c) => /golangci-lint/.test(c)));
    assert.ok(tsCalls.some((c) => /prettier/.test(c)));
    assert.ok(tsCalls.some((c) => /eslint/.test(c)));
    assert.ok(pyCalls.some((c) => /^black /.test(c)));
    assert.ok(pyCalls.some((c) => /^ruff /.test(c)));
    rmSync(root, { recursive: true, force: true });
  });

  it('swallows per-repo command failures via runSilent', () => {
    const { runner, calls } = fakeRunner({
      responses: [{ match: /.*/, reply: 'throw' }],
    });
    runPostBuildGuards({
      repos: [{ name: 'api', path: '/tmp/api' }],
      getRepoCommands: () => ({ format: 'fmt', lint: 'lnt' }),
      runner,
    });
    // Both commands attempted, both failed silently — call count proves it.
    assert.equal(calls.length, 2);
  });
});

// ── deployProject ──────────────────────────────────────────────────────

describe('deployProject', () => {
  it('skips when mode is undefined or false', () => {
    const { runner, calls } = fakeRunner();
    deployProject({ project: 'demo', mode: undefined, workspaceDir: '/tmp', runner });
    deployProject({ project: 'demo', mode: false, workspaceDir: '/tmp', runner });
    assert.equal(calls.length, 0);
  });

  it('uses configDeployCmd verbatim (no project name appended)', () => {
    const { runner, calls } = fakeRunner({
      responses: [{ match: 'my-deploy.sh', reply: 'Deployed at https://demo.example/abc' }],
    });
    const artifacts: any[] = [];
    deployProject({
      project: 'demo',
      mode: 'remote',
      workspaceDir: '/tmp',
      configDeployCmd: 'my-deploy.sh demo --staging',
      onArtifact: (a) => artifacts.push(a),
      runner,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, 'my-deploy.sh demo --staging');
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].file, 'SANDBOX_URL');
    assert.match(artifacts[0].content, /^https:\/\/demo\.example/);
  });

  it('builds the env-fallback command with `up <project> [--remote]`', () => {
    const { runner, calls } = fakeRunner();
    deployProject({
      project: 'demo',
      mode: 'remote',
      workspaceDir: '/tmp',
      envDeployCmd: 'nexus',
      runner,
    });
    assert.equal(calls[0].cmd, 'nexus up demo --remote');

    deployProject({
      project: 'demo',
      mode: 'local',
      workspaceDir: '/tmp',
      envDeployCmd: 'nexus',
      runner,
    });
    assert.equal(calls[1].cmd, 'nexus up demo');
  });

  it('skips silently when no command is configured', () => {
    const { runner, calls } = fakeRunner();
    const logs: Array<{ level: string; message: string }> = [];
    deployProject({
      project: 'demo',
      mode: 'remote',
      workspaceDir: '/tmp',
      onLog: (level, message) => logs.push({ level, message }),
      runner,
    });
    assert.equal(calls.length, 0);
    assert.ok(logs.some((l) => /No deploy command/.test(l.message)));
  });

  it('does not emit an artifact when output has no URL', () => {
    const { runner } = fakeRunner({ responses: [{ match: /.*/, reply: 'no url here' }] });
    const artifacts: any[] = [];
    deployProject({
      project: 'demo',
      mode: 'local',
      workspaceDir: '/tmp',
      configDeployCmd: 'cmd',
      onArtifact: (a) => artifacts.push(a),
      runner,
    });
    assert.equal(artifacts.length, 0);
  });

  it('non-fatal on deploy failure (warn but no throw)', () => {
    const { runner } = fakeRunner({ responses: [{ match: /.*/, reply: 'throw' }] });
    const logs: Array<{ level: string; message: string }> = [];
    deployProject({
      project: 'demo',
      mode: 'remote',
      workspaceDir: '/tmp',
      configDeployCmd: 'cmd',
      onLog: (level, message) => logs.push({ level, message }),
      runner,
    });
    assert.ok(logs.some((l) => l.level === 'warn' && /Deploy to .* failed/.test(l.message)));
  });
});

// ── createFeatureBranches ──────────────────────────────────────────────

describe('createFeatureBranches', () => {
  it('checks out an existing branch when rev-parse succeeds', () => {
    const { runner, calls } = fakeRunner({
      responses: [{ match: 'rev-parse', reply: 'sha' }],
    });
    createFeatureBranches({
      featureSlug: 'add-login',
      repoPaths: { api: '/tmp/api' },
      repoNames: ['api'],
      workspaceDir: '/tmp/ws',
      runner,
    });
    const cmds = calls.map((c) => c.cmd);
    assert.match(cmds[0], /rev-parse --verify "anvil\/add-login"/);
    assert.match(cmds[1], /^git checkout "anvil\/add-login"/);
    assert.equal(cmds.length, 2);
  });

  it('creates a new branch when rev-parse throws', () => {
    const { runner, calls } = fakeRunner({
      responses: [{ match: 'rev-parse', reply: 'throw' }],
    });
    createFeatureBranches({
      featureSlug: 'add-login',
      repoPaths: { api: '/tmp/api' },
      repoNames: ['api'],
      workspaceDir: '/tmp/ws',
      runner,
    });
    const cmds = calls.map((c) => c.cmd);
    assert.match(cmds[1], /^git checkout -b "anvil\/add-login"/);
  });

  it('falls back to workspace root when no repos', () => {
    const { runner, calls } = fakeRunner({
      responses: [{ match: 'rev-parse', reply: 'throw' }],
    });
    createFeatureBranches({
      featureSlug: 'add-login',
      repoPaths: {},
      repoNames: [],
      workspaceDir: '/tmp/ws',
      runner,
    });
    assert.equal(calls.every((c) => c.cwd === '/tmp/ws'), true);
  });

  it('warns but continues when a single repo fails', () => {
    const { runner, calls } = fakeRunner({
      responses: [{ match: /.*/, reply: 'throw' }],
    });
    const logs: Array<{ level: string; message: string }> = [];
    createFeatureBranches({
      featureSlug: 'add-login',
      repoPaths: { api: '/tmp/api', web: '/tmp/web' },
      repoNames: ['api', 'web'],
      workspaceDir: '/tmp/ws',
      onLog: (level, message) => logs.push({ level, message }),
      runner,
    });
    // Both repos visited despite each failing.
    const apiCalls = calls.filter((c) => c.cwd === '/tmp/api');
    const webCalls = calls.filter((c) => c.cwd === '/tmp/web');
    assert.ok(apiCalls.length > 0);
    assert.ok(webCalls.length > 0);
    assert.ok(logs.some((l) => l.level === 'warn' && /Failed to create branch/.test(l.message)));
  });
});
