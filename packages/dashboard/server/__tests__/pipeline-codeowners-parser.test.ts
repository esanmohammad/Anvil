/**
 * Tests for the CODEOWNERS parser and matcher.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseCodeowners,
  findOwners,
  matchPattern,
  resolveGroups,
} from '../pipeline-codeowners-parser.js';
import type { ReviewerGroup } from '../pipeline-reviewers-types.js';

describe('parseCodeowners', () => {
  it('parses a simple file, ignoring comments and blank lines', () => {
    const text = [
      '# top comment',
      '',
      '*           @global-owner',
      '/src/api/   @api-team @alice  # trailing comment',
      'docs/       @docs-team',
    ].join('\n');
    const rules = parseCodeowners(text);
    assert.equal(rules.length, 3);
    assert.equal(rules[0]!.pattern, '*');
    assert.deepEqual(rules[0]!.owners, ['@global-owner']);
    assert.equal(rules[1]!.pattern, '/src/api/');
    assert.deepEqual(rules[1]!.owners, ['@api-team', '@alice']);
    assert.equal(rules[2]!.pattern, 'docs/');
  });

  it('skips lines with pattern but no owners', () => {
    const rules = parseCodeowners('/src/lonely/\n');
    assert.equal(rules.length, 0);
  });
});

describe('matchPattern glob handling', () => {
  it('* matches any non-slash chars', () => {
    assert.equal(matchPattern('*.ts', 'foo.ts'), true);
    assert.equal(matchPattern('*.ts', 'dir/foo.ts'), true);
    assert.equal(matchPattern('/*.ts', 'dir/foo.ts'), false);
  });

  it('** matches across directory boundaries', () => {
    assert.equal(matchPattern('src/**/*.ts', 'src/a/b/c.ts'), true);
    assert.equal(matchPattern('src/**', 'src/a/b/c.ts'), true);
  });

  it('trailing / matches everything under the directory', () => {
    assert.equal(matchPattern('docs/', 'docs/readme.md'), true);
    assert.equal(matchPattern('docs/', 'docs/sub/x.md'), true);
    assert.equal(matchPattern('docs/', 'src/docs/x.md'), true);
    assert.equal(matchPattern('/docs/', 'src/docs/x.md'), false);
  });

  it('leading / anchors to repo root', () => {
    assert.equal(matchPattern('/README.md', 'README.md'), true);
    assert.equal(matchPattern('/README.md', 'docs/README.md'), false);
  });
});

describe('findOwners reverse priority', () => {
  it('last matching rule wins', () => {
    const rules = parseCodeowners([
      '*                @fallback',
      '/src/            @core-team',
      '/src/security/   @security-team',
    ].join('\n'));

    assert.deepEqual(findOwners(rules, 'README.md'), ['@fallback']);
    assert.deepEqual(findOwners(rules, 'src/app.ts'), ['@core-team']);
    assert.deepEqual(
      findOwners(rules, 'src/security/auth.ts'),
      ['@security-team'],
    );
  });

  it('returns [] when nothing matches', () => {
    const rules = parseCodeowners('/src/  @core');
    assert.deepEqual(findOwners(rules, 'docs/x.md'), []);
  });
});

describe('resolveGroups', () => {
  const groups: ReviewerGroup[] = [
    { tag: '@security-team', users: ['@alice', '@bob'] },
    { tag: '@docs-team', users: ['@carol'] },
  ];

  it('expands group tags into member users', () => {
    const resolved = resolveGroups(['@security-team'], groups);
    assert.deepEqual(resolved, ['@alice', '@bob']);
  });

  it('passes through individual users and dedupes', () => {
    const resolved = resolveGroups(
      ['@alice', '@security-team', '@dan'],
      groups,
    );
    assert.deepEqual(resolved, ['@alice', '@bob', '@dan']);
  });

  it('preserves order of first occurrence', () => {
    const resolved = resolveGroups(
      ['@docs-team', '@security-team', '@docs-team'],
      groups,
    );
    assert.deepEqual(resolved, ['@carol', '@alice', '@bob']);
  });
});
