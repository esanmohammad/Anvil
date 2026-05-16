/**
 * Run / state-file I/O helpers (Phase 3 round-8 extraction from
 * `dashboard-server.ts`).
 *
 * Pure file-readers — no closure deps. The dashboard-server passes
 * the canonical `RUNS_INDEX` + `STATE_FILE` paths into the
 * factory-style wrappers so tests can target a temp ANVIL_HOME.
 */

import { existsSync, readFileSync } from 'node:fs';

import type { RunSummary, DashboardState } from '../dashboard-server.js';

/** Parse `RUNS_INDEX` (JSONL) into `RunSummary[]`, newest first. */
export function loadRunsSync(runsIndex: string): RunSummary[] {
  if (!existsSync(runsIndex)) return [];
  try {
    const content = readFileSync(runsIndex, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    return lines.map((line) => {
      const r = JSON.parse(line);
      const stages = Array.isArray(r.stages) ? r.stages : [];
      return {
        id: r.id,
        project: r.project,
        feature: r.feature,
        featureSlug: r.featureSlug,
        status: r.status,
        model: r.model,
        startedAt: new Date(r.createdAt).getTime(),
        completedAt: r.updatedAt ? new Date(r.updatedAt).getTime() : undefined,
        durationMs: r.durationMs,
        totalCost: r.totalCost,
        stages: stages.length,
        completedStages: stages.filter((s: { status?: string }) => s.status === 'completed').length,
        repos: r.repoNames ?? stages.flatMap((s: { repos?: Array<string | { repoName?: string }> }) =>
          (s.repos ?? []).map((rp) => typeof rp === 'string' ? rp : rp.repoName ?? ''),
        ),
        prUrls: r.prUrls ?? [],
        runType: r.type ?? 'build',  // 'build' | 'fix' | 'spike'
        output: r.output,            // stored output for detail view
        stageDetails: stages.map((s: {
          name: string; label?: string; status: string; cost?: number;
          startedAt?: string | null; completedAt?: string | null; error?: string | null;
        }) => ({
          name: s.name,
          label: s.label ?? s.name,
          status: s.status,
          cost: s.cost ?? 0,
          startedAt: s.startedAt ?? null,
          completedAt: s.completedAt ?? null,
          error: s.error ?? null,
        })),
      };
    }).reverse(); // newest first
  } catch {
    return [];
  }
}

/** Read `state.json`; return a fresh empty state on any read/parse error. */
export function readStateFile(stateFile: string): DashboardState {
  try {
    const raw = readFileSync(stateFile, 'utf-8');
    return JSON.parse(raw) as DashboardState;
  } catch {
    return { activePipeline: null, lastUpdated: new Date().toISOString() };
  }
}
