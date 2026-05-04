/**
 * Code-fact drift detection (Phase 6 — ADR §M7).
 *
 * Memories that mention code carry `codeBinding: { filePath, structuralHash,
 * lastSeenCommitSha, lastVerifiedAt }`. On retrieval (or via the
 * `verifyCodeBindings` sleeptime sweep), we re-read the bound file from disk,
 * recompute its structural hash, and report whether the memory is still
 * fresh, structurally drifted, or pointing at a missing file.
 *
 * The structural hasher comes from `@anvil/knowledge-core` so we don't
 * duplicate its canonicalization logic.
 */

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { computeStructuralHash } from '@anvil/knowledge-core';
import type { CodeFactBinding } from '../types.js';
import { detectLanguageFromPath } from './language.js';

export type DriftStatus = 'fresh' | 'drifted' | 'missing';

export interface DriftCheckResult {
  status: DriftStatus;
  /** The structural hash that was just recomputed (if the file existed). */
  currentHash?: string;
}

export interface DriftCheckOptions {
  /** Workspace root used when `binding.filePath` is relative. */
  workspaceRoot: string;
  /** Override the auto-detected tree-sitter language. */
  language?: string;
}

/**
 * Compare a `CodeFactBinding` against the current state of the workspace.
 * Pure function: never mutates the binding or anything else.
 */
export function checkCodeBindingDrift(
  binding: CodeFactBinding,
  opts: DriftCheckOptions,
): DriftCheckResult {
  const fullPath = isAbsolute(binding.filePath)
    ? binding.filePath
    : join(opts.workspaceRoot, binding.filePath);

  if (!existsSync(fullPath)) {
    return { status: 'missing' };
  }

  const content = readFileSync(fullPath, 'utf8');
  const language = opts.language ?? detectLanguageFromPath(binding.filePath);
  const { hash } = computeStructuralHash(content, language);

  return {
    status: hash === binding.structuralHash ? 'fresh' : 'drifted',
    currentHash: hash,
  };
}
