// Section A — Tool Resolution
import { Language } from './detect.js';

export interface ToolSet {
  formatter: string | null;
  linter: string | null;
}

const TOOL_MAP: Record<Language, ToolSet> = {
  [Language.Go]: { formatter: 'gofmt', linter: 'golangci-lint' },
  [Language.TypeScript]: { formatter: 'prettier', linter: 'eslint' },
  [Language.JavaScript]: { formatter: 'prettier', linter: 'eslint' },
  [Language.Python]: { formatter: 'black', linter: 'ruff' },
  [Language.Unknown]: { formatter: null, linter: null },
};

/**
 * Resolve formatter and linter binaries for a given language.
 */
export function resolveTools(language: Language): ToolSet {
  return TOOL_MAP[language] ?? { formatter: null, linter: null };
}
