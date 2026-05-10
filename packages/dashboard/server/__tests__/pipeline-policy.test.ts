/**
 * Tests for the pipeline-policy loader, tiny YAML parser, glob matcher,
 * and evaluator. Uses node:test + node:assert/strict to match the style of
 * the other tests in this directory.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseYaml,
  matchesGlob,
  evaluatePolicy,
  defaultPolicy,
  loadPolicy,
  BUILTIN_DEFAULT_POLICY,
} from '../pipeline-policy.js';
import type { PipelinePolicy } from '../pipeline-policy-types.js';

// ── Tiny YAML parser ─────────────────────────────────────────────────────

describe('parseYaml', () => {
  it('round-trips a simple nested doc with scalars, block arrays, and flow arrays', () => {
    const doc = `# comment line
version: 1.0.0
defaults:
  pauseAfter: [plan, review]
  autoApproveIfConfidence: 0.9
paths:
  - match: "**/auth/**"
    pauseAfter: [plan]
    reviewers: [security-team, compliance]
  - match: "**/*.md"
    autoApprove: true
`;
    const parsed = parseYaml(doc) as Record<string, unknown>;
    assert.equal(parsed.version, '1.0.0');
    const defaults = parsed.defaults as Record<string, unknown>;
    assert.deepEqual(defaults.pauseAfter, ['plan', 'review']);
    assert.equal(defaults.autoApproveIfConfidence, 0.9);
    const paths = parsed.paths as Array<Record<string, unknown>>;
    assert.equal(paths.length, 2);
    assert.equal(paths[0].match, '**/auth/**');
    assert.deepEqual(paths[0].pauseAfter, ['plan']);
    assert.deepEqual(paths[0].reviewers, ['security-team', 'compliance']);
    assert.equal(paths[1].match, '**/*.md');
    assert.equal(paths[1].autoApprove, true);
  });
});

// ── Glob matcher ─────────────────────────────────────────────────────────

describe('matchesGlob', () => {
  it('** matches any path segments', () => {
    assert.equal(matchesGlob('**/auth/**', 'packages/server/auth/login.ts'), true);
    assert.equal(matchesGlob('**/auth/**', 'auth/foo.ts'), true);
    assert.equal(matchesGlob('**/auth/**', 'packages/server/util.ts'), false);
  });
  it('* matches within a single segment', () => {
    assert.equal(matchesGlob('*.ts', 'index.ts'), true);
    assert.equal(matchesGlob('*.ts', 'src/index.ts'), false);
  });
  it('mixed ** and * works', () => {
    assert.equal(matchesGlob('src/*/index.ts', 'src/app/index.ts'), true);
    assert.equal(matchesGlob('src/*/index.ts', 'src/app/sub/index.ts'), false);
    assert.equal(matchesGlob('src/**/index.ts', 'src/app/sub/index.ts'), true);
  });
});

// ── evaluatePolicy ───────────────────────────────────────────────────────

function makePolicy(overrides: Partial<PipelinePolicy> = {}): PipelinePolicy {
  return {
    version: '1.0.0',
    defaults: {},
    paths: [],
    ...overrides,
  };
}

describe('evaluatePolicy', () => {
  it('pauses when a path rule matches at the given stage', () => {
    const policy = makePolicy({
      paths: [{ match: '**/auth/**', pauseAfter: ['plan', 'review'], reviewers: ['security'] }],
    });
    const decision = evaluatePolicy(policy, {
      stage: 'plan',
      touchedFiles: ['src/auth/login.ts'],
    });
    assert.equal(decision.pause, true);
    assert.ok(decision.matchedRules.includes('**/auth/**'));
    assert.deepEqual(decision.reviewers, ['security']);
  });

  it('autoApproveIfRisk=low skips the default pause when risk is low', () => {
    const policy = makePolicy({
      defaults: { pauseAfter: ['plan'], autoApproveIfRisk: 'low' },
    });
    const low = evaluatePolicy(policy, { stage: 'plan', touchedFiles: ['x.ts'], riskTier: 'low' });
    assert.equal(low.pause, false);
    assert.equal(low.reason, 'auto-approve-risk');

    const high = evaluatePolicy(policy, { stage: 'plan', touchedFiles: ['x.ts'], riskTier: 'high' });
    assert.equal(high.pause, true);
  });

  it('autoApproveIfConfidence only skips when confidence >= threshold', () => {
    const policy = makePolicy({
      defaults: { pauseAfter: ['plan'], autoApproveIfConfidence: 0.9 },
    });
    const over = evaluatePolicy(policy, { stage: 'plan', touchedFiles: ['x.ts'], confidence: 0.95 });
    assert.equal(over.pause, false);
    assert.equal(over.reason, 'auto-approve-confidence');

    const under = evaluatePolicy(policy, { stage: 'plan', touchedFiles: ['x.ts'], confidence: 0.5 });
    assert.equal(under.pause, true);

    const exact = evaluatePolicy(policy, { stage: 'plan', touchedFiles: ['x.ts'], confidence: 0.9 });
    assert.equal(exact.pause, false);
  });

  it('merges and dedupes reviewers across path rules and the reviewers[] block', () => {
    const policy = makePolicy({
      paths: [
        { match: '**/auth/**', reviewers: ['alice', 'bob'] },
        { match: '**/*.ts', reviewers: ['bob', 'carol'] },
      ],
      reviewers: [
        { match: '**/auth/**', users: ['carol', 'dave'] },
      ],
    });
    const decision = evaluatePolicy(policy, {
      stage: 'implement',
      touchedFiles: ['src/auth/login.ts'],
    });
    assert.deepEqual([...decision.reviewers].sort(), ['alice', 'bob', 'carol', 'dave']);
  });

  it('defaultPolicy pauses after plan and nothing else', () => {
    const policy = defaultPolicy();
    const planned = evaluatePolicy(policy, { stage: 'plan', touchedFiles: ['x.ts'] });
    // Builtin sets autoApproveIfRisk='low' + autoApproveIfConfidence=0.85 — without
    // a riskTier or confidence input the defaults still pause.
    assert.equal(planned.pause, true);
    const implemented = evaluatePolicy(policy, { stage: 'implement', touchedFiles: ['x.ts'] });
    assert.equal(implemented.pause, false);
  });

  it('returns disabled when policy.enabled === false', () => {
    const policy: PipelinePolicy = {
      version: '1.0.0',
      enabled: false,
      defaults: { pauseAfter: ['plan'] },
      paths: [{ match: '**/*.ts', pauseAfter: ['plan'] }],
    };
    const decision = evaluatePolicy(policy, { stage: 'plan', touchedFiles: ['src/x.ts'] });
    assert.equal(decision.pause, false);
    assert.equal(decision.reason, 'disabled');
  });

  it('still pauses when policy.enabled is true and stage is gated', () => {
    const policy: PipelinePolicy = {
      version: '1.0.0',
      enabled: true,
      defaults: { pauseAfter: ['plan'] },
      paths: [],
    };
    const decision = evaluatePolicy(policy, { stage: 'plan', touchedFiles: ['x.ts'] });
    assert.equal(decision.pause, true);
    assert.equal(decision.reason, 'defaults-pause');
  });
});

// ── loadPolicy: layering with builtin / yaml / overlay ───────────────────

describe('loadPolicy', () => {
  function makeHome(): string {
    return mkdtempSync(join(tmpdir(), 'anvil-policy-'));
  }
  function projectDir(home: string, slug: string): string {
    const dir = join(home, 'projects', slug);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  it('returns BUILTIN_DEFAULT_POLICY when no yaml or overlay exists', () => {
    const home = makeHome();
    try {
      const policy = loadPolicy('greenfield', home);
      assert.equal(policy.enabled, true);
      assert.deepEqual(policy.defaults.pauseAfter, ['plan']);
      assert.equal(policy.qa?.enabled, true);
      assert.equal(policy.qa?.maxQuestionsPerStage, 5);
      assert.equal(policy.cost?.onBreach, 'ask');
      assert.equal(policy.cost?.limits?.perRun, 10.00);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('yaml file overrides the builtin', () => {
    const home = makeHome();
    try {
      const dir = projectDir(home, 'with-yaml');
      writeFileSync(join(dir, 'pipeline-policy.yaml'),
        'version: 1.0.0\ndefaults:\n  pauseAfter: [plan, implement]\n', 'utf-8');
      const policy = loadPolicy('with-yaml', home);
      assert.deepEqual(policy.defaults.pauseAfter, ['plan', 'implement']);
      // Yaml without explicit `enabled` still defaults to on.
      assert.equal(policy.enabled, true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('overlay layers on top of the builtin', () => {
    const home = makeHome();
    try {
      const dir = projectDir(home, 'overlay-only');
      writeFileSync(join(dir, 'pipeline-policy.overlay.json'),
        JSON.stringify({ enabled: false, cost: { limits: { perRun: 50 } } }), 'utf-8');
      const policy = loadPolicy('overlay-only', home);
      assert.equal(policy.enabled, false);
      assert.equal(policy.cost?.limits?.perRun, 50);
      // Builtin's default still flows through for unset overlay fields.
      assert.equal(policy.cost?.onBreach, 'ask');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('overlay layers on top of yaml (overlay wins for shared fields)', () => {
    const home = makeHome();
    try {
      const dir = projectDir(home, 'yaml-and-overlay');
      writeFileSync(join(dir, 'pipeline-policy.yaml'),
        'version: 1.0.0\ndefaults:\n  pauseAfter: [plan]\n', 'utf-8');
      writeFileSync(join(dir, 'pipeline-policy.overlay.json'),
        JSON.stringify({ defaults: { pauseAfter: ['plan', 'implement'] } }), 'utf-8');
      const policy = loadPolicy('yaml-and-overlay', home);
      assert.deepEqual(policy.defaults.pauseAfter, ['plan', 'implement']);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('malformed overlay is ignored, base policy survives', () => {
    const home = makeHome();
    try {
      const dir = projectDir(home, 'bad-overlay');
      writeFileSync(join(dir, 'pipeline-policy.overlay.json'), '{not json', 'utf-8');
      const policy = loadPolicy('bad-overlay', home);
      assert.equal(policy.enabled, true);
      assert.deepEqual(policy.defaults.pauseAfter, BUILTIN_DEFAULT_POLICY.defaults.pauseAfter);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
