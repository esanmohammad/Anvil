/**
 * `anvil sandbox-runtime` — diagnostic commands for the Mode 1/2
 * sandbox runtime introduced in §S of the sandbox-isolation plan.
 *
 *   anvil sandbox-runtime shell [stage]   # interactive sandbox
 *   anvil sandbox-runtime prune            # rm dangling anvil-* containers
 *   anvil sandbox-runtime stats            # docker stats for anvil-* containers
 *
 * Distinct from the existing `anvil sandbox` (Nexus deploy sandbox)
 * — that one manages preview environments; this one manages the
 * isolation runtime for the agent's exec/build/test/validate stages.
 *
 * Pure stdio; no dashboard dependency. Drives the host's `docker`
 * CLI directly.
 */

import { Command } from 'commander';
import { execFileSync, spawnSync } from 'node:child_process';

export const sandboxRuntimeCommand = new Command('sandbox-runtime')
  .description('Sandbox runtime diagnostics + lifecycle commands (Phase S — see docs/sandbox-isolation-plan.md).');

sandboxRuntimeCommand
  .command('shell [stage]')
  .description('Drop into an interactive sandbox for the given stage (default: "validate").')
  .option('--image <tag>', 'override the sandbox image tag', 'anvil/sandbox:latest')
  .option('--workdir <path>', 'host workdir to bind into /workspace', process.cwd())
  .action((stage: string | undefined, opts: { image?: string; workdir?: string }) => {
    const image = opts.image ?? process.env.ANVIL_SANDBOX_TAG ?? 'anvil/sandbox:latest';
    const workdir = opts.workdir ?? process.cwd();
    const dockerBin = process.env.DOCKER_BIN ?? 'docker';
    const stageName = stage ?? 'validate';
    const containerName = `anvil-shell-${stageName}-${Date.now().toString(36)}`;

    process.stdout.write(`Starting interactive sandbox: ${image} (${stageName})\n`);
    const r = spawnSync(dockerBin, [
      'run', '-it', '--rm',
      '--name', containerName,
      '--workdir', '/workspace',
      '--mount', `type=bind,src=${workdir},dst=/workspace`,
      '--init',
      image,
      'bash',
    ], { stdio: 'inherit' });
    process.exitCode = r.status ?? 0;
  });

sandboxRuntimeCommand
  .command('prune')
  .description('Stop and remove every anvil-* container left over from a crashed run.')
  .option('--force', 'also remove busy containers (anvil-sb-* with -f)')
  .action((opts: { force?: boolean }) => {
    const dockerBin = process.env.DOCKER_BIN ?? 'docker';
    let names = '';
    try {
      names = execFileSync(
        dockerBin,
        ['ps', '-a', '--filter', 'name=^anvil-', '--format', '{{.Names}}'],
        { encoding: 'utf-8' },
      );
    } catch (e) {
      process.stderr.write(`docker ps failed: ${(e as Error).message}\n`);
      process.exitCode = 1;
      return;
    }
    const list = names.split('\n').map((s) => s.trim()).filter(Boolean);
    if (list.length === 0) {
      process.stdout.write('No anvil-* containers found.\n');
      return;
    }
    process.stdout.write(`Removing ${list.length} container(s):\n`);
    for (const name of list) {
      process.stdout.write(`  ${name}\n`);
      try {
        execFileSync(
          dockerBin,
          opts.force ? ['rm', '-f', name] : ['rm', name],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        );
      } catch (e) {
        process.stderr.write(`  failed: ${(e as Error).message}\n`);
      }
    }
  });

sandboxRuntimeCommand
  .command('stats')
  .description('Show currently running anvil-* containers + their resource usage.')
  .action(() => {
    const dockerBin = process.env.DOCKER_BIN ?? 'docker';
    const r = spawnSync(
      dockerBin,
      ['stats', '--no-stream', '--filter', 'name=^anvil-',
       '--format', 'table {{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}\t{{.PIDs}}'],
      { stdio: 'inherit' },
    );
    process.exitCode = r.status ?? 0;
  });
