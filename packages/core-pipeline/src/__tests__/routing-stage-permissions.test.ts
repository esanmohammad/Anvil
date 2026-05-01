/**
 * Tests for stage-permissions: every canonical stage has a known set,
 * unknown stages fail closed (read-only), and the resolver returns a
 * deduped sorted list of tool names.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  STAGE_TOOL_PERMISSIONS,
  allowedToolsForStage,
  permissionClassesForStage,
} from '../routing/stage-permissions.js';

const READ_ONLY = ['glob', 'grep', 'list', 'read_file'];
const FULL = ['bash', 'edit', 'glob', 'grep', 'list', 'read_file', 'write_file'];

describe('STAGE_TOOL_PERMISSIONS — canonical pipeline stages', () => {
  it('clarify is read-only', () => {
    assert.deepEqual(STAGE_TOOL_PERMISSIONS.clarify, ['read']);
  });
  it('analysis stages (requirements/specs/tasks) are read-only', () => {
    assert.deepEqual(STAGE_TOOL_PERMISSIONS.requirements, ['read']);
    assert.deepEqual(STAGE_TOOL_PERMISSIONS['project-requirements'], ['read']);
    assert.deepEqual(STAGE_TOOL_PERMISSIONS.specs, ['read']);
    assert.deepEqual(STAGE_TOOL_PERMISSIONS.tasks, ['read']);
  });
  it('implementation stages (build/validate/ship) are full read+write+exec', () => {
    assert.deepEqual(STAGE_TOOL_PERMISSIONS.build, ['read', 'write', 'exec']);
    assert.deepEqual(STAGE_TOOL_PERMISSIONS.validate, ['read', 'write', 'exec']);
    assert.deepEqual(STAGE_TOOL_PERMISSIONS.ship, ['read', 'write', 'exec']);
  });
});

describe('STAGE_TOOL_PERMISSIONS — ad-hoc commands', () => {
  it('fix and fix-loop are full', () => {
    assert.deepEqual(STAGE_TOOL_PERMISSIONS.fix, ['read', 'write', 'exec']);
    assert.deepEqual(STAGE_TOOL_PERMISSIONS['fix-loop'], ['read', 'write', 'exec']);
  });
  it('review, research, plan are read-only', () => {
    assert.deepEqual(STAGE_TOOL_PERMISSIONS.review, ['read']);
    assert.deepEqual(STAGE_TOOL_PERMISSIONS.research, ['read']);
    assert.deepEqual(STAGE_TOOL_PERMISSIONS.plan, ['read']);
  });
});

describe('allowedToolsForStage', () => {
  it('returns deduped sorted tool list for read-only stages', () => {
    assert.deepEqual(allowedToolsForStage('clarify'), READ_ONLY);
    assert.deepEqual(allowedToolsForStage('research'), READ_ONLY);
  });
  it('returns full set for build', () => {
    assert.deepEqual(allowedToolsForStage('build'), FULL);
  });
  it('falls back to read-only for unknown stage (fail-closed)', () => {
    assert.deepEqual(allowedToolsForStage('not-a-real-stage'), READ_ONLY);
  });
});

describe('permissionClassesForStage', () => {
  it('returns the class list for known stages', () => {
    assert.deepEqual(permissionClassesForStage('build'), ['read', 'write', 'exec']);
    assert.deepEqual(permissionClassesForStage('research'), ['read']);
  });
  it('falls back to read for unknown stages', () => {
    assert.deepEqual(permissionClassesForStage('eldritch-stage'), ['read']);
  });
  it('returns a fresh array (caller can mutate)', () => {
    const a = permissionClassesForStage('build');
    a.push('read');
    const b = permissionClassesForStage('build');
    assert.deepEqual(b, ['read', 'write', 'exec']);
  });
});
