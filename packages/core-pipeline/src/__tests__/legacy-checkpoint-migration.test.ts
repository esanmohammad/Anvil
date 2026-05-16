/**
 * Phase J — legacy checkpoint migration smoke test.
 *
 * Verifies `migrateLegacyCheckpoint(featureDir)` translates the
 * historic `pipeline-state.json` shape into a payload usable as
 * `CheckpointSnapshot.shared`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  migrateLegacyCheckpoint,
  type LegacyPipelineCheckpoint,
} from '../hooks/legacy-checkpoint-migration.js';

describe('migrateLegacyCheckpoint (Phase J)', () => {
  it('returns null when pipeline-state.json is absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cp-migrate-'));
    assert.equal(migrateLegacyCheckpoint(dir), null);
  });

  it('returns null when version mismatches', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cp-migrate-'));
    writeFileSync(join(dir, 'pipeline-state.json'), JSON.stringify({ version: 99 }), 'utf-8');
    assert.equal(migrateLegacyCheckpoint(dir), null);
  });

  it('returns null on malformed JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cp-migrate-'));
    writeFileSync(join(dir, 'pipeline-state.json'), 'not-json', 'utf-8');
    assert.equal(migrateLegacyCheckpoint(dir), null);
  });

  it('translates a v1 checkpoint into the migrated shape', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cp-migrate-'));
    const legacy: LegacyPipelineCheckpoint = {
      version: 1,
      runId: 'run-7',
      project: 'app',
      feature: 'Add login',
      featureSlug: 'add-login',
      status: 'failed',
      currentStage: 4,
      stages: [
        {
          name: 'specs', label: 'Specs', status: 'completed', cost: 0.012,
          error: null,
          repos: [{ repoName: 'web', status: 'completed', cost: 0.012, error: null }],
        },
      ],
      repoNames: ['web'],
      totalCost: 0.034,
      startedAt: '2026-04-29T00:00:00.000Z',
      updatedAt: '2026-04-29T00:05:00.000Z',
      config: { model: 'claude-opus-4-7' },
    };
    writeFileSync(join(dir, 'pipeline-state.json'), JSON.stringify(legacy), 'utf-8');
    const migrated = migrateLegacyCheckpoint(dir);
    assert.ok(migrated, 'migration returned a payload');
    assert.equal(migrated!.runId, 'run-7');
    assert.equal(migrated!.featureSlug, 'add-login');
    assert.equal(migrated!.status, 'failed');
    assert.equal(migrated!.totalCost, 0.034);
    assert.equal(migrated!.stages.length, 1);
    assert.equal(migrated!.stages[0].name, 'specs');
    assert.equal(migrated!.config?.model, 'claude-opus-4-7');
  });
});
