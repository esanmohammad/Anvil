/**
 * Phase S5 — resource limit translation + detection tests.
 *
 * Pure module: no docker spawning. Covers:
 *   - dockerRunLimitArgs flag emission for memory / cpus / pids / disk.
 *   - detectLimitKill classification of exit codes + stderr patterns.
 *   - parseDockerStatsLine snapshot parsing.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  dockerRunLimitArgs,
  detectLimitKill,
  parseDockerStatsLine,
} from '../sandbox/resource-limits.js';

describe('dockerRunLimitArgs', () => {
  it('emits --memory + --memory-swap when memoryMiB is set', () => {
    const args = dockerRunLimitArgs({ memoryMiB: 4096 });
    assert.deepEqual(args, ['--memory', '4096m', '--memory-swap', '4096m']);
  });

  it('emits --cpus + --pids-limit + --storage-opt when fields set', () => {
    const args = dockerRunLimitArgs({ cpus: 2, pids: 1024, diskMiB: 8192 });
    assert.ok(args.includes('--cpus'));
    assert.equal(args[args.indexOf('--cpus') + 1], '2');
    assert.ok(args.includes('--pids-limit'));
    assert.equal(args[args.indexOf('--pids-limit') + 1], '1024');
    assert.ok(args.includes('--storage-opt'));
    assert.equal(args[args.indexOf('--storage-opt') + 1], 'size=8192m');
  });

  it('emits no flags when limits are undefined / zero', () => {
    assert.deepEqual(dockerRunLimitArgs(undefined), []);
    assert.deepEqual(dockerRunLimitArgs({}), []);
    assert.deepEqual(dockerRunLimitArgs({ memoryMiB: 0, cpus: 0, pids: 0, diskMiB: 0 }), []);
  });

  it('combines all four caps into one argv', () => {
    const args = dockerRunLimitArgs({ memoryMiB: 1024, cpus: 1, pids: 256, diskMiB: 1024 });
    // memory adds a paired memory-swap → 5 flag/value pairs total.
    assert.equal(args.length, 10);
    assert.ok(args.includes('--memory'));
    assert.ok(args.includes('--memory-swap'));
    assert.ok(args.includes('--cpus'));
    assert.ok(args.includes('--pids-limit'));
    assert.ok(args.includes('--storage-opt'));
  });
});

describe('detectLimitKill', () => {
  it('flags oomKilled=true as `oom`', () => {
    assert.equal(detectLimitKill({ exitCode: 137, stderr: '', oomKilled: true }), 'oom');
  });

  it('classifies exit 137 (SIGKILL) without OOM flag as `oom`', () => {
    assert.equal(detectLimitKill({ exitCode: 137, stderr: '' }), 'oom');
  });

  it('classifies signal=SIGKILL as `oom`', () => {
    assert.equal(detectLimitKill({ exitCode: null, signal: 'SIGKILL', stderr: '' }), 'oom');
  });

  it('classifies fork EAGAIN stderr as `pid`', () => {
    assert.equal(detectLimitKill({
      exitCode: 1, stderr: 'fork: Resource temporarily unavailable',
    }), 'pid');
  });

  it('classifies clone EAGAIN stderr as `pid`', () => {
    assert.equal(detectLimitKill({
      exitCode: 1, stderr: 'clone: Resource temporarily unavailable',
    }), 'pid');
  });

  it('classifies "No space left on device" as `disk`', () => {
    assert.equal(detectLimitKill({
      exitCode: 1, stderr: 'tar: write error: No space left on device',
    }), 'disk');
  });

  it('returns undefined for an ordinary non-zero exit', () => {
    assert.equal(detectLimitKill({ exitCode: 1, stderr: 'something failed' }), undefined);
  });
});

describe('parseDockerStatsLine', () => {
  it('parses MiB / GiB memory + cpu% + pid count', () => {
    const snap = parseDockerStatsLine('512MiB / 4GiB | 12.34% | 8', { memoryMiB: 4096, pids: 1024 });
    assert.equal(snap.memoryUsedMiB, 512);
    assert.equal(snap.memoryCapMiB, 4096);
    assert.equal(snap.cpuPercent, 12.34);
    assert.equal(snap.pidsUsed, 8);
    assert.equal(snap.pidsCap, 1024);
    assert.match(snap.capturedAt, /T/);
  });

  it('handles GiB units in memory column', () => {
    const snap = parseDockerStatsLine('1.5GiB / 4GiB | 5.0% | 2', { memoryMiB: 4096 });
    assert.equal(snap.memoryUsedMiB, 1536);
  });

  it('handles missing fields gracefully', () => {
    const snap = parseDockerStatsLine('', {});
    assert.equal(snap.memoryUsedMiB, 0);
    assert.equal(snap.cpuPercent, 0);
    assert.equal(snap.pidsUsed, 0);
  });
});
