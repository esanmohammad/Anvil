/**
 * bound-tests-webhook — HMAC-verified GitHub `pull_request` webhook handler
 * that emits regression-guard annotations. HTTP wiring lives in the caller.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';

import {
  buildBoundAnnotations,
  type BoundAnnotation,
  type PRDiffHunk,
} from './bound-tests-annotator.js';
import type { BoundTestsStore } from './bound-tests.js';
import { readOrCreateSecret } from './incident-webhooks.js';

// ── Public types ─────────────────────────────────────────────────────────

export type GithubPrAction =
  | 'opened'
  | 'synchronize'
  | 'reopened'
  | 'closed'
  | 'edited'
  | 'labeled'
  | 'unlabeled'
  | 'assigned'
  | 'unassigned'
  | 'review_requested'
  | 'review_request_removed'
  | 'ready_for_review'
  | 'converted_to_draft';

export interface HandlePrDeps {
  boundStore: BoundTestsStore;
  project: string;
  getPRDiffHunks: (prUrl: string) => PRDiffHunk[];
  postAnnotations: (
    prUrl: string,
    annotations: BoundAnnotation[],
  ) => Promise<void>;
}

export type PrWebhookStatus =
  | 'ignored-action'
  | 'invalid-payload'
  | 'no-bound-files'
  | 'annotated';

export interface PrWebhookResult {
  status: PrWebhookStatus;
  annotations: BoundAnnotation[];
  prUrl?: string;
  action?: GithubPrAction;
}

// ── Signature verification ───────────────────────────────────────────────

/**
 * Verify a GitHub `X-Hub-Signature-256` header. The header format is
 * `sha256=<hex>`. Comparison is timing-safe.
 */
export function verifyGithubSignature(
  body: string,
  sig: string | undefined,
  secret: string,
): boolean {
  if (typeof sig !== 'string' || sig.length === 0) return false;
  const cleaned = sig.trim();
  const match = cleaned.match(/^sha256=([0-9a-f]+)$/i);
  if (!match) return false;
  const providedHex = match[1];
  if (providedHex.length % 2 !== 0) return false;

  let providedBuf: Buffer;
  try {
    providedBuf = Buffer.from(providedHex, 'hex');
  } catch {
    return false;
  }

  const expected = createHmac('sha256', secret)
    .update(body, 'utf-8')
    .digest();
  if (providedBuf.length !== expected.length) return false;
  return timingSafeEqual(providedBuf, expected);
}

/** Resolve the default path for the GitHub webhook secret. */
export function resolveGithubWebhookSecretPath(anvilHome: string): string {
  return join(anvilHome, 'secrets', 'github-webhook-secret');
}

/** Convenience — read (or create) the default GitHub webhook secret. */
export function readGithubWebhookSecret(anvilHome: string): string {
  return readOrCreateSecret(resolveGithubWebhookSecretPath(anvilHome));
}

// ── Payload handler ──────────────────────────────────────────────────────

const ACTIVE_ACTIONS: ReadonlySet<GithubPrAction> = new Set<GithubPrAction>([
  'opened',
  'synchronize',
  'reopened',
]);

/**
 * Run the annotation flow for an already-verified GitHub `pull_request`
 * payload. Only `opened`, `synchronize`, and `reopened` actions trigger work;
 * everything else short-circuits with `status: 'ignored-action'`.
 */
export async function handleGithubPullRequestPayload(
  payload: unknown,
  deps: HandlePrDeps,
): Promise<PrWebhookResult> {
  const parsed = parsePayload(payload);
  if (!parsed) {
    return { status: 'invalid-payload', annotations: [] };
  }
  if (!ACTIVE_ACTIONS.has(parsed.action)) {
    return {
      status: 'ignored-action',
      annotations: [],
      prUrl: parsed.prUrl,
      action: parsed.action,
    };
  }

  const hunks = deps.getPRDiffHunks(parsed.prUrl);
  const annotations = buildBoundAnnotations(
    deps.boundStore,
    deps.project,
    hunks,
  );
  if (annotations.length === 0) {
    return {
      status: 'no-bound-files',
      annotations: [],
      prUrl: parsed.prUrl,
      action: parsed.action,
    };
  }

  await deps.postAnnotations(parsed.prUrl, annotations);
  return {
    status: 'annotated',
    annotations,
    prUrl: parsed.prUrl,
    action: parsed.action,
  };
}

// ── Internals ────────────────────────────────────────────────────────────

interface NormalizedPrPayload {
  action: GithubPrAction;
  prUrl: string;
}

function parsePayload(raw: unknown): NormalizedPrPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const action = typeof obj.action === 'string' ? (obj.action as GithubPrAction) : null;
  if (!action) return null;

  const pr = obj.pull_request;
  if (!pr || typeof pr !== 'object') return null;
  const prObj = pr as Record<string, unknown>;
  const htmlUrl = typeof prObj.html_url === 'string' ? prObj.html_url : undefined;
  if (!htmlUrl) return null;

  return { action, prUrl: htmlUrl };
}
