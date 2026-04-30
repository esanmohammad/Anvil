/**
 * Checkpoint key + path helpers.
 *
 * `computeFingerprint` produces a stable sha256 hex digest of any JSON-ish
 * value. Object keys are sorted recursively so ordering differences are
 * irrelevant. `undefined` is omitted entirely (matches `JSON.stringify`
 * semantics for object values). Functions / Dates are serialized via
 * `.toString()` so they have deterministic fingerprints.
 *
 * `computeKey` concatenates the fingerprints of every field from a
 * CheckpointInputs into a single byte-stable string and sha256's it.
 */

import { createHash } from 'node:crypto';
import { join } from 'node:path';

import type {
  CheckpointInputs,
  CheckpointKey,
  CheckpointStage,
} from './types.js';

// ── Stable JSON serialization ────────────────────────────────────────────

function stableStringify(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';

  const t = typeof value;
  if (t === 'string') return JSON.stringify(value);
  if (t === 'number') {
    // Handle -0, NaN, Infinity explicitly (JSON.stringify renders them as null).
    if (Number.isNaN(value as number)) return '"__NaN__"';
    if (!Number.isFinite(value as number)) {
      return (value as number) > 0 ? '"__Infinity__"' : '"__-Infinity__"';
    }
    return JSON.stringify(value);
  }
  if (t === 'boolean') return JSON.stringify(value);
  if (t === 'bigint') return `"bigint:${(value as bigint).toString()}"`;
  if (t === 'function') return JSON.stringify(`[function:${(value as Function).toString()}]`);

  if (value instanceof Date) return JSON.stringify(`[date:${value.toISOString()}]`);

  if (Array.isArray(value)) {
    const parts = value.map((v) => stableStringify(v));
    return `[${parts.join(',')}]`;
  }

  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    // Include Symbol-typed keys? No — our inputs are plain JSON. Skip them.
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const k of keys) {
      const v = obj[k];
      if (v === undefined) continue;
      parts.push(`${JSON.stringify(k)}:${stableStringify(v)}`);
    }
    return `{${parts.join(',')}}`;
  }

  return JSON.stringify(String(value));
}

/** sha256 hex digest of a stable JSON serialization of `value`. */
export function computeFingerprint(value: unknown): string {
  const serialized = stableStringify(value);
  return createHash('sha256').update(serialized).digest('hex');
}

// ── Checkpoint key computation ───────────────────────────────────────────

/**
 * Produce a CheckpointKey from inputs. The hash is deterministic: same
 * inputs → same hash, any drift in any tracked field → different hash.
 */
export function computeKey(
  runFamily: string,
  inputs: CheckpointInputs,
): CheckpointKey {
  const parts = [
    `runFamily:${runFamily}`,
    `stage:${inputs.stage}`,
    `taskId:${inputs.taskId}`,
    `promptVersion:${computeFingerprint(inputs.promptVersion)}`,
    `model:${computeFingerprint(inputs.model ?? null)}`,
    `toolVersions:${computeFingerprint(inputs.toolVersions ?? {})}`,
    `inputs:${computeFingerprint(inputs.inputs)}`,
  ];
  const combined = parts.join('|');
  const hash = createHash('sha256').update(combined).digest('hex');
  return { hash, runFamily, stage: inputs.stage, taskId: inputs.taskId };
}

// ── Filesystem layout ────────────────────────────────────────────────────

/**
 * Per-record path:
 *   <anvilHome>/checkpoints/<project>/<runFamily>/<stage>/<hash>.json
 */
export function checkpointPath(
  anvilHome: string,
  project: string,
  runFamily: string,
  stage: CheckpointStage,
  hash: string,
): string {
  return join(
    anvilHome,
    'checkpoints',
    project,
    runFamily,
    stage,
    `${hash}.json`,
  );
}

/**
 * Content-addressed blob path:
 *   <anvilHome>/checkpoints/_blobs/<sha[0:2]>/<sha>
 *
 * Fanning out by the first two hex chars keeps directory sizes reasonable
 * (max 256 sub-dirs, each holding ~N/256 blobs). Mirrors git's objects
 * layout.
 */
export function blobPath(anvilHome: string, sha: string): string {
  const prefix = sha.slice(0, 2);
  return join(anvilHome, 'checkpoints', '_blobs', prefix, sha);
}

/** Root directory for all checkpoint state in a given Anvil home. */
export function checkpointRoot(anvilHome: string): string {
  return join(anvilHome, 'checkpoints');
}

/** Root directory for content-addressed blobs. */
export function blobRoot(anvilHome: string): string {
  return join(anvilHome, 'checkpoints', '_blobs');
}
