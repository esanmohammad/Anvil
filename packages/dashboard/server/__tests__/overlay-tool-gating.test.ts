/**
 * H10-followup #1 — pipeline-policy.overlay.json `tools.*` gating
 * actually strips tools at the per-stage resolver. Without this fix
 * the overlay UI lets users set `enabled: false` and nothing changes
 * at runtime.
 *
 * Uses a temp ANVIL_HOME so the test reads a real overlay file the
 * resolver picks up via `loadPolicy`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { allowedToolsForCurrentStage } from '../model-resolution.js';

function makeDeps(project: string, anvilHome: string) {
  const prevAnvilHome = process.env.ANVIL_HOME;
  process.env.ANVIL_HOME = anvilHome;
  return {
    deps: {
      config: { project, model: 'test', feature: 'f' },
      projectLoader: { getConfig: () => undefined },
      state: { stages: [] },
      runtimeBurnedModels: new Set<string>(),
      livenessFallbackNotified: new Set<string>(),
    } as never,
    restore: () => {
      if (prevAnvilHome === undefined) delete process.env.ANVIL_HOME;
      else process.env.ANVIL_HOME = prevAnvilHome;
    },
  };
}

function writeOverlay(home: string, project: string, body: object): void {
  const dir = join(home, 'projects', project);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'pipeline-policy.overlay.json'), JSON.stringify(body));
}

describe('allowedToolsForCurrentStage — overlay gating', () => {
  it('strips network tools when tools.network.enabled = false', () => {
    const home = mkdtempSync(join(tmpdir(), 'anvil-overlay-'));
    const { deps, restore } = makeDeps('proj-1', home);
    try {
      writeOverlay(home, 'proj-1', { tools: { network: { enabled: false } } });
      const tools = allowedToolsForCurrentStage(deps, 'clarify');
      assert.equal(tools.includes('web_search'), false, 'web_search should be stripped');
      assert.equal(tools.includes('web_fetch'), false, 'web_fetch should be stripped');
      assert.ok(tools.includes('read_file'), 'FS surface preserved');
    } finally {
      rmSync(home, { recursive: true, force: true });
      restore();
    }
  });

  it('honors tools.network.stages allow-list (clarify keeps; plan loses)', () => {
    const home = mkdtempSync(join(tmpdir(), 'anvil-overlay-'));
    const { deps, restore } = makeDeps('proj-2', home);
    try {
      writeOverlay(home, 'proj-2', { tools: { network: { stages: ['clarify'] } } });
      const clarify = allowedToolsForCurrentStage(deps, 'clarify');
      const plan = allowedToolsForCurrentStage(deps, 'plan');
      assert.ok(clarify.includes('web_search'), 'clarify keeps web_search');
      assert.equal(plan.includes('web_search'), false, 'plan loses web_search (not in stages)');
    } finally {
      rmSync(home, { recursive: true, force: true });
      restore();
    }
  });

  it('strips browseEval when tools.browseEval.enabled = false', () => {
    const home = mkdtempSync(join(tmpdir(), 'anvil-overlay-'));
    const { deps, restore } = makeDeps('proj-3', home);
    try {
      writeOverlay(home, 'proj-3', { tools: { browseEval: { enabled: false } } });
      const tools = allowedToolsForCurrentStage(deps, 'validate');
      assert.equal(tools.includes('browser_evaluate'), false);
      assert.ok(tools.includes('browser_navigate'), 'browseHeadless tools preserved');
    } finally {
      rmSync(home, { recursive: true, force: true });
      restore();
    }
  });

  it('strips browsePixel when tools.browsePixel.enabled = false', () => {
    const home = mkdtempSync(join(tmpdir(), 'anvil-overlay-'));
    const { deps, restore } = makeDeps('proj-4', home);
    try {
      writeOverlay(home, 'proj-4', { tools: { browsePixel: { enabled: false } } });
      const tools = allowedToolsForCurrentStage(deps, 'validate');
      assert.equal(tools.includes('computer_use'), false);
    } finally {
      rmSync(home, { recursive: true, force: true });
      restore();
    }
  });

  it('leaves tools alone when overlay is missing', () => {
    const home = mkdtempSync(join(tmpdir(), 'anvil-overlay-'));
    const { deps, restore } = makeDeps('proj-5', home);
    try {
      const tools = allowedToolsForCurrentStage(deps, 'clarify');
      assert.ok(tools.includes('web_search'));
    } finally {
      rmSync(home, { recursive: true, force: true });
      restore();
    }
  });
});
