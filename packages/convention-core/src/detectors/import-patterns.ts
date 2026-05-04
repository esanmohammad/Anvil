// Import pattern detector — Section D.2

export type ImportStyle = 'relative' | 'absolute' | 'mixed';

export interface ImportPatternResult {
  style: ImportStyle;
  hasBarrelFiles: boolean;
  hasImportOrdering: boolean;
  relativeCount: number;
  absoluteCount: number;
  barrelFileExamples: string[];
  confidence: number;
}

const IMPORT_RE = /^import\s+.*?\s+from\s+['"]([^'"]+)['"]/gm;
const BARREL_RE = /^export\s+\{.*\}\s+from\s+['"]\.\/[^'"]+['"]/;
const BARREL_STAR_RE = /^export\s+\*\s+from\s+['"]\.\/[^'"]+['"]/;

/**
 * Detect import patterns from source file contents.
 */
export function detectImportPatterns(sourceFiles: { path: string; content: string }[]): ImportPatternResult {
  let relativeCount = 0;
  let absoluteCount = 0;
  let barrelFileCount = 0;
  const barrelFileExamples: string[] = [];
  let hasOrderedImports = false;

  for (const file of sourceFiles) {
    const { path: filePath, content } = file;

    // Check if this is a barrel file (index.ts with re-exports)
    if (filePath.endsWith('index.ts') || filePath.endsWith('index.js')) {
      const lines = content.split('\n');
      const reExports = lines.filter(
        (l) => BARREL_RE.test(l) || BARREL_STAR_RE.test(l),
      );
      if (reExports.length >= 2) {
        barrelFileCount++;
        if (barrelFileExamples.length < 3) {
          barrelFileExamples.push(filePath);
        }
      }
    }

    // Count import types
    const importMatches = content.matchAll(IMPORT_RE);
    let lastWasRelative: boolean | null = null;
    let orderedSoFar = true;

    for (const match of importMatches) {
      const specifier = match[1];
      const isRelative = specifier.startsWith('.');

      if (isRelative) {
        relativeCount++;
      } else {
        absoluteCount++;
      }

      // Check ordering: absolute imports before relative
      if (lastWasRelative !== null) {
        if (!isRelative && lastWasRelative) {
          orderedSoFar = false;
        }
      }
      lastWasRelative = isRelative;
    }

    if (orderedSoFar && lastWasRelative !== null) {
      hasOrderedImports = true;
    }
  }

  const total = relativeCount + absoluteCount;
  let style: ImportStyle = 'mixed';
  if (total > 0) {
    if (relativeCount / total > 0.8) style = 'relative';
    else if (absoluteCount / total > 0.8) style = 'absolute';
  }

  const confidence = total > 0 ? Math.round((Math.max(relativeCount, absoluteCount) / total) * 100) : 0;

  return {
    style,
    hasBarrelFiles: barrelFileCount > 0,
    hasImportOrdering: hasOrderedImports,
    relativeCount,
    absoluteCount,
    barrelFileExamples,
    confidence,
  };
}
