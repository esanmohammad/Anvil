/**
 * WS-trace instrumentation (Phase 0 of WS-EXTRACTION-PLAN).
 *
 * When `ANVIL_WS_TRACE=1`, every broadcast() call writes a JSONL record to
 * `$ANVIL_HOME/ws-trace.jsonl` capturing the emitted event type plus a stable
 * hash of the immediate caller frame. The hash lets us group emissions by
 * call-site without leaking absolute paths or stack noise.
 *
 * Disabled by default — costs ~0 when the env var is unset (we early-return
 * before touching fs or stack capture).
 *
 * See WS-EXTRACTION-PLAN.md Part 7 → Phase 0.
 */
export interface TraceRecord {
    ts: number;
    type: string;
    callerHash: string;
}
/**
 * Record a broadcast emission. No-ops unless `ANVIL_WS_TRACE=1` at boot.
 * Failures are silently swallowed — tracing must never break the dashboard.
 */
export declare function traceEmit(msg: {
    type?: string;
} | unknown): void;
//# sourceMappingURL=ws-trace.d.ts.map