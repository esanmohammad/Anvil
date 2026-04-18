// Sandbox cleanup hook — teardown sandbox on pipeline error or SIGINT

import { deployDown, type ExecCommand } from './deploy-down.js';

export interface CleanupOptions {
  keepSandbox?: boolean;
}

export interface CleanupHook {
  register(namespace: string): void;
  unregister(): void;
  cleanup(): Promise<void>;
}

/**
 * Create a cleanup hook that tears down the sandbox on error or SIGINT.
 * If --keep-sandbox is set, the cleanup is skipped.
 */
export function createCleanupHook(
  options: CleanupOptions = {},
  execCommand?: ExecCommand,
): CleanupHook {
  let activeNamespace: string | null = null;
  let sigintHandler: (() => void) | null = null;

  const doCleanup = async (): Promise<void> => {
    if (!activeNamespace || options.keepSandbox) {
      return;
    }

    const ns = activeNamespace;
    activeNamespace = null;

    try {
      await deployDown(ns, execCommand);
    } catch {
      // Best-effort cleanup — don't throw on failure
    }
  };

  return {
    register(namespace: string): void {
      activeNamespace = namespace;

      sigintHandler = () => {
        // Fire-and-forget cleanup on SIGINT
        void doCleanup().finally(() => {
          process.exit(1);
        });
      };

      process.on('SIGINT', sigintHandler);
    },

    unregister(): void {
      activeNamespace = null;
      if (sigintHandler) {
        process.removeListener('SIGINT', sigintHandler);
        sigintHandler = null;
      }
    },

    cleanup: doCleanup,
  };
}
