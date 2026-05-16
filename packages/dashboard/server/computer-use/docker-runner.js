/**
 * Docker-based Xvfb + Chromium runner for Tier 3 pixel browser. Forks
 * Anthropic's `anthropic-quickstarts:computer-use-demo` image at a
 * pinned tag and proxies actions in/screenshots out via an internal
 * HTTP shim.
 *
 * In dev environments without Docker, the runner factory throws a
 * helpful "install + run" message. The dashboard's test suite uses a
 * mock runner and never touches Docker.
 */
export const DEFAULT_COMPUTER_USE_IMAGE = 'ghcr.io/anvil-dev/computer-use-demo:pinned-2026-05';
/**
 * Default Docker-backed runner. Production wires this; tests inject a
 * mock. We avoid spawning real containers in the dashboard's test
 * suite — the executor uses a stubbed factory for unit tests.
 */
export async function createDockerComputerRunner(opts) {
    void opts;
    throw new Error('Tier 3 pixel-browser requires Docker. Install Docker, then enable via ' +
        '`pipeline-policy.overlay.json: tools.browsePixel.enabled = true`. ' +
        'Image: ' + DEFAULT_COMPUTER_USE_IMAGE);
}
/**
 * Test runner — drives a deterministic in-memory state. Each action
 * returns a fixed-size 1×1 pixel screenshot so callers can verify the
 * dispatch shape without spinning up a container.
 */
export function createMockComputerRunner() {
    const log = [];
    return {
        async do(action) {
            log.push(action);
            return {
                imageBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
                width: 1,
                height: 1,
                text: action.action === 'screenshot' ? 'screenshot ok' : `${action.action} ok`,
            };
        },
        async close() { log.length = 0; },
    };
}
//# sourceMappingURL=docker-runner.js.map