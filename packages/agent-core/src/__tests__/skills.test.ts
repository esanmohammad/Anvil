/**
 * Phase 1 — skills loader unit tests.
 *
 * Covers ADR Phase 1 acceptance:
 *   1. parseSkillMarkdown handles required + optional + kebab-case keys
 *   2. parseSkillMarkdown rejects malformed input
 *   3. loadSkills logs+skips broken SKILL.md files (non-fatal)
 *   4. activateSkills respects byte budget (alphabetical order)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { parseSkillMarkdown } from '../skills/parser.js';
import { loadSkills } from '../skills/loader.js';
import { activateSkills } from '../skills/activator.js';
import type { Skill } from '../skills/types.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'anvil-skills-test-'));
}

function writeSkill(root: string, name: string, raw: string): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), raw);
}

describe('parseSkillMarkdown', () => {
  it('parses required fields + kebab-case allowed-tools + version', () => {
    const raw = [
      '---',
      'name: pr-summary',
      'description: Summarize a pull request from its diff.',
      'allowed-tools:',
      '  - fs.read',
      '  - shell.run',
      'version: 1.0.0',
      '---',
      '',
      '# Body',
      'Always greet first.',
    ].join('\n');

    const { frontmatter, body } = parseSkillMarkdown(raw);
    assert.equal(frontmatter.name, 'pr-summary');
    assert.equal(frontmatter.description, 'Summarize a pull request from its diff.');
    assert.deepEqual(frontmatter.allowedTools, ['fs.read', 'shell.run']);
    assert.equal(frontmatter.version, '1.0.0');
    assert.equal(frontmatter.disableModelInvocation, undefined);
    assert.ok(body.startsWith('# Body'));
  });

  it('accepts camelCase frontmatter keys interchangeably', () => {
    const raw = [
      '---',
      'name: greeter',
      'description: greets',
      'allowedTools: ["fs.read"]',
      'disableModelInvocation: true',
      '---',
      'body',
    ].join('\n');

    const { frontmatter } = parseSkillMarkdown(raw);
    assert.deepEqual(frontmatter.allowedTools, ['fs.read']);
    assert.equal(frontmatter.disableModelInvocation, true);
  });

  it('throws on missing frontmatter', () => {
    assert.throws(() => parseSkillMarkdown('# just markdown\nno frontmatter'), /missing frontmatter/);
  });

  it('throws on missing required `name`', () => {
    const raw = '---\ndescription: x\n---\nbody';
    assert.throws(() => parseSkillMarkdown(raw), /missing required `name`/);
  });

  it('throws on missing required `description`', () => {
    const raw = '---\nname: x\n---\nbody';
    assert.throws(() => parseSkillMarkdown(raw), /missing required `description`/);
  });
});

describe('loadSkills', () => {
  it('returns empty array when dir does not exist', () => {
    assert.deepEqual(loadSkills({ dir: '/nonexistent/path/does/not/exist' }), []);
  });

  it('loads valid skills and skips broken ones (non-fatal)', () => {
    const root = tempDir();
    try {
      writeSkill(root, 'good', '---\nname: good\ndescription: works\n---\nbody A');
      writeSkill(root, 'broken', 'no frontmatter at all');
      writeSkill(root, 'also-good', '---\nname: also-good\ndescription: works\n---\nbody B');

      // Suppress stderr WARN noise from the broken-skill skip
      const origWrite = process.stderr.write.bind(process.stderr);
      const captured: string[] = [];
      (process.stderr as { write: typeof origWrite }).write = (chunk: string | Uint8Array) => {
        captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
        return true;
      };

      let skills: Skill[];
      try {
        skills = loadSkills({ dir: root });
      } finally {
        (process.stderr as { write: typeof origWrite }).write = origWrite;
      }

      const names = skills.map((s) => s.frontmatter.name).sort();
      assert.deepEqual(names, ['also-good', 'good']);
      assert.ok(captured.some((c) => c.includes('skipping') && c.includes('broken')));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('captures sibling resources alongside SKILL.md', () => {
    const root = tempDir();
    try {
      const dir = join(root, 'with-resources');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'SKILL.md'), '---\nname: r\ndescription: d\n---\nbody');
      writeFileSync(join(dir, 'helper.sh'), '#!/bin/sh\necho hi\n');
      writeFileSync(join(dir, 'template.md'), 'tpl');

      const skills = loadSkills({ dir: root });
      assert.equal(skills.length, 1);
      assert.deepEqual([...skills[0].resources].sort(), ['helper.sh', 'template.md']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('activateSkills', () => {
  function fakeSkill(name: string, body: string): Skill {
    return {
      path: `/fake/${name}/SKILL.md`,
      frontmatter: { name, description: 'd' },
      body,
      resources: [],
    };
  }

  it('returns all skills when total fits the budget, sorted by name', () => {
    const a = fakeSkill('zebra', 'z'.repeat(100));
    const b = fakeSkill('apple', 'a'.repeat(100));
    const r = activateSkills([a, b], 1024);
    assert.equal(r.skills.length, 2);
    assert.deepEqual(
      r.skills.map((s) => s.frontmatter.name),
      ['apple', 'zebra'],
    );
    assert.equal(r.totalBytes, 200);
    assert.equal(r.truncated, 0);
  });

  it('drops skills that would exceed the budget; reports truncated', () => {
    const big = fakeSkill('big', 'x'.repeat(900));
    const small = fakeSkill('aa-small', 'y'.repeat(100));
    const r = activateSkills([big, small], 1000);
    // alphabetical: 'aa-small' (100) fits, then 'big' (900) makes 1000 — fits exactly
    assert.equal(r.totalBytes, 1000);
    assert.equal(r.truncated, 0);

    const r2 = activateSkills([big, small], 999);
    // 'aa-small' (100) fits; 'big' (900) would make 1000 > 999, dropped
    assert.equal(r2.skills.length, 1);
    assert.equal(r2.skills[0].frontmatter.name, 'aa-small');
    assert.equal(r2.totalBytes, 100);
    assert.equal(r2.truncated, 1);
  });

  it('handles empty input', () => {
    const r = activateSkills([]);
    assert.deepEqual(r, { skills: [], totalBytes: 0, truncated: 0 });
  });
});
