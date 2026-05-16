/**
 * Critical-action confirmation gate. For high-risk operations
 * (browser_evaluate, browser_attach_context, computer.* in dashboard
 * mode) the harness fires a confirm event; the user approves or denies.
 *
 * In CI / autonomous mode, set `ANVIL_AUTOCONFIRM_BROWSE=1` to bypass.
 */
const AUTOCONFIRM_ENV = 'ANVIL_AUTOCONFIRM_BROWSE';
export class ConfirmGate {
    ask;
    env;
    approvedSessions = new Set();
    constructor(opts = {}) {
        this.ask = opts.ask;
        this.env = opts.env ?? process.env;
    }
    /**
     * Returns when the user (or auto-confirm env var, or a prior
     * "session approval") approves. Throws when denied.
     */
    async confirm(req) {
        if (this.env[AUTOCONFIRM_ENV] === '1')
            return;
        if (req.sessionKey && this.approvedSessions.has(req.sessionKey))
            return;
        if (!this.ask) {
            throw new Error(`${req.tool} requires user confirmation but no confirmer is wired. ` +
                `Set ANVIL_AUTOCONFIRM_BROWSE=1 to bypass in CI.`);
        }
        const ans = await this.ask(req);
        if (ans === false)
            throw new Error(`${req.tool} denied by user.`);
        if (ans === 'session' && req.sessionKey) {
            this.approvedSessions.add(req.sessionKey);
        }
    }
    /** Test seam — clear remembered session approvals. */
    resetSessions() {
        this.approvedSessions.clear();
    }
}
//# sourceMappingURL=confirm-gate.js.map