/**
 * Critical-action confirmation gate. For high-risk operations
 * (browser_evaluate, browser_attach_context, computer.* in dashboard
 * mode) the harness fires a confirm event; the user approves or denies.
 *
 * In CI / autonomous mode, set `ANVIL_AUTOCONFIRM_BROWSE=1` to bypass.
 */

const AUTOCONFIRM_ENV = 'ANVIL_AUTOCONFIRM_BROWSE';

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

export class ConfirmGate {
  private readonly ask?: (req: ConfirmRequest) => Promise<boolean | 'session'>;
  private readonly env: Record<string, string | undefined>;
  private readonly approvedSessions = new Set<string>();

  constructor(opts: ConfirmGateOpts = {}) {
    this.ask = opts.ask;
    this.env = opts.env ?? process.env;
  }

  /**
   * Returns when the user (or auto-confirm env var, or a prior
   * "session approval") approves. Throws when denied.
   */
  async confirm(req: ConfirmRequest): Promise<void> {
    if (this.env[AUTOCONFIRM_ENV] === '1') return;
    if (req.sessionKey && this.approvedSessions.has(req.sessionKey)) return;
    if (!this.ask) {
      throw new Error(
        `${req.tool} requires user confirmation but no confirmer is wired. ` +
        `Set ANVIL_AUTOCONFIRM_BROWSE=1 to bypass in CI.`,
      );
    }
    const ans = await this.ask(req);
    if (ans === false) throw new Error(`${req.tool} denied by user.`);
    if (ans === 'session' && req.sessionKey) {
      this.approvedSessions.add(req.sessionKey);
    }
  }

  /** Test seam — clear remembered session approvals. */
  resetSessions(): void {
    this.approvedSessions.clear();
  }
}
