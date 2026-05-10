/**
 * H0 — Tool registry + per-stage permission lookups for the web/browser
 * surface. Asserts the canonical class membership tables and the
 * stage-permission resolver layered into `allowedToolsForStage`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  WEB_TOOLS_BY_CLASS,
  ALL_WEB_TOOL_NAMES,
  webToolClassForName,
} from '../tools/web-types.js';
import {
  STAGE_WEB_PERMISSIONS,
  allowedWebToolsForStage,
  webPermissionClassesForStage,
  stageMayInvokeWebTool,
} from '../tools/web-tool-registry.js';
import { allowedToolsForStage } from '../routing/stage-permissions.js';

describe('web-tool-registry — class membership', () => {
  it('every class lists at least one tool', () => {
    for (const cls of Object.keys(WEB_TOOLS_BY_CLASS) as Array<keyof typeof WEB_TOOLS_BY_CLASS>) {
      assert.ok(WEB_TOOLS_BY_CLASS[cls].length > 0, `class ${cls} must list tools`);
    }
  });

  it('ALL_WEB_TOOL_NAMES is the union of every class', () => {
    const expected = new Set(Object.values(WEB_TOOLS_BY_CLASS).flat());
    assert.deepEqual(new Set(ALL_WEB_TOOL_NAMES), expected);
  });

  it('webToolClassForName resolves every known tool', () => {
    assert.equal(webToolClassForName('web_search'), 'network');
    assert.equal(webToolClassForName('web_fetch'), 'network');
    assert.equal(webToolClassForName('browser_navigate'), 'browse-headless');
    assert.equal(webToolClassForName('browser_evaluate'), 'browse-eval');
    assert.equal(webToolClassForName('computer_use'), 'browse-pixel');
    assert.equal(webToolClassForName('not-a-tool'), undefined);
  });
});

describe('STAGE_WEB_PERMISSIONS — per-stage defaults', () => {
  it('build + ship are network-blocked', () => {
    assert.deepEqual(STAGE_WEB_PERMISSIONS.build, []);
    assert.deepEqual(STAGE_WEB_PERMISSIONS.ship, []);
  });

  it('validate gets the most (network + headless + eval + pixel)', () => {
    assert.deepEqual(
      STAGE_WEB_PERMISSIONS.validate,
      ['network', 'browse-headless', 'browse-eval', 'browse-pixel'],
    );
  });

  it('research/analysis stages get network only', () => {
    assert.deepEqual(STAGE_WEB_PERMISSIONS.clarify, ['network']);
    assert.deepEqual(STAGE_WEB_PERMISSIONS.requirements, ['network']);
    assert.deepEqual(STAGE_WEB_PERMISSIONS.specs, ['network']);
    assert.deepEqual(STAGE_WEB_PERMISSIONS.plan, ['network']);
    assert.deepEqual(STAGE_WEB_PERMISSIONS.research, ['network']);
  });
});

describe('allowedWebToolsForStage', () => {
  it('returns sorted names for clarify', () => {
    assert.deepEqual(allowedWebToolsForStage('clarify'), ['web_fetch', 'web_search']);
  });

  it('returns full list for validate', () => {
    const got = allowedWebToolsForStage('validate');
    assert.ok(got.includes('web_search'));
    assert.ok(got.includes('browser_navigate'));
    assert.ok(got.includes('browser_evaluate'));
    assert.ok(got.includes('computer_use'));
  });

  it('returns empty for unknown stage', () => {
    assert.deepEqual(allowedWebToolsForStage('not-a-stage'), []);
  });
});

describe('stageMayInvokeWebTool', () => {
  it('allows web_search in clarify', () => {
    assert.equal(stageMayInvokeWebTool('clarify', 'web_search'), true);
  });
  it('rejects browser_evaluate in test stage', () => {
    assert.equal(stageMayInvokeWebTool('test', 'browser_evaluate'), false);
  });
  it('rejects all web tools in build stage', () => {
    assert.equal(stageMayInvokeWebTool('build', 'web_search'), false);
    assert.equal(stageMayInvokeWebTool('build', 'browser_navigate'), false);
  });
});

describe('allowedToolsForStage — combined read/write/exec + web tools', () => {
  it('merges built-in and web tools for clarify', () => {
    const tools = allowedToolsForStage('clarify');
    assert.ok(tools.includes('read_file'), 'clarify keeps read_file');
    assert.ok(tools.includes('web_search'), 'clarify gets web_search');
    assert.ok(tools.includes('web_fetch'), 'clarify gets web_fetch');
    assert.ok(!tools.includes('browser_navigate'), 'clarify excludes browser_navigate');
  });

  it('build keeps full tool set but no network', () => {
    const tools = allowedToolsForStage('build');
    assert.ok(tools.includes('bash'));
    assert.ok(tools.includes('write_file'));
    assert.ok(!tools.includes('web_search'));
    assert.ok(!tools.includes('browser_navigate'));
  });

  it('returns deduped sorted list', () => {
    const tools = allowedToolsForStage('validate');
    const sorted = [...tools].sort();
    assert.deepEqual(tools, sorted, 'output should be sorted');
    assert.equal(new Set(tools).size, tools.length, 'no duplicates');
  });
});

describe('webPermissionClassesForStage', () => {
  it('returns a fresh array (caller can mutate)', () => {
    const a = webPermissionClassesForStage('clarify');
    a.push('browse-pixel');
    const b = webPermissionClassesForStage('clarify');
    assert.deepEqual(b, ['network']);
  });
});
