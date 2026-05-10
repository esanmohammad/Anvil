/**
 * Durable wrappers for sandbox boundary crossings — Phase S6.
 *
 * Each `acquire/exec/write/edit/read/sync/snapshot/close` call against
 * a SandboxHandle becomes a `ctx.effect(...)` recording on the durable
 * log. On replay (post-G1 takeover) the recorded result returns
 * instantly; the actual sandbox call doesn't fire again.
 *
 * The wrappers are OPTIONAL. Call sites that don't have a `StepContext`
 * get the raw, non-durable behavior — same idiom as
 * `tools/effect-wrapping.ts` for web tools.
 *
 * State-hash determinism (§I.3): `wrapSandboxExec` accepts an optional
 * `sandboxStateHash` builder that hashes the workdir before the call;
 * the hash is woven into the idempotency key so a different starting
 * state produces a different recorded answer.
 */

import type { StepContext } from '../types.js';
import { contentHash } from '../durable/effect-helpers.js';
import type {
  SandboxExecArgs,
  SandboxExecResult,
  SandboxHandle,
  SandboxSyncResult,
} from './types.js';

export interface DurableSandboxOptions {
  /** Soft timeout (ms). */
  timeoutMs?: number;
}

/** Build the canonical effect name for a sandbox boundary crossing. */
export function sandboxEffectName(
  op: 'acquire' | 'exec' | 'read' | 'write' | 'edit' | 'sync' | 'snapshot' | 'close' | 'limit-breach',
  runId: string,
  stage: string,
  suffix?: string,
): string {
  const base = `sandbox:${op}:${runId}:${stage}`;
  return suffix ? `${base}:${suffix}` : base;
}

/**
 * Wrap a sandbox `exec` in `ctx.effect`. The idempotency key folds in
 * the runId + stage + a content-hash of (command + sandboxStateHash).
 * Same command + same starting state = same recorded answer.
 *
 * The optional `sandboxStateHash` callback is invoked at most once;
 * if you don't supply it, replay still works but is not bounded by
 * input state — pass `effect.deterministic: false` in those cases by
 * not supplying the hash.
 */
export async function wrapSandboxExec(
  ctx: StepContext<unknown> | undefined,
  args: { runId: string; stage: string; idx: number; sandboxStateHash?: () => Promise<string> },
  execArgs: SandboxExecArgs,
  fn: () => Promise<SandboxExecResult>,
  opts: DurableSandboxOptions = {},
): Promise<SandboxExecResult> {
  if (!ctx || typeof ctx.effect !== 'function') {
    return fn();
  }
  const stateHash = args.sandboxStateHash ? await args.sandboxStateHash() : '';
  const keySrc = JSON.stringify({
    cmd: execArgs.command,
    cwd: execArgs.cwd ?? null,
    env: execArgs.env ?? null,
    stdin: typeof execArgs.stdin === 'string' ? execArgs.stdin : execArgs.stdin ? 'binary' : null,
    state: stateHash,
  });
  const idempotencyKey = `${args.runId}:${args.stage}:exec:${args.idx}:${contentHash(keySrc)}`;
  const name = sandboxEffectName('exec', args.runId, args.stage, `${args.idx}:${contentHash(keySrc)}`);
  return ctx.effect(name, fn, {
    idempotencyKey,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
}

/** Wrap acquire — keyed on (runId, stage, image, limitsHash). */
export async function wrapSandboxAcquire(
  ctx: StepContext<unknown> | undefined,
  args: { runId: string; stage: string; image: string; limitsHash: string },
  fn: () => Promise<SandboxHandle>,
): Promise<SandboxHandle> {
  if (!ctx || typeof ctx.effect !== 'function') return fn();
  const idempotencyKey = `${args.runId}:${args.stage}:acquire:${contentHash(`${args.image}|${args.limitsHash}`)}`;
  const name = sandboxEffectName('acquire', args.runId, args.stage);
  return ctx.effect(name, fn, { idempotencyKey });
}

/** Wrap write — keyed on (runId, stage, path, contentHash(content)). */
export async function wrapSandboxWrite(
  ctx: StepContext<unknown> | undefined,
  args: { runId: string; stage: string; idx: number; path: string },
  content: string | Buffer,
  fn: () => Promise<void>,
): Promise<void> {
  if (!ctx || typeof ctx.effect !== 'function') return fn();
  const body = typeof content === 'string' ? content : content.toString('base64');
  const idempotencyKey = `${args.runId}:${args.stage}:write:${args.idx}:${contentHash(`${args.path}|${body}`)}`;
  const name = sandboxEffectName('write', args.runId, args.stage, `${args.idx}:${contentHash(args.path)}`);
  return ctx.effect(name, fn, { idempotencyKey });
}

/** Wrap edit — keyed on (runId, stage, path, contentHash(oldString+newString)). */
export async function wrapSandboxEdit(
  ctx: StepContext<unknown> | undefined,
  args: { runId: string; stage: string; idx: number; path: string; oldString: string; newString: string },
  fn: () => Promise<void>,
): Promise<void> {
  if (!ctx || typeof ctx.effect !== 'function') return fn();
  const idempotencyKey =
    `${args.runId}:${args.stage}:edit:${args.idx}:${contentHash(`${args.path}|${args.oldString}|${args.newString}`)}`;
  const name = sandboxEffectName('edit', args.runId, args.stage, `${args.idx}:${contentHash(args.path)}`);
  return ctx.effect(name, fn, { idempotencyKey });
}

/** Wrap sync — telemetry-only (not idempotency-keyed). */
export async function wrapSandboxSync(
  ctx: StepContext<unknown> | undefined,
  args: { runId: string; stage: string; idx: number },
  fn: () => Promise<SandboxSyncResult>,
): Promise<SandboxSyncResult> {
  if (!ctx || typeof ctx.effect !== 'function') return fn();
  const idempotencyKey = `${args.runId}:${args.stage}:sync:${args.idx}`;
  const name = sandboxEffectName('sync', args.runId, args.stage, String(args.idx));
  return ctx.effect(name, fn, { idempotencyKey });
}

/** Wrap close — telemetry-only. */
export async function wrapSandboxClose(
  ctx: StepContext<unknown> | undefined,
  args: { runId: string; stage: string },
  fn: () => Promise<void>,
): Promise<void> {
  if (!ctx || typeof ctx.effect !== 'function') return fn();
  const idempotencyKey = `${args.runId}:${args.stage}:close`;
  const name = sandboxEffectName('close', args.runId, args.stage);
  return ctx.effect(name, fn, { idempotencyKey });
}
