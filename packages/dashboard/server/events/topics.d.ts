/**
 * Topic-routing for typed dashboard events.
 *
 * Every `DashboardEvent` declares its rooms via `roomsForEvent(ev)`.
 * The service-bridge calls this once per emission to look up which
 * socket.io rooms should receive the message.
 *
 * Default subscription rules (Phase 4):
 *   - Every client auto-subscribes to `global` on connect (lossless
 *     transition from today's firehose).
 *   - Route mounts (RunDetail, PlanEditor, ReviewPage) add per-entity
 *     subscriptions via `socket.emit('subscribe', { rooms: [...] })`.
 *   - High-volume per-run events (agent.output, agent.spawned, etc.)
 *     publish ONLY to `run:<id>` — clients without that subscription
 *     don't receive them. Cuts firehose noise.
 *
 * Exhaustiveness: `match(...).exhaustive()` makes a missing case a
 * TypeScript compile error. Adding a new event kind without a topic
 * mapping breaks the build, not runtime.
 */
import type { DashboardEvent, Topic } from './types.js';
export declare function roomsForEvent(ev: DashboardEvent): Topic[];
//# sourceMappingURL=topics.d.ts.map