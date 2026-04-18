// Section I — Hook Configuration Generator
import type { ClaudeHook, HookConfig } from './types.js';

export interface GeneratorOptions {
  formatEnabled?: boolean;
  lintEnabled?: boolean;
  conventionEnabled?: boolean;
  conventionRulesPath?: string;
  filePatterns?: string[];
}

/**
 * Generate a HookConfig for Claude Code hooks JSON.
 */
export function generateHookConfig(options: GeneratorOptions = {}): HookConfig {
  const hooks: ClaudeHook[] = [];
  const patterns = options.filePatterns ?? ['**/*.ts', '**/*.go', '**/*.py', '**/*.js'];

  if (options.formatEnabled !== false) {
    hooks.push({
      name: 'ff-hook-format',
      description: 'Auto-format files after tool use',
      command: 'ff-hook format',
      matcher: {
        filePatterns: patterns,
        event: 'post-tool-use',
      },
      enabled: true,
    });
  }

  if (options.lintEnabled !== false) {
    hooks.push({
      name: 'ff-hook-lint',
      description: 'Lint files after tool use',
      command: 'ff-hook lint',
      matcher: {
        filePatterns: patterns,
        event: 'post-tool-use',
      },
      enabled: true,
    });
  }

  if (options.conventionEnabled !== false) {
    const rulesPath = options.conventionRulesPath ?? '.anvil/conventions.yaml';
    hooks.push({
      name: 'ff-hook-convention',
      description: 'Check convention rules after tool use',
      command: `ff-hook convention --rules ${rulesPath}`,
      matcher: {
        filePatterns: patterns,
        event: 'post-tool-use',
      },
      enabled: true,
    });
  }

  return {
    hooks,
    version: '1.0',
  };
}
