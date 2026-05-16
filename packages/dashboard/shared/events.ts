/**
 * Shared event types for the dashboard.
 *
 * Single source of truth for both server (Node) AND frontend (Vite/React).
 * The server emits `DashboardEvent`s via Emittery-style services; the
 * frontend's reducer consumes them via the typed `EventKind` union.
 *
 * Why this file lives at `packages/dashboard/shared/`:
 * - Sharing through a sibling workspace package (e.g. `packages/dashboard-events/`)
 *   is cleaner long-term but adds a workspace + publish dance.
 * - Co-locating inside `packages/dashboard/shared/` is faster and matches
 *   the v2 plan §10 "Open decisions" — we picked the lighter option.
 * - Both `server/` (Node 20, NodeNext modules) and `src/` (Vite, ESM)
 *   resolve relative imports here cleanly.
 *
 * Re-exports the canonical types from `../server/events/types.ts` so the
 * frontend imports a single namespace without reaching into `server/`.
 */

export type {
  DashboardEvent,
  EventEnvelope,
  EventKind,
  EventOf,
  PayloadOf,
  Topic,
  SchemaVersion,
  AgentOutputEntry,
} from '../server/events/types.js';

export { nextEventId, envelope } from '../server/events/types.js';
