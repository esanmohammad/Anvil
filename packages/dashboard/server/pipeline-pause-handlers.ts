/**
 * WS handler helpers for pipeline pause/resume.
 *
 * Each function is a pure adapter over PipelinePauseStore: it validates the
 * inbound message, delegates to the store, and returns a JSON-serialisable
 * response payload. The calling WS switch in dashboard-server.ts is
 * responsible for transport (ws.send / broadcast).
 *
 * Response shape is tagged by `type` so callers can route without inspecting
 * payload contents.
 */

import type { PipelinePauseStore } from './pipeline-pause-store.js';
import type {
  PauseQueryFilters,
  PauseState,
  PauseStatus,
  PauseStage,
  ResumeDecision,
} from './pipeline-pause-types.js';

// ── Response envelopes ───────────────────────────────────────────────────

export interface ListPausesResponse {
  type: 'pipeline-pauses';
  payload: { pauses: PauseState[] };
}

export interface GetPauseResponse {
  type: 'pipeline-pause';
  payload: { pause: PauseState | null };
}

export interface ResumedResponse {
  type: 'pipeline-resumed';
  payload: { pause: PauseState };
}

export interface ResumeErrorResponse {
  type: 'pipeline-resume-error';
  payload: { message: string; runId?: string };
}

export interface CancelledResponse {
  type: 'pipeline-cancelled';
  payload: { pause: PauseState };
}

export interface CancelErrorResponse {
  type: 'pipeline-cancel-error';
  payload: { message: string; runId?: string };
}

export interface GetErrorResponse {
  type: 'pipeline-pause-error';
  payload: { message: string };
}

// ── Input message shapes ─────────────────────────────────────────────────

export interface ListPausesMessage {
  project?: string;
  status?: PauseStatus;
  stage?: PauseStage;
}

export interface GetPauseMessage {
  runId?: string;
}

export interface ResumePipelineMessage {
  runId?: string;
  decision?: ResumeDecision;
}

export interface CancelPauseMessage {
  runId?: string;
  note?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isValidAction(value: unknown): value is ResumeDecision['action'] {
  return value === 'approve'
    || value === 'approve-with-note'
    || value === 'modify-artifact'
    || value === 'iterate-with-note'
    || value === 'rerun-from'
    || value === 'cancel';
}

function normaliseDecision(raw: unknown): ResumeDecision | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (!isValidAction(obj.action)) return null;
  const out: ResumeDecision = { action: obj.action };
  if (typeof obj.note === 'string') out.note = obj.note;
  if (typeof obj.editedArtifact === 'string') out.editedArtifact = obj.editedArtifact;
  if (typeof obj.rerunFromStage === 'number' && Number.isInteger(obj.rerunFromStage) && obj.rerunFromStage >= 0) {
    out.rerunFromStage = obj.rerunFromStage;
  }
  return out;
}

// ── Handlers ─────────────────────────────────────────────────────────────

export function handleListPauses(
  store: PipelinePauseStore,
  msg: ListPausesMessage,
): ListPausesResponse | GetErrorResponse {
  try {
    const filters: PauseQueryFilters = {};
    if (typeof msg.project === 'string') filters.project = msg.project;
    if (typeof msg.status === 'string') filters.status = msg.status;
    if (typeof msg.stage === 'string') filters.stage = msg.stage;
    const pauses = store.list(filters);
    return { type: 'pipeline-pauses', payload: { pauses } };
  } catch (err) {
    return {
      type: 'pipeline-pause-error',
      payload: { message: errorMessage(err) },
    };
  }
}

export function handleGetPause(
  store: PipelinePauseStore,
  msg: GetPauseMessage,
): GetPauseResponse | GetErrorResponse {
  if (!msg.runId || typeof msg.runId !== 'string') {
    return {
      type: 'pipeline-pause-error',
      payload: { message: 'runId is required' },
    };
  }
  try {
    const pause = store.get(msg.runId);
    return { type: 'pipeline-pause', payload: { pause } };
  } catch (err) {
    return {
      type: 'pipeline-pause-error',
      payload: { message: errorMessage(err) },
    };
  }
}

export function handleResumePipeline(
  store: PipelinePauseStore,
  msg: ResumePipelineMessage,
  resumedBy?: string,
): ResumedResponse | ResumeErrorResponse {
  if (!msg.runId || typeof msg.runId !== 'string') {
    return {
      type: 'pipeline-resume-error',
      payload: { message: 'runId is required' },
    };
  }
  const decision = normaliseDecision(msg.decision);
  if (!decision) {
    return {
      type: 'pipeline-resume-error',
      payload: {
        message: 'decision.action must be approve|modify|cancel',
        runId: msg.runId,
      },
    };
  }
  try {
    const pause = store.resume(msg.runId, decision, resumedBy);
    return { type: 'pipeline-resumed', payload: { pause } };
  } catch (err) {
    return {
      type: 'pipeline-resume-error',
      payload: { message: errorMessage(err), runId: msg.runId },
    };
  }
}

export function handleCancelPause(
  store: PipelinePauseStore,
  msg: CancelPauseMessage,
  resumedBy?: string,
): CancelledResponse | CancelErrorResponse {
  if (!msg.runId || typeof msg.runId !== 'string') {
    return {
      type: 'pipeline-cancel-error',
      payload: { message: 'runId is required' },
    };
  }
  try {
    const pause = store.cancel(msg.runId, resumedBy);
    return { type: 'pipeline-cancelled', payload: { pause } };
  } catch (err) {
    return {
      type: 'pipeline-cancel-error',
      payload: { message: errorMessage(err), runId: msg.runId },
    };
  }
}
