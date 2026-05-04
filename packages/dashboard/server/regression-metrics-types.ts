/**
 * regression-metrics-types — shared types for the Regression Guard Insights
 * panel.
 *
 * A single `RegressionGuardMetrics` rollup answers: is Regression Guard
 * actually catching anything? It is computed on-demand by
 * `computeRegressionMetrics` from the incident / replay / bound stores plus
 * the bound-tests audit log, and streamed to the dashboard via the
 * `get-regression-metrics` WS action.
 */

export interface OverrideMonthBucket {
  /** YYYY-MM — the month the overrides fell into, UTC. */
  month: string;
  count: number;
}

export interface IncidentWithoutGuard {
  incidentId: string;
  createdAt: string;                  // incident.occurredAt or capturedAt
  severity?: string;
}

export interface TopGuardedFile {
  filePath: string;
  incidentCount: number;              // distinct incidents guarded by this file
}

export interface RegressionTimeSeriesPoint {
  /** YYYY-MM-DD — the day (UTC) this point covers. */
  date: string;
  incidents: number;
  guards: number;
  catches: number;
}

export interface RegressionGuardMetrics {
  project: string;
  totalIncidents: number;
  guardedIncidents: number;           // incidents with at least one bound test
  percentGuarded: number;             // 0..1
  totalGuards: number;
  catchesLast30d: number;             // bound-test failures on later PRs
  catchRate: number;                  // catchesLast30d / totalGuards, 0..1
  avgBindLatencyMs: number;           // incident.occurredAt → bound.addedAt
  avgCatchLatencyMs: number;          // bind → first verify-failed event
  overridesLast30d: number;
  overridesPerMonth: OverrideMonthBucket[];
  incidentsWithoutGuard: IncidentWithoutGuard[];
  topGuardedFiles: TopGuardedFile[];
  timeSeries: RegressionTimeSeriesPoint[]; // 30 daily points, oldest first
  computedAt: string;
}
