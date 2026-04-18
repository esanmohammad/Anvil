// Dashboard state file — single source of truth for the dashboard UI.
// The pipeline orchestrator writes state here; the dashboard server watches it.

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DashboardStageState {
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  startedAt?: string;
  completedAt?: string;
  error?: string;
  cost?: number;
}

export interface DashboardPipeline {
  runId: string;
  project: string;
  feature: string;
  status: 'idle' | 'running' | 'completed' | 'failed' | 'cancelled';
  currentStage: number;
  stages: DashboardStageState[];
  startedAt: string;
  cost: { inputTokens: number; outputTokens: number; estimatedCost: number };
  model?: string;
  pendingApproval?: { stage: number; requestedAt: string } | null;
  userMessages?: string[];
}

export interface DashboardState {
  activePipeline: DashboardPipeline | null;
  lastUpdated: string;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function getAnvilHome(): string {
  return process.env.ANVIL_HOME || process.env.FF_HOME || join(homedir(), '.anvil');
}

export const STATE_FILE_PATH = join(getAnvilHome(), 'state.json');

// ---------------------------------------------------------------------------
// Debounce — avoid excessive writes (100ms)
// ---------------------------------------------------------------------------

let writeTimer: ReturnType<typeof setTimeout> | null = null;
let pendingState: DashboardState | null = null;

function flushWrite(): void {
  if (pendingState) {
    atomicWriteSync(STATE_FILE_PATH, pendingState);
    pendingState = null;
  }
}

function atomicWriteSync(filePath: string, state: DashboardState): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tmp = filePath + '.tmp';
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
  renameSync(tmp, filePath);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Read dashboard state from disk. Returns default if file is missing or corrupt. */
export function readDashboardState(): DashboardState {
  try {
    const raw = readFileSync(STATE_FILE_PATH, 'utf-8');
    return JSON.parse(raw) as DashboardState;
  } catch {
    return { activePipeline: null, lastUpdated: new Date().toISOString() };
  }
}

/** Write dashboard state to disk (atomic write with 100ms debounce). */
export function writeDashboardState(state: DashboardState): void {
  state.lastUpdated = new Date().toISOString();
  pendingState = state;

  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(flushWrite, 100);
}

/** Flush any pending debounced write immediately (call at pipeline end). */
export function flushDashboardState(): void {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  flushWrite();
}

/** Update a single pipeline stage — read-modify-write helper. */
export function updatePipelineStage(
  stageIndex: number,
  status: DashboardStageState['status'],
  error?: string,
): void {
  const state = readDashboardState();
  if (!state.activePipeline) return;

  const stage = state.activePipeline.stages[stageIndex];
  if (!stage) return;

  stage.status = status;
  if (status === 'running' && !stage.startedAt) {
    stage.startedAt = new Date().toISOString();
  }
  if (status === 'completed' || status === 'failed' || status === 'skipped') {
    stage.completedAt = new Date().toISOString();
  }
  if (error) {
    stage.error = error;
  }

  // Update currentStage to the latest running stage
  if (status === 'running') {
    state.activePipeline.currentStage = stageIndex;
  }

  // Flush immediately for stage transitions — dashboard needs to see every change
  state.lastUpdated = new Date().toISOString();
  pendingState = null;
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  atomicWriteSync(STATE_FILE_PATH, state);
}

/** Update cost on the active pipeline. */
export function updatePipelineCost(cost: { inputTokens: number; outputTokens: number; estimatedCost: number }): void {
  const state = readDashboardState();
  if (!state.activePipeline) return;
  state.activePipeline.cost = cost;
  writeDashboardState(state);
}

/** Clear the active pipeline (set to null). */
export function clearActivePipeline(): void {
  const state = readDashboardState();
  state.activePipeline = null;
  // Flush immediately — pipeline is ending
  state.lastUpdated = new Date().toISOString();
  pendingState = null;
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  atomicWriteSync(STATE_FILE_PATH, state);
}

/** Update cost for a specific stage. */
export function updateStageCost(stageIndex: number, cost: number): void {
  const state = readDashboardState();
  if (!state.activePipeline) return;
  const stage = state.activePipeline.stages[stageIndex];
  if (!stage) return;
  stage.cost = cost;
  writeDashboardState(state);
}

/** Set pending approval on the active pipeline. Flushes immediately. */
export function setPendingApproval(stageIndex: number): void {
  const state = readDashboardState();
  if (!state.activePipeline) return;
  state.activePipeline.pendingApproval = { stage: stageIndex, requestedAt: new Date().toISOString() };
  state.lastUpdated = new Date().toISOString();
  pendingState = null;
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  atomicWriteSync(STATE_FILE_PATH, state);
}

/** Clear pending approval. Flushes immediately. */
export function clearPendingApproval(): void {
  const state = readDashboardState();
  if (!state.activePipeline) return;
  state.activePipeline.pendingApproval = null;
  state.lastUpdated = new Date().toISOString();
  pendingState = null;
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  atomicWriteSync(STATE_FILE_PATH, state);
}

/** Append a user message to the active pipeline. */
export function pushUserMessage(text: string): void {
  const state = readDashboardState();
  if (!state.activePipeline) return;
  if (!state.activePipeline.userMessages) state.activePipeline.userMessages = [];
  state.activePipeline.userMessages.push(text);
  writeDashboardState(state);
}

/** Read and clear user messages from the active pipeline. */
export function drainUserMessages(): string[] {
  const state = readDashboardState();
  if (!state.activePipeline) return [];
  const messages = state.activePipeline.userMessages ?? [];
  if (messages.length > 0) {
    state.activePipeline.userMessages = [];
    writeDashboardState(state);
  }
  return messages;
}
