/**
 * plan-to-artifacts smoke test — exercises the v2 renderer + the v1→v2
 * migration path (test fixtures are written in v1 shape and threaded
 * through `migratePlanJsonToV2` to keep the fixture human-readable).
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
import { migratePlanJsonToV2 } from '../plan/migrate.js';

const samplePlan = (): Plan =>
  migratePlanJsonToV2({
    version: 3,
    slug: 'add-login',
    project: 'app',
    title: 'Add login flow',
    feature: 'Add login flow',
    model: 'claude-opus-4-7',
    createdAt: '2026-04-29T00:00:00.000Z',
    updatedAt: '2026-04-29T00:30:00.000Z',
    problem: {
      statement:
        'Users currently land on a blank screen with no auth path. This blocks every paying customer from accessing their account.',
      why_now: 'Pilot launch is next Tuesday and onboarding fails without login.',
      success_signals: ['Bounce rate on / drops below 30%'],
    },
    scope: {
      inScope: [
        { id: 's1', description: 'login form', acceptance: ['User submits credentials → cookie set'] },
        { id: 's2', description: 'session cookie', acceptance: ['Cookie expires in 24h'] },
      ],
      outOfScope: [{ id: 'o1', description: 'SSO', acceptance: [] }],
    },
    repos: [
      {
        name: 'web',
        changes: 'Add /login route + form component',
        mustTouch: [
          { path: 'src/routes/login.tsx', kind: 'new', reason: 'Login route' },
          { path: 'src/components/LoginForm.tsx', kind: 'new', reason: 'Form component' },
        ],
        symbols: [
          { file: 'src/components/LoginForm.tsx', name: 'LoginForm', kind: 'function' },
          { file: 'src/routes/login.tsx', name: 'submitLogin', kind: 'function' },
        ],
      },
      {
        name: 'api',
        changes: 'POST /v1/login + session middleware',
        mustTouch: [
          { path: 'src/routes/login.ts', kind: 'new', reason: 'Login handler' },
          { path: 'src/middleware/session.ts', kind: 'new', reason: 'Session middleware' },
        ],
        symbols: [
          { file: 'src/routes/login.ts', name: 'handleLogin', kind: 'function' },
          { file: 'src/middleware/session.ts', name: 'requireSession', kind: 'function' },
        ],
      },
    ],
    contracts: [
      {
        kind: 'http',
        method: 'POST',
        path: '/v1/login',
        producer: 'api',
        consumers: ['web'],
        status: [200, 401],
      },
    ],
    data: [],
    observability: { signals: [] },
    architecture: { mermaid: 'graph TD; web --> api;', notes: 'Cookie-based session.' },
    risks: [
      {
        id: 'r1',
        title: 'CSRF',
        severity: 'med',
        blastRadius: 'auth-bypass',
        mitigation: 'Same-site cookie + origin check',
        detection: 'Spike in 403s',
      },
    ],
    rollout: {
      strategy: 'feature-flag',
      flags: ['login_v1'],
      order: ['api', 'web'],
      rollback: { command: 'Disable flag', verify: 'curl /login → 200' },
    },
    tests: {
      unit: [
        {
          id: 'u1',
          acceptanceRef: 's1',
          file: 'src/components/LoginForm.test.tsx',
          name: 'TestLoginFormValidation',
          given: 'A user types invalid email',
          when: 'submit is pressed',
          then: 'inline error appears',
        },
      ],
      integration: [
        {
          id: 'i1',
          acceptanceRef: 's2',
          file: 'tests/login.integration.ts',
          name: 'TestLoginSetsCookie',
          given: 'a clean session',
          when: 'POST /v1/login with valid creds',
          then: 'response sets session cookie',
        },
      ],
      manual: [{ id: 'm1', description: 'log in via UI', expected: 'redirect to /' }],
    },
    estimate: { usd: 3, minutes: 90, prs: 2, calibratedFrom: [] },
  });

describe('plan-to-artifacts', () => {
  describe('renderRequirements', () => {
    it('includes title, version, problem, scope', () => {
      const md = renderRequirements(samplePlan());
      assert.match(md, /# Requirements — Add login flow/);
      assert.match(md, /Plan v3/);
      assert.match(md, /## Problem/);
      assert.match(md, /Users currently land/);
      assert.match(md, /\*\*In scope:\*\*/);
      assert.match(md, /login form/);
      assert.match(md, /SSO/);
    });
  });

  describe('renderRepoRequirements', () => {
    it('renders the named repo + its contract surface', () => {
      const md = renderRepoRequirements(samplePlan(), 'web');
      assert.match(md, /web/);
      assert.match(md, /login\.tsx/);
      // web is a consumer of POST /v1/login → contract surface included
      assert.match(md, /POST/);
      assert.match(md, /\/v1\/login/);
    });

    it('omits unrelated contracts the repo neither produces nor consumes', () => {
      const plan = samplePlan();
      plan.contracts.push({
        kind: 'kafka',
        topic: 'metrics.events',
        producer: 'unrelated',
        consumers: ['monitoring'],
        schemaRef: 'metrics.v1',
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
