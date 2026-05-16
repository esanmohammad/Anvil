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
import { spawn } from 'node:child_process';
import { DockerSandboxRunner, } from './docker-runner.js';
export class GVisorSandboxRunner extends DockerSandboxRunner {
    constructor(opts = {}) {
        super(opts);
        // We hijack the dockerCli wrapper to splice in `--runtime=runsc`
        // for `run` calls. Subclassing keeps every other behavior identical.
        const original = this.dockerCli.bind(this);
        this.dockerCli = (argv) => {
            if (argv[0] === 'run' && !argv.includes('--runtime')) {
                const next = ['run', '--runtime=runsc', ...argv.slice(1)];
                return original(next);
            }
            return original(argv);
        };
    }
    /**
     * Override isAvailable to also check that `runsc` is present.
     * The gVisor binary is `runsc`; on systems without it, fall through
     * to plain Docker.
     */
    async isAvailable() {
        const docker = await super.isAvailable();
        if (!docker)
            return false;
        if (process.platform !== 'linux')
            return false;
        const probe = await new Promise((resolve) => {
            const spawnFn = this.opts.spawnFn ?? spawn;
            const child = spawnFn('runsc', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
            let exited = false;
            child.on('error', () => { if (!exited) {
                exited = true;
                resolve(false);
            } });
            child.on('exit', (code) => { if (!exited) {
                exited = true;
                resolve(code === 0);
            } });
        });
        return probe;
    }
}
//# sourceMappingURL=gvisor-runner.js.map