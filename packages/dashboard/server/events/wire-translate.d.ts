/**
 * Typed-event → legacy `{type, payload}` wire translation.
 *
 * Both the React frontend (via `wireToEvent` in `src/state/reducer.ts`)
 * and the socket.io bridge (`services-bridge.ts`) speak the legacy
 * `<verb>-<noun>` slug vocabulary. The pure translation lives here so
 * the bridge stays focused on lifecycle (subscribe / append / fan out).
 *
 * Exhaustive on `DashboardEvent['kind']` via `ts-pattern.match(...).exhaustive()`
 * — adding a new event kind without a case here is a compile error.
 */
import type { DashboardEvent } from './types.js';
/** Legacy wire shape — what the frontend's reducer + `wireToEvent` consume. */
export interface LegacyMessage {
    type: string;
    payload: unknown;
}
/**
 * Translate a typed event envelope into the legacy `{type,payload}` wire
 * shape. Returns `null` for kinds that are purely internal (e.g.
 * `run.started`/`run.state-changed`/`run.completed` are folded into
 * `run.active-snapshot` for the wire — they don't get their own slug).
 */
export declare function toLegacyWire(ev: DashboardEvent): LegacyMessage | null;
//# sourceMappingURL=wire-translate.d.ts.map