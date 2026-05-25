/**
 * Validation tests for `parseFeatureScope`. Every failure mode must
 * return `null` so the caller falls back to "all repos run."
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseFeatureScope } from '../stages/parse-scope.js';

const REPOS = ['backend', 'frontend'];

function withFence(json: string): string {
  return `# Requirements\n\nSome prose here.\n\n\`\`\`json\n${json}\n\`\`\`\n`;
}

describe('parseFeatureScope', () => {
  it('returns null when no fenced json block present', () => {
    assert.equal(parseFeatureScope('# Requirements\n\nNo fence.', REPOS), null);
  });

  it('returns null on JSON parse error', () => {
    assert.equal(parseFeatureScope(withFence('{ not json'), REPOS), null);
  });

  it('returns null when targetRepos missing', () => {
    assert.equal(parseFeatureScope(withFence('{"rationale": "x"}'), REPOS), null);
  });

  it('returns null when targetRepos empty', () => {
    assert.equal(parseFeatureScope(withFence('{"targetRepos": [], "rationale": "x"}'), REPOS), null);
  });

  it('returns null when targetRepos contains unknown repo', () => {
    assert.equal(
      parseFeatureScope(withFence('{"targetRepos": ["mobile"], "rationale": "x"}'), REPOS),
      null,
    );
  });

  it('returns null on case mismatch (Frontend != frontend)', () => {
    assert.equal(
      parseFeatureScope(withFence('{"targetRepos": ["Frontend"], "rationale": "x"}'), REPOS),
      null,
    );
  });

  it('returns null when targetRepos equals availableRepos (no real scoping)', () => {
    assert.equal(
      parseFeatureScope(
        withFence('{"targetRepos": ["backend", "frontend"], "rationale": "all needed"}'),
        REPOS,
      ),
      null,
    );
  });

  it('returns null when rationale missing', () => {
    assert.equal(parseFeatureScope(withFence('{"targetRepos": ["frontend"]}'), REPOS), null);
  });

  it('returns null when rationale empty', () => {
    assert.equal(
      parseFeatureScope(withFence('{"targetRepos": ["frontend"], "rationale": "   "}'), REPOS),
      null,
    );
  });

  it('returns null when rationale exceeds 500 chars', () => {
    const long = 'x'.repeat(501);
    assert.equal(
      parseFeatureScope(withFence(`{"targetRepos": ["frontend"], "rationale": "${long}"}`), REPOS),
      null,
    );
  });

  it('returns valid scope when fenced block parses + validates', () => {
    const scope = parseFeatureScope(
      withFence('{"targetRepos": ["frontend"], "rationale": "Pure UI change"}'),
      REPOS,
    );
    assert.deepEqual(scope, { targetRepos: ['frontend'], rationale: 'Pure UI change' });
  });

  it('uses the LAST fenced json block when multiple are present', () => {
    const body = `${withFence('{"targetRepos": ["mobile"], "rationale": "ignore me"}')}
\n
Now the real scope:
${withFence('{"targetRepos": ["backend"], "rationale": "API only"}')}`;
    const scope = parseFeatureScope(body, REPOS);
    assert.deepEqual(scope, { targetRepos: ['backend'], rationale: 'API only' });
  });

  it('de-dupes repeated entries while preserving order', () => {
    const scope = parseFeatureScope(
      withFence('{"targetRepos": ["frontend", "frontend"], "rationale": "FE only"}'),
      REPOS,
    );
    assert.deepEqual(scope, { targetRepos: ['frontend'], rationale: 'FE only' });
  });

  it('returns null when availableRepos is empty', () => {
    assert.equal(
      parseFeatureScope(withFence('{"targetRepos": ["frontend"], "rationale": "x"}'), []),
      null,
    );
  });

  it('returns null when artifact is empty', () => {
    assert.equal(parseFeatureScope('', REPOS), null);
  });

  it('returns null when targetRepos contains a non-string entry', () => {
    assert.equal(
      parseFeatureScope(withFence('{"targetRepos": [123], "rationale": "x"}'), REPOS),
      null,
    );
  });

  it('returns null when rationale is not a string', () => {
    assert.equal(
      parseFeatureScope(withFence('{"targetRepos": ["frontend"], "rationale": 42}'), REPOS),
      null,
    );
  });

  it('trims the rationale of leading/trailing whitespace', () => {
    const scope = parseFeatureScope(
      withFence('{"targetRepos": ["frontend"], "rationale": "   FE only   "}'),
      REPOS,
    );
    assert.deepEqual(scope, { targetRepos: ['frontend'], rationale: 'FE only' });
  });
});
