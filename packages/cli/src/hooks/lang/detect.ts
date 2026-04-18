// Section A — Language Detection
import { extname } from 'node:path';

export enum Language {
  Go = 'go',
  TypeScript = 'typescript',
  JavaScript = 'javascript',
  Python = 'python',
  Unknown = 'unknown',
}

const EXTENSION_MAP: Record<string, Language> = {
  '.go': Language.Go,
  '.ts': Language.TypeScript,
  '.tsx': Language.TypeScript,
  '.js': Language.JavaScript,
  '.jsx': Language.JavaScript,
  '.mjs': Language.JavaScript,
  '.cjs': Language.JavaScript,
  '.py': Language.Python,
  '.pyi': Language.Python,
};

/**
 * Detect language from a file path based on its extension.
 */
export function detectLanguage(filePath: string): Language {
  const ext = extname(filePath).toLowerCase();
  return EXTENSION_MAP[ext] ?? Language.Unknown;
}
