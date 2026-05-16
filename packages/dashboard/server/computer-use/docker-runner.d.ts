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
import type { ComputerAction } from './computer-use-translator.js';
export interface ComputerActionResult {
    imageBase64?: string;
    width?: number;
    height?: number;
    text?: string;
    error?: {
        code: string;
        message: string;
    };
}
export interface ComputerRunnerOpts {
    runId: string;
    /** Display dimensions for the Xvfb session. Default 1024x768. */
    width?: number;
    height?: number;
    /** Pinned Docker image tag. Default Anvil's vendor mirror. */
    image?: string;
}
export interface ComputerRunner {
    do(action: ComputerAction): Promise<ComputerActionResult>;
    close(): Promise<void>;
}
export type ComputerRunnerFactory = (opts: ComputerRunnerOpts) => Promise<ComputerRunner>;
export declare const DEFAULT_COMPUTER_USE_IMAGE = "ghcr.io/anvil-dev/computer-use-demo:pinned-2026-05";
/**
 * Default Docker-backed runner. Production wires this; tests inject a
 * mock. We avoid spawning real containers in the dashboard's test
 * suite — the executor uses a stubbed factory for unit tests.
 */
export declare function createDockerComputerRunner(opts: ComputerRunnerOpts): Promise<ComputerRunner>;
/**
 * Test runner — drives a deterministic in-memory state. Each action
 * returns a fixed-size 1×1 pixel screenshot so callers can verify the
 * dispatch shape without spinning up a container.
 */
export declare function createMockComputerRunner(): ComputerRunner;
//# sourceMappingURL=docker-runner.d.ts.map