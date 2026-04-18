// Section I — Hook Configuration Types

export interface HookMatcher {
  /** Glob patterns for files that trigger this hook */
  filePatterns: string[];
  /** Event that triggers the hook */
  event: 'pre-commit' | 'post-commit' | 'pre-push' | 'post-tool-use';
}

export interface ClaudeHook {
  name: string;
  description: string;
  command: string;
  matcher: HookMatcher;
  enabled: boolean;
}

export interface HookConfig {
  hooks: ClaudeHook[];
  version: string;
}
