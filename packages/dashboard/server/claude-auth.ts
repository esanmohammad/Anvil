/**
 * `claude-auth` — Claude CLI auth probe + browser-driven re-login.
 *
 * Module-level helpers extracted from `pipeline-runner.ts`. The runner
 * imports `ensureAuth` from `runner-telemetry`; both functions here are
 * shell-out helpers with no runner state.
 */
import { execSync, spawn as cpSpawn } from 'node:child_process';

const CLAUDE_BIN = process.env.ANVIL_AGENT_CMD ?? process.env.FF_AGENT_CMD ?? process.env.CLAUDE_BIN ?? 'claude';

/** True when the Claude CLI reports `loggedIn: true`. */
export function checkClaudeAuth(): boolean {
  try {
    const out = execSync(`${CLAUDE_BIN} auth status --json`, { timeout: 10_000, stdio: ['pipe', 'pipe', 'pipe'] });
    const status = JSON.parse(out.toString());
    return status.loggedIn === true;
  } catch {
    return false;
  }
}

/**
 * Trigger an automatic re-login via `claude auth login`. Opens the
 * browser for OAuth and polls until auth succeeds or times out.
 * Returns true when re-auth succeeded.
 */
export function refreshClaudeAuth(timeoutMs = 120_000): Promise<boolean> {
  return new Promise((resolve) => {
    const loginProc = cpSpawn(CLAUDE_BIN, ['auth', 'login'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const deadline = Date.now() + timeoutMs;

    const poll = () => {
      if (Date.now() > deadline) {
        loginProc.kill();
        resolve(false);
        return;
      }
      if (checkClaudeAuth()) {
        loginProc.kill();
        resolve(true);
        return;
      }
      setTimeout(poll, 2000);
    };

    setTimeout(poll, 3000);

    loginProc.on('exit', () => {
      setTimeout(() => resolve(checkClaudeAuth()), 500);
    });

    loginProc.on('error', () => resolve(false));
  });
}
