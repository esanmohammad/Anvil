/**
 * Phase F8 — plan-to-artifacts smoke test.
 *
 * Promoted from packages/dashboard/server/plan-to-artifacts.ts. No prior
 * test existed. Pins the renderer shapes (REQUIREMENTS / SPECS / TASKS)
 * and the coverage predicates so future edits to the markdown layout
 * can't silently regress the planSeed → artifact derivation path.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderRequirements,
  renderRepoRequirements,
  renderRepoSpecs,
  renderRepoTasks,
  planCoversRepo,
  planCoversStagesForRepo,
  planCoversCrossRepo,
  summarisePlanSkip,
} from '../utils/plan-to-artifacts.js';
import type { Plan } from '../utils/plan-types.js';

const samplePlan = (): Plan => ({
  version: 3,
  slug: 'add-login',
  project: 'app',
  title: 'Add login flow',
  problem: 'Users currently land on a blank screen with no auth path.',
  scope: { inScope: ['login form', 'session cookie'], outOfScope: ['SSO'] },
  repos: [
    {
      name: 'web',
      changes: 'Add /login route + form component',
      files: ['src/routes/login.tsx', 'src/components/LoginForm.tsx'],
      symbols: ['LoginForm', 'submitLogin'],
    },
    {
      name: 'api',
      changes: 'POST /v1/login + session middleware',
      files: ['src/routes/login.ts', 'src/middleware/session.ts'],
      symbols: ['handleLogin', 'requireSession'],
    },
  ],
  contracts: [
    {
      kind: 'http',
      name: 'POST /v1/login',
      producer: 'api',
      consumers: ['web'],
      description: 'Auth endpoint',
    },
  ],
  architecture: { mermaid: 'graph TD; web --> api;', notes: 'Cookie-based session.' },
  risks: [{ title: 'CSRF', mitigation: 'Same-site cookie + origin check', severity: 'med' }],
  rollout: {
    strategy: 'Behind FF',
    flags: ['login_v1'],
    order: ['api', 'web'],
    rollback: 'Disable flag.',
  },
  tests: { unit: ['LoginForm validation'], integration: ['login → cookie set'], manual: ['log in via UI'] },
  estimate: { usd: 3, minutes: 90, prs: 2 },
  model: 'claude-opus-4-7',
  feature: 'Add login flow',
  createdAt: '2026-04-29T00:00:00.000Z',
  updatedAt: '2026-04-29T00:30:00.000Z',
});

describe('plan-to-artifacts (Phase F8)', () => {
  describe('renderRequirements', () => {
    it('includes title, version, problem, scope', () => {
      const md = renderRequirements(samplePlan());
      assert.match(md, /# Requirements — Add login flow/);
      assert.match(md, /Plan v3/);
      assert.match(md, /## Problem/);
      assert.match(md, /Users currently land/);
      assert.match(md, /\*\*In scope:\*\*/);
      assert.match(md, /- login form/);
      assert.match(md, /- SSO/);
    });
  });

  describe('renderRepoRequirements', () => {
    it('renders the named repo + its contract surface', () => {
      const md = renderRepoRequirements(samplePlan(), 'web');
      assert.match(md, /web/);
      assert.match(md, /\/login route/);
      // web is a consumer of POST /v1/login → contract surface included
      assert.match(md, /POST \/v1\/login/);
    });

    it('omits unrelated contracts the repo neither produces nor consumes', () => {
      const plan = samplePlan();
      plan.contracts.push({
        kind: 'kafka',
        name: 'metrics.events',
        producer: 'unrelated',
        consumers: ['monitoring'],
        description: 'Internal telemetry topic.',
      });
      const md = renderRepoRequirements(plan, 'web');
      assert.doesNotMatch(md, /metrics\.events/);
    });
  });

  describe('renderRepoSpecs', () => {
    it('lists files + symbols for the repo', () => {
      const md = renderRepoSpecs(samplePlan(), 'api');
      assert.match(md, /handleLogin/);
      assert.match(md, /src\/middleware\/session\.ts/);
    });
  });

  describe('renderRepoTasks', () => {
    it('produces a task list for the repo', () => {
      const md = renderRepoTasks(samplePlan(), 'web');
      assert.match(md, /web/);
      assert.match(md, /LoginForm/);
    });
  });

  describe('planCoversRepo / Stages / CrossRepo', () => {
    it('returns true for repos in plan.repos', () => {
      assert.equal(planCoversRepo(samplePlan(), 'web'), true);
      assert.equal(planCoversRepo(samplePlan(), 'web'), true);
    });

    it('returns false for unknown repos', () => {
      assert.equal(planCoversRepo(samplePlan(), 'unknown'), false);
    });

    it('planCoversStagesForRepo flags coverage', () => {
      const result = planCoversStagesForRepo(samplePlan(), 'web');
      assert.ok(typeof result === 'object');
    });

    it('planCoversCrossRepo flags coverage', () => {
      const result = planCoversCrossRepo(samplePlan());
      assert.ok(typeof result === 'object');
    });
  });

  describe('summarisePlanSkip', () => {
    it('summarises which repos are/are not covered', () => {
      const summary = summarisePlanSkip(samplePlan(), ['web', 'api', 'unknown']);
      assert.match(summary, /web/);
      assert.match(summary, /api/);
    });
  });
});
