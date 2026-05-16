/**
 * Backend dispatcher — picks daemon when a live socket is found, otherwise
 * in-process. The whole point of the SearchBackend abstraction.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { InProcessBackend } from './in-process.js';
import { DaemonBackend } from './daemon-client.js';
import type { BackendConfig, SearchBackend } from './types.js';

export * from './types.js';
export { InProcessBackend } from './in-process.js';
export { DaemonBackend } from './daemon-client.js';

/**
 * Resolve the daemon socket path for a workspace. UDS on POSIX, named pipe
 * on Windows. Conventional path so multiple consumers (MCP server, CLI,
 * admin UI) can find the same daemon without explicit configuration.
 */
export function daemonSocketPath(dataDir: string, project: string): string {
  if (process.platform === 'win32') {
    // Named pipes: \\.\pipe\<name>; node will accept the unix-style path
    // via createConnection on POSIX, and Windows requires the pipe syntax.
    return `\\\\.\\pipe\\code-search-${project}`;
  }
  return join(dataDir, 'daemon', `${project}.sock`);
}

export async function pickBackend(cfg: BackendConfig): Promise<SearchBackend> {
  const socketPath = cfg.socketPath ?? daemonSocketPath(cfg.knowledge ? '' : '', cfg.project);
  if (cfg.preferDaemon && socketPath && existsSync(socketPath)) {
    const daemon = new DaemonBackend({ ...cfg, socketPath });
    if (await daemon.ping()) return daemon;
    // Daemon unreachable; fall through.
    process.stderr.write(`[code-search-mcp] daemon socket exists at ${socketPath} but ping failed; using in-process backend\n`);
  }
  return new InProcessBackend(cfg);
}
