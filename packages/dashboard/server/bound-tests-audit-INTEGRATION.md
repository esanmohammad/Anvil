# Regression Guard Phase 2 — Integration Notes

`BoundTestsAuditLog` (`bound-tests-audit.ts`) is an append-only NDJSON log
living next to `BoundTestsStore`. It records every bind / override / verify
event for operator forensics. The store (`bound-tests.ts`) remains the
authoritative list; this log is historical.

## WebSocket handlers to register in `dashboard-server.ts`

| Action                | Incoming payload                                  | Outgoing type              |
| --------------------- | ------------------------------------------------- | -------------------------- |
| `list-bound-tests`    | `{ project }`                                     | `bound-tests-list`         |
| `override-bound-test` | `{ project, filePath, reason }` (reason ≥ 20ch)   | `bound-test-removed` + `bound-tests-updated` |
| `verify-bound-test`   | `{ project, filePath }`                           | `bound-test-verify-result` |
| `verify-bound-tests`  | `{ project }` (batch verify all)                  | N × `bound-test-verify-result` |
| `list-bound-audit`    | `{ project, filters? }`                           | `bound-audit-list`         |

## When to fire audit events

| Event           | Emitter                                         |
| --------------- | ----------------------------------------------- |
| `bound`         | `replay-pipeline` after a successful replay adds a test via `BoundTestsStore.appendBound`. |
| `overridden`    | The `override-bound-test` WS handler (actor = `ANVIL_USER_NAME`). Include `details.reason`. |
| `verified`      | Periodic check or the `verify-bound-test` handler when the test passes. |
| `verify-failed` | Same path as `verified`, but on non-zero exit. Include `details.output` (truncated). |

## Sidebar / router registration

Add a new top-level nav item in the dashboard sidebar:

- Label: **Guards**
- Route: `/guards`
- Icon: `Shield` from `lucide-react`
- Component: `BoundTestsRegistry` (`src/components/bound-tests/BoundTestsRegistry.tsx`)

The component expects `{ project, ws }` from the router's project + WS
context providers. Route registration lives in `router.tsx` (not touched
here).

## Testing

`__tests__/bound-tests-audit.test.ts` covers append, filter, rotation,
tail, and malformed-line tolerance. Run via the dashboard test script:

```
npm --workspace @anvil-dev/dashboard run test:server
```
