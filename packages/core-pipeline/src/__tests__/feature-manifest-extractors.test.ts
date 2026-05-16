/**
 * Phase F12 — feature-manifest-extractors smoke test.
 *
 * Promoted from packages/dashboard/server/feature-manifest-extractors.ts
 * into core-pipeline/utils. The dashboard's existing feature-manifest
 * test still covers the FeatureManifestStore round-trip; this new
 * core-pipeline suite focuses on the extractor regex contracts so the
 * heading conventions can't silently regress when personas evolve.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractAcceptanceCriteria,
  extractAffectedRepos,
  extractApiEndpoints,
  extractTablesTouched,
  extractFilesPlanned,
  extractTestBehaviors,
  extractChangeBrief,
  extractOpenQuestions,
} from '../utils/feature-manifest-extractors.js';

describe('feature-manifest-extractors (Phase F12)', () => {
  it('extractAcceptanceCriteria pulls bullets under the heading', () => {
    const md = '# Title\n## Acceptance Criteria\n- User can log in\n- Session persists\n## Other\nstuff';
    const result = extractAcceptanceCriteria(md);
    assert.ok(result, 'finds the section');
    assert.equal(result!.field, 'acceptanceCriteria');
    assert.deepEqual(result!.value, ['User can log in', 'Session persists']);
  });

  it('extractAcceptanceCriteria returns null when missing', () => {
    const md = '# Title\nNo criteria here';
    assert.equal(extractAcceptanceCriteria(md), null);
  });

  it('extractAffectedRepos parses repo list', () => {
    const md = '## Affected Repos\n- web\n- api';
    const result = extractAffectedRepos(md);
    assert.ok(result);
    assert.deepEqual(result!.value, ['web', 'api']);
  });

  it('extractApiEndpoints parses METHOD /path lines with repo prefix', () => {
    const md = '## API Endpoints\n- [api] POST /v1/login — auth\n- [api] GET /v1/me — current user';
    const result = extractApiEndpoints(md);
    assert.ok(result);
    assert.equal(result!.field, 'apiEndpoints');
    const endpoints = result!.value as Array<{ repo: string; method: string; path: string }>;
    assert.equal(endpoints.length, 2);
    assert.equal(endpoints[0].method, 'POST');
    assert.equal(endpoints[0].path, '/v1/login');
  });

  it('extractTablesTouched parses verb + table name', () => {
    const md = '## Tables Touched\n- ALTER `users` to add session_id\n- ADD `sessions` for cookie state';
    const result = extractTablesTouched(md);
    assert.ok(result);
    const tables = result!.value as Array<{ repo: string; table: string; mutationKind: string }>;
    assert.equal(tables.length, 2);
    assert.equal(tables[0].mutationKind, 'alter');
    assert.equal(tables[0].table, 'users');
    assert.equal(tables[1].mutationKind, 'add');
    assert.equal(tables[1].table, 'sessions');
  });

  it('extractFilesPlanned parses path-like bullets', () => {
    const md = '## Files\n- create src/login.tsx\n- modify src/middleware/session.ts';
    const result = extractFilesPlanned(md);
    assert.ok(result);
    const files = result!.value as Array<{ path: string; kind: string }>;
    assert.equal(files.length, 2);
    assert.equal(files[0].path, 'src/login.tsx');
    assert.equal(files[0].kind, 'create');
    assert.equal(files[1].kind, 'modify');
  });

  it('extractTestBehaviors parses behavior list', () => {
    const md = '## Test Behaviors\n- User can submit valid login → cookie set\n- Invalid creds → 401';
    const result = extractTestBehaviors(md);
    assert.ok(result);
    const behaviors = result!.value as Array<{ description: string }>;
    assert.equal(behaviors.length, 2);
  });

  it('extractChangeBrief reads the brief paragraph', () => {
    const md = '## Change Brief\nAdd cookie-based auth across web + api.\n## Next';
    const result = extractChangeBrief(md);
    assert.ok(result);
    assert.match(String(result!.value), /cookie-based auth/);
  });

  it('extractOpenQuestions pulls bullets', () => {
    const md = '## Open Questions\n- How long does the session live?\n- 2FA in scope?';
    const result = extractOpenQuestions(md);
    assert.ok(result);
    assert.deepEqual(result!.value, [
      'How long does the session live?',
      '2FA in scope?',
    ]);
  });
});
