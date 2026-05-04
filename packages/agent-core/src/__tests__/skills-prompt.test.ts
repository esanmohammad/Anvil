/**
 * Phase 2 — skills → system prompt integration tests.
 *
 * Covers the four acceptance items from plan §2.6:
 *   1. resolveSkillsDir follows the documented search order
 *   2. Rendered skills appear at the "## Available Skills" anchor
 *   3. applyToolPolicy enforces caller ∩ skill-union intersection
 *   4. composeSkillContext respects the activator byte budget
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { renderSkillsForPrompt, SKILLS_PROMPT_HEADER } from '../skills/render.js';
import { resolveSkillsDir } from '../skills/resolve-dir.js';
import { applyToolPolicy } from '../skills/tool-policy.js';
import { composeSkillContext } from '../skills/compose.js';
import type { Skill } from '../skills/types.js';
import type { ActivatedSkills } from '../skills/activator.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'anvil-skills-prompt-test-'));
}

function fakeSkill(name: string, body: string, allowedTools?: string[]): Skill {
  return {
    path: `/fake/${name}/SKILL.md`,
    frontmatter: { name, description: `${name} desc`, allowedTools },
    body,
    resources: [],
  };
}

function writeSkill(root: string, name: string, raw: string): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), raw);
}

// ── renderSkillsForPrompt ────────────────────────────────────────────────

describe('renderSkillsForPrompt', () => {
  it('returns empty string for no activated skills', () => {
    const empty: ActivatedSkills = { skills: [], totalBytes: 0, truncated: 0 };
    assert.equal(renderSkillsForPrompt(empty), '');
  });

  it('emits header + per-skill section in order', () => {
    const skills = [fakeSkill('alpha', 'A body'), fakeSkill('beta', 'B body')];
    const out = renderSkillsForPrompt({ skills, totalBytes: 12, truncated: 0 });
    assert.ok(out.startsWith(SKILLS_PROMPT_HEADER));
    assert.ok(out.includes('### alpha'));
    assert.ok(out.includes('### beta'));
    assert.ok(out.indexOf('### alpha') < out.indexOf('### beta'));
    assert.ok(out.includes('A body'));
    assert.ok(out.includes('B body'));
  });
});

// ── resolveSkillsDir ─────────────────────────────────────────────────────

describe('resolveSkillsDir', () => {
  it('returns undefined when nothing exists', () => {
    const fakeHome = '/nonexistent/home/path/xyz';
    const result = resolveSkillsDir({
      workspaceRoot: '/nonexistent/workspace',
      env: {},
      homeDir: fakeHome,
    });
    assert.equal(result, undefined);
  });

  it('honors ANVIL_SKILLS_DIR override (rank 1)', () => {
    const root = tempDir();
    try {
      const override = join(root, 'override-skills');
      mkdirSync(override, { recursive: true });
      const ws = join(root, 'workspace');
      mkdirSync(join(ws, '.claude', 'skills'), { recursive: true });
      const home = join(root, 'home');
      mkdirSync(join(home, '.claude', 'skills'), { recursive: true });

      const result = resolveSkillsDir({
        workspaceRoot: ws,
        env: { ANVIL_SKILLS_DIR: override },
        homeDir: home,
      });
      assert.equal(result, override);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls through to <workspace>/.claude/skills (rank 2) when no override', () => {
    const root = tempDir();
    try {
      const ws = join(root, 'workspace');
      const wsSkills = join(ws, '.claude', 'skills');
      mkdirSync(wsSkills, { recursive: true });
      const home = join(root, 'home');
      mkdirSync(join(home, '.claude', 'skills'), { recursive: true });

      const result = resolveSkillsDir({
        workspaceRoot: ws,
        env: {},
        homeDir: home,
      });
      assert.equal(result, wsSkills);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls through to $HOME/.claude/skills (rank 3) when workspace dir absent', () => {
    const root = tempDir();
    try {
      const ws = join(root, 'workspace');
      mkdirSync(ws, { recursive: true });
      const home = join(root, 'home');
      const homeSkills = join(home, '.claude', 'skills');
      mkdirSync(homeSkills, { recursive: true });

      const result = resolveSkillsDir({
        workspaceRoot: ws,
        env: {},
        homeDir: home,
      });
      assert.equal(result, homeSkills);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── applyToolPolicy ──────────────────────────────────────────────────────

describe('applyToolPolicy', () => {
  it('passes caller through unchanged when no skill declares allowed-tools', () => {
    const skills = [fakeSkill('s1', 'b'), fakeSkill('s2', 'b')];
    const r = applyToolPolicy(['fs.read', 'shell.run'], skills);
    assert.deepEqual(r.allowedTools, ['fs.read', 'shell.run']);
    assert.equal(r.constrained, false);
  });

  it('intersects caller with union of skill constraints', () => {
    const skills = [
      fakeSkill('s1', 'b', ['fs.read', 'shell.run']),
      fakeSkill('s2', 'b', ['shell.run', 'net.fetch']),
    ];
    const r = applyToolPolicy(['fs.read', 'shell.run', 'fs.write'], skills);
    assert.deepEqual(r.allowedTools, ['fs.read', 'shell.run']);
    assert.equal(r.constrained, true);
  });

  it('returns skill-union as-is when caller has no policy ("any")', () => {
    const skills = [fakeSkill('s1', 'b', ['fs.read', 'shell.run'])];
    const r = applyToolPolicy(undefined, skills);
    assert.deepEqual(r.allowedTools, ['fs.read', 'shell.run']);
    assert.equal(r.constrained, true);
  });

  it('returns empty intersection when caller and skills disjoint', () => {
    const skills = [fakeSkill('s1', 'b', ['only.skill.tool'])];
    const r = applyToolPolicy(['only.caller.tool'], skills);
    assert.deepEqual(r.allowedTools, []);
    assert.equal(r.constrained, true);
  });
});

// ── composeSkillContext (end-to-end) ─────────────────────────────────────

describe('composeSkillContext', () => {
  it('returns base prompt unchanged when no skills found', () => {
    const r = composeSkillContext('be helpful', {
      workspaceRoot: '/nonexistent/workspace',
      env: {},
      homeDir: '/nonexistent/home',
    });
    assert.equal(r.systemPrompt, 'be helpful');
    assert.equal(r.allowedTools, undefined);
    assert.equal(r.toolsConstrained, false);
    assert.equal(r.resolvedDir, undefined);
    assert.equal(r.activated.skills.length, 0);
  });

  it('appends "## Available Skills" block + reconciles tool policy', () => {
    const root = tempDir();
    try {
      writeSkill(
        root,
        'pr-summary',
        '---\nname: pr-summary\ndescription: Summarize a PR.\nallowed-tools:\n  - fs.read\n  - shell.run\n---\nBody A.',
      );
      writeSkill(
        root,
        'reviewer',
        '---\nname: reviewer\ndescription: Review code.\nallowed-tools:\n  - fs.read\n---\nBody B.',
      );

      const r = composeSkillContext('You are a coding agent.', {
        skillsDir: root,
        allowedTools: ['fs.read', 'shell.run', 'fs.write'],
      });

      assert.ok(r.systemPrompt.startsWith('You are a coding agent.\n\n'));
      assert.ok(r.systemPrompt.includes(SKILLS_PROMPT_HEADER));
      assert.ok(r.systemPrompt.includes('### pr-summary'));
      assert.ok(r.systemPrompt.includes('### reviewer'));
      // allowed-tools intersection: caller={fs.read,shell.run,fs.write} ∩ skills={fs.read,shell.run}
      assert.deepEqual(r.allowedTools, ['fs.read', 'shell.run']);
      assert.equal(r.toolsConstrained, true);
      assert.equal(r.resolvedDir, root);
      assert.equal(r.activated.skills.length, 2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('respects activator byte budget end-to-end', () => {
    const root = tempDir();
    try {
      const big = 'x'.repeat(900);
      writeSkill(root, 'aa-small', `---\nname: aa-small\ndescription: tiny\n---\n${'y'.repeat(50)}`);
      writeSkill(root, 'big', `---\nname: big\ndescription: huge\n---\n${big}`);

      const r = composeSkillContext('base', { skillsDir: root, maxBytes: 200 });
      // Alphabetical: 'aa-small' (50 bytes) fits; 'big' (900) skipped.
      assert.equal(r.activated.skills.length, 1);
      assert.equal(r.activated.skills[0].frontmatter.name, 'aa-small');
      assert.equal(r.activated.truncated, 1);
      assert.ok(!r.systemPrompt.includes('### big'));
      assert.ok(r.systemPrompt.includes('### aa-small'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
