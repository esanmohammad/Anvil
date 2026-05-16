/**
 * gVisor sandbox runner — Phase S9.
 *
 * gVisor is a user-space kernel (`runsc`) that runs OCI containers
 * with much stronger isolation than Docker's default `runc`. Same
 * SandboxRunner contract; vending differs: pass `--runtime=runsc`
 * to docker run.
 *
 * Rather than reinvent the docker driver, gVisor inherits from
 * `DockerSandboxRunner` and just appends the runtime flag. `runsc`
 * has narrower syscall coverage than `runc` so a small amount of
 * software won't run; the §F policy table calls this out.
 *
 * Linux-only. On macOS, the `isAvailable()` probe returns false and
 * the runner-registry falls back to Docker.
 */
import { DockerSandboxRunner, type DockerSandboxOptions } from './docker-runner.js';
export declare class GVisorSandboxRunner extends DockerSandboxRunner {
    constructor(opts?: DockerSandboxOptions);
    /**
     * Override isAvailable to also check that `runsc` is present.
     * The gVisor binary is `runsc`; on systems without it, fall through
     * to plain Docker.
     */
    isAvailable(): Promise<boolean>;
}
//# sourceMappingURL=gvisor-runner.d.ts.map