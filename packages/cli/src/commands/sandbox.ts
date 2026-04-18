// Sandbox CLI command — list, status, destroy, extend subcommands

import { Command } from 'commander';
import { deployDown, type ExecCommand as DeployDownExec } from '../sandbox/deploy-down.js';
import { DEFAULT_DEPLOY_CONFIG } from '../sandbox/deploy-types.js';

export type ExecCommand = (
  cmd: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

export interface SandboxCommandDeps {
  execCommand?: ExecCommand;
  deployDownFn?: (namespace: string, exec?: DeployDownExec) => Promise<{ success: boolean; retried: boolean; error?: string }>;
  deployCommand?: string;
}

export function createSandboxCommand(deps: SandboxCommandDeps = {}): Command {
  const exec = deps.execCommand;
  const downFn = deps.deployDownFn ?? deployDown;
  const deployCli = deps.deployCommand ?? DEFAULT_DEPLOY_CONFIG.command;

  const cmd = new Command('sandbox').description('Manage sandbox environments');

  // list subcommand
  cmd
    .command('list')
    .description('List active sandbox environments')
    .action(async () => {
      try {
        const execFn = exec ?? (await getDefaultExec());
        const { stdout } = await execFn(deployCli, ['list', '--json']);
        const envs = JSON.parse(stdout) as Array<{
          namespace: string;
          status: string;
          age: string;
        }>;

        if (envs.length === 0) {
          process.stderr.write('No active sandbox environments.\n');
          return;
        }

        // Display table
        process.stderr.write(
          padRight('NAMESPACE', 30) +
            padRight('STATUS', 15) +
            padRight('AGE', 15) +
            '\n',
        );
        for (const env of envs) {
          process.stderr.write(
            padRight(env.namespace, 30) +
              padRight(env.status, 15) +
              padRight(env.age, 15) +
              '\n',
          );
        }
      } catch (err) {
        process.stderr.write(
          `Error listing sandboxes: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exitCode = 1;
      }
    });

  // status subcommand
  cmd
    .command('status <namespace>')
    .description('Show detailed pod/ingress/health info for a sandbox')
    .action(async (namespace: string) => {
      try {
        const execFn = exec ?? (await getDefaultExec());
        const { stdout } = await execFn(deployCli, ['status', namespace, '--json']);
        const status = JSON.parse(stdout) as {
          namespace: string;
          ingressUrl: string;
          pods: Array<{ name: string; ready: boolean; status: string; restarts: number }>;
        };

        process.stderr.write(`Namespace: ${status.namespace}\n`);
        process.stderr.write(`Ingress:   ${status.ingressUrl}\n`);
        process.stderr.write('\nPods:\n');
        for (const pod of status.pods) {
          const readyStr = pod.ready ? 'Ready' : 'NotReady';
          process.stderr.write(
            `  ${pod.name}  ${readyStr}  restarts=${pod.restarts}  ${pod.status}\n`,
          );
        }
      } catch (err) {
        process.stderr.write(
          `Error getting sandbox status: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exitCode = 1;
      }
    });

  // destroy subcommand
  cmd
    .command('destroy <namespace>')
    .description('Destroy a sandbox environment')
    .option('--force', 'Skip confirmation prompt')
    .action(async (namespace: string, opts: { force?: boolean }) => {
      if (!opts.force) {
        process.stderr.write(
          `Destroying sandbox ${namespace}. Use --force to skip confirmation.\n`,
        );
      }

      const result = await downFn(namespace, exec as DeployDownExec | undefined);
      if (result.success) {
        process.stderr.write(`Sandbox ${namespace} destroyed.\n`);
      } else {
        process.stderr.write(
          `Failed to destroy sandbox ${namespace}: ${result.error ?? 'unknown error'}\n`,
        );
        process.exitCode = 1;
      }
    });

  // extend subcommand
  cmd
    .command('extend <namespace>')
    .description('Extend sandbox TTL')
    .option('--ttl <duration>', 'TTL extension duration', '2h')
    .action(async (namespace: string, opts: { ttl: string }) => {
      try {
        const execFn = exec ?? (await getDefaultExec());
        await execFn(deployCli, ['extend', namespace, '--ttl', opts.ttl]);
        process.stderr.write(
          `Sandbox ${namespace} TTL extended by ${opts.ttl}.\n`,
        );
      } catch (err) {
        process.stderr.write(
          `Failed to extend sandbox: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exitCode = 1;
      }
    });

  return cmd;
}

function padRight(str: string, len: number): string {
  return str.padEnd(len);
}

async function getDefaultExec(): Promise<ExecCommand> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  return async (cmd: string, args: string[]) => {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 2 * 60_000,
    });
    return { stdout, stderr };
  };
}

// Default export for commander registration
export const sandboxCommand = createSandboxCommand();
