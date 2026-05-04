// Error handling pattern detector — Section D.4

export type ErrorStyle = 'try-catch' | 'result-type' | 'custom-errors' | 'mixed';

export interface ErrorHandlingResult {
  style: ErrorStyle;
  tryCatchCount: number;
  resultTypeCount: number;
  customErrorCount: number;
  confidence: number;
  examples: string[];
}

/**
 * Detect error handling patterns from source file contents.
 */
export function detectErrorHandling(contents: string[]): ErrorHandlingResult {
  let tryCatchCount = 0;
  let resultTypeCount = 0;
  let customErrorCount = 0;
  const examples: string[] = [];

  for (const content of contents) {
    // try-catch
    const tryCatches = (content.match(/\btry\s*\{/g) ?? []).length;
    tryCatchCount += tryCatches;

    // Result type pattern (Result<T, E>, Ok(), Err())
    const resultTypes = (content.match(/\bResult<[^>]*>/g) ?? []).length;
    const okCalls = (content.match(/\bOk\s*\(/g) ?? []).length;
    const errCalls = (content.match(/\bErr\s*\(/g) ?? []).length;
    resultTypeCount += resultTypes + okCalls + errCalls;

    // Custom error classes
    const customErrors = content.match(/class\s+\w+Error\s+extends\s+(Error|BaseError|\w+Error)/g) ?? [];
    customErrorCount += customErrors.length;
    for (const match of customErrors) {
      if (examples.length < 3) {
        examples.push(match);
      }
    }
  }

  const total = tryCatchCount + resultTypeCount + customErrorCount || 1;

  let style: ErrorStyle = 'mixed';
  if (tryCatchCount / total > 0.6) style = 'try-catch';
  else if (resultTypeCount / total > 0.6) style = 'result-type';
  else if (customErrorCount / total > 0.3 && tryCatchCount / total > 0.3)
    style = 'custom-errors';

  const dominant = Math.max(tryCatchCount, resultTypeCount, customErrorCount);
  const confidence = Math.round((dominant / total) * 100);

  return {
    style,
    tryCatchCount,
    resultTypeCount,
    customErrorCount,
    confidence,
    examples,
  };
}
