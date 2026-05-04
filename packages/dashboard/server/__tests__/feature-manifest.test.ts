/**
 * Tests for FeatureManifestStore + renderManifestForPrompt + extractors.
 *
 * Covers the round-trip lifecycle a stage hits: fresh empty manifest,
 * patchField bumps writtenBy/writtenAt, render output reflects status, and
 * the deterministic extractors recognise the headings personas produce.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { FeatureStore } from '../feature-store.js';
import {
  emptyManifest,
  FeatureManifestStore,
  renderManifestForPrompt,
  FEATURE_MANIFEST_VERSION,
} from '../feature-manifest.js';
import {
  extractAcceptanceCriteria,
  extractAffectedRepos,
  extractApiEndpoints,
  extractFilesPlanned,
  extractTestBehaviors,
  extractChangeBrief,
  extractOpenQuestions,
} from '../feature-manifest-extractors.js';
import type {
  ApiEndpoint,
  PlannedFile,
  TestBehavior,
} from '../feature-manifest.js';

const PROJECT = 'demo';
const FEATURE = 'add login';

function setup(): { home: string; store: FeatureManifestStore; slug: string } {
  const home = mkdtempSync(join(tmpdir(), 'anvil-manifest-'));
  const featureStore = new FeatureStore(home);
  const record = featureStore.createFeature(PROJECT, FEATURE, 'claude-sonnet-4-6');
  return { home, store: new FeatureManifestStore(featureStore), slug: record.slug };
}

describe('FeatureManifestStore', () => {
  let home: string;
  let store: FeatureManifestStore;
  let slug: string;

  beforeEach(() => {
    const ctx = setup();
    home = ctx.home;
    store = ctx.store;
    slug = ctx.slug;
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('emptyManifest sets version + unset fields', () => {
    const m = emptyManifest(PROJECT, slug, FEATURE);
    assert.equal(m.version, FEATURE_MANIFEST_VERSION);
    assert.equal(m.acceptanceCriteria.status, 'unset');
    assert.equal(m.acceptanceCriteria.value, null);
    assert.equal(m.affectedRepos.status, 'unset');
    assert.equal(m.changeBrief.status, 'unset');
  });

  it('ensure() creates a manifest on disk and is idempotent', () => {
    const a = store.ensure(PROJECT, slug, FEATURE);
    const path = join(home, 'features', PROJECT, slug, 'manifest.json');
    assert.ok(existsSync(path), 'manifest.json should exist after ensure');
    const b = store.ensure(PROJECT, slug, FEATURE);
    // ensure() returns the existing record verbatim — createdAt is preserved.
    assert.equal(a.createdAt, b.createdAt);
  });

  it('patchField writes status, value, writer, timestamp', () => {
    store.ensure(PROJECT, slug, FEATURE);
    const m = store.patchField(
      PROJECT, slug, 'acceptanceCriteria', 'final',
      ['User can sign in with email', 'Failed logins show an error toast'],
      'requirements',
    );
    assert.equal(m.acceptanceCriteria.status, 'final');
    assert.deepEqual(m.acceptanceCriteria.value, [
      'User can sign in with email',
      'Failed logins show an error toast',
    ]);
    assert.equal(m.acceptanceCriteria.writtenBy, 'requirements');
    assert.ok(m.acceptanceCriteria.writtenAt);

    // Re-read from disk to confirm persistence.
    const round = store.read(PROJECT, slug)!;
    assert.deepEqual(round.acceptanceCriteria.value, m.acceptanceCriteria.value);
  });

  it('patchField on fresh manifest creates one without throwing', () => {
    // No ensure() — patchField should still work (creates manifest).
    store.patchField(
      PROJECT, slug, 'changeBrief', 'final',
      'Adds login flow', 'build',
    );
    const m = store.read(PROJECT, slug)!;
    assert.equal(m.changeBrief.status, 'final');
    assert.equal(m.changeBrief.value, 'Adds login flow');
  });

  it('round-trip survives JSON serialization', () => {
    store.ensure(PROJECT, slug, FEATURE);
    store.patchField(
      PROJECT, slug, 'apiEndpoints', 'final',
      [{ repo: 'api', method: 'POST', path: '/v1/login', purpose: 'authenticate' }],
      'specs',
    );
    const path = join(home, 'features', PROJECT, slug, 'manifest.json');
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    assert.equal(raw.apiEndpoints.value[0].method, 'POST');
    assert.equal(raw.apiEndpoints.value[0].path, '/v1/login');
  });
});

describe('renderManifestForPrompt', () => {
  it('returns empty string for null manifest', () => {
    assert.equal(renderManifestForPrompt(null), '');
  });

  it('returns empty string for fully unset manifest', () => {
    const m = emptyManifest(PROJECT, 'add-login', FEATURE);
    assert.equal(renderManifestForPrompt(m), '');
  });

  it('renders final and unset fields with status labels', () => {
    const m = emptyManifest(PROJECT, 'add-login', FEATURE);
    m.acceptanceCriteria = {
      status: 'final',
      value: ['User can sign in', 'Bad password shows error'],
      writtenBy: 'requirements',
      writtenAt: '2026-04-28T00:00:00.000Z',
    };
    const text = renderManifestForPrompt(m);
    assert.match(text, /Feature manifest \(v1\)/);
    assert.match(text, /Acceptance criteria \[final, by requirements\]/);
    assert.match(text, /User can sign in/);
    assert.match(text, /Affected repos: <unset>/);
  });
});

describe('manifest extractors', () => {
  it('extractAcceptanceCriteria parses ## Acceptance Criteria bullets', () => {
    const md = `# Requirements\n\n## Acceptance Criteria\n- User can sign in with email\n- Bad password shows toast\n- Lockout after 5 failures\n`;
    const out = extractAcceptanceCriteria(md);
    assert.ok(out);
    assert.equal(out!.field, 'acceptanceCriteria');
    assert.equal(out!.status, 'final');
    assert.deepEqual(out!.value, [
      'User can sign in with email',
      'Bad password shows toast',
      'Lockout after 5 failures',
    ]);
  });

  it('extractAffectedRepos pulls names from Repositories section', () => {
    const md = `## Repositories\n- api\n- web\n- shared-lib\n`;
    const out = extractAffectedRepos(md);
    assert.ok(out);
    assert.deepEqual(out!.value, ['api', 'web', 'shared-lib']);
  });

  it('extractApiEndpoints parses METHOD path patterns', () => {
    const md = `## API Endpoints\n- POST /v1/login — authenticate user\n- GET /v1/me — return current user\n`;
    const out = extractApiEndpoints(md);
    assert.ok(out);
    const endpoints = out!.value as ApiEndpoint[];
    assert.equal(endpoints.length, 2);
    assert.equal(endpoints[0].method, 'POST');
    assert.equal(endpoints[0].path, '/v1/login');
    assert.match(endpoints[0].purpose, /authenticate/);
  });

  it('extractFilesPlanned picks up paths in task bullets', () => {
    const md = `## Tasks\n- Modify api/handlers/login.go\n- Create web/src/pages/Login.tsx\n- Update shared/auth/types.ts\n`;
    const out = extractFilesPlanned(md);
    assert.ok(out);
    const files = out!.value as PlannedFile[];
    const paths = files.map((f) => f.path);
    assert.ok(paths.includes('api/handlers/login.go'));
    assert.ok(paths.includes('web/src/pages/Login.tsx'));
    assert.ok(paths.includes('shared/auth/types.ts'));
  });

  it('extractTestBehaviors recognises Gherkin and plain bullets', () => {
    const md = `## Test Behaviors\n- Given valid credentials, when user submits, then redirect to /dashboard\n- Plain bullet without gherkin\n`;
    const out = extractTestBehaviors(md);
    assert.ok(out);
    const behaviors = out!.value as TestBehavior[];
    assert.equal(behaviors.length, 2);
    assert.ok(behaviors[0].gherkin);
    assert.ok(!behaviors[1].gherkin);
  });

  it('extractChangeBrief uses Summary section first', () => {
    const md = `## Summary\nAdded login endpoint and React form. Updated middleware.\n\n## Files\n- foo.go\n`;
    const out = extractChangeBrief(md);
    assert.ok(out);
    assert.match(out!.value as string, /Added login endpoint/);
  });

  it('extractOpenQuestions returns null when section missing', () => {
    const md = `## Summary\nNothing of note.\n`;
    assert.equal(extractOpenQuestions(md), null);
  });

  it('extractAcceptanceCriteria returns null when no headings match', () => {
    assert.equal(extractAcceptanceCriteria('plain text without sections'), null);
  });
});
