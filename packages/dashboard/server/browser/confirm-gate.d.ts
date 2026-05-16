/**
 * Critical-action confirmation gate. For high-risk operations
 * (browser_evaluate, browser_attach_context, computer.* in dashboard
 * mode) the harness fires a confirm event; the user approves or denies.
 *
 * In CI / autonomous mode, set `ANVIL_AUTOCONFIRM_BROWSE=1` to bypass.
 */
export interface ConfirmGateOpts {
    /** Async confirmer — the dashboard wires this to a WebSocket modal;
     *  CLI wires it to a terminal prompt; tests inject a stub. May
     *  return `true` (approve once), `false` (deny), or
     *  `'session'` (approve every subsequent call with the same
     *  `sessionKey`). */
    ask?: (request: ConfirmRequest) => Promise<boolean | 'session'>;
    /** Override the env var. Defaults to `process.env`. */
    env?: Record<string, string | undefined>;
}
export interface ConfirmRequest {
    /** Tool name (e.g. `browser_evaluate`). */
    tool: string;
    /** Concise description of the proposed action. */
    description: string;
    /** Caller-supplied risk level (info only — gate triggers regardless). */
    risk?: 'medium' | 'high';
    /** Tool-specific argument blob for the user's review. */
    payload?: unknown;
    /** Stable key for "approve for the rest of this session". When
     *  the user picks the session option, every subsequent `confirm()`
     *  call sharing the same `sessionKey` short-circuits to approve.
     *  Computer-use callers pass `<runId>:<sessionId>:<tool>` so a 50-
     *  action CUA run only prompts once. */
    sessionKey?: string;
}
export declare class ConfirmGate {
    private readonly ask?;
    private readonly env;
    private readonly approvedSessions;
    constructor(opts?: ConfirmGateOpts);
    /**
     * Returns when the user (or auto-confirm env var, or a prior
     * "session approval") approves. Throws when denied.
     */
    confirm(req: ConfirmRequest): Promise<void>;
    /** Test seam — clear remembered session approvals. */
    resetSessions(): void;
}
//# sourceMappingURL=confirm-gate.d.ts.map