/**
 * Tests for the pipeline-policy loader, tiny YAML parser, glob matcher,
 * and evaluator. Uses node:test + node:assert/strict to match the style of
 * the other tests in this directory.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseYaml,
  matchesGlob,
  evaluatePolicy,
  defaultPolicy,
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
    assert.equal(planned.pause, true);
    const implemented = evaluatePolicy(policy, { stage: 'implement', touchedFiles: ['x.ts'] });
    assert.equal(implemented.pause, false);
  });
});
