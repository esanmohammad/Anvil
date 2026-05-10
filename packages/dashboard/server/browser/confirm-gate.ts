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
   *  CLI wires it to a terminal prompt; tests inject a stub. */
  ask?: (request: ConfirmRequest) => Promise<boolean>;
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
}

export class ConfirmGate {
  private readonly ask?: (req: ConfirmRequest) => Promise<boolean>;
  private readonly env: Record<string, string | undefined>;

  constructor(opts: ConfirmGateOpts = {}) {
    this.ask = opts.ask;
    this.env = opts.env ?? process.env;
  }

  /**
   * Returns true when the user (or the auto-confirm env var) approves.
   * Throws if the user denies or the action times out.
   */
  async confirm(req: ConfirmRequest): Promise<void> {
    if (this.env[AUTOCONFIRM_ENV] === '1') return;
    if (!this.ask) {
      throw new Error(
        `${req.tool} requires user confirmation but no confirmer is wired. ` +
        `Set ANVIL_AUTOCONFIRM_BROWSE=1 to bypass in CI.`,
      );
    }
    const ok = await this.ask(req);
    if (!ok) throw new Error(`${req.tool} denied by user.`);
  }
}
