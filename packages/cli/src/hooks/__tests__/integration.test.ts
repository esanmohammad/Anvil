// Section J — Integration test (in-source)
import { detectLanguage, Language } from '../lang/detect.js';
import { resolveTools } from '../lang/tools.js';
import { scanDiff } from '../diff/scanner.js';
import type { DenyPattern, RequirePattern } from '../convention/types.js';

describe('hooks integration', () => {
  it('detects language and resolves tools end-to-end', () => {
    const lang = detectLanguage('main.go');
    expect(lang).toBe(Language.Go);

    const tools = resolveTools(lang);
    expect(tools.formatter).toBe('gofmt');
    expect(tools.linter).toBe('golangci-lint');
  });

  it('scans diff with deny patterns end-to-end', () => {
    const diff = [
      'diff --git a/main.go b/main.go',
      '--- a/main.go',
      '+++ b/main.go',
      '@@ -1,3 +1,4 @@',
      ' package main',
      '+import "fmt"',
      '+fmt.Println("TODO: remove this")',
      ' func main() {}',
    ].join('\n');

    const denyPatterns: DenyPattern[] = [
      { name: 'no-todo', pattern: 'TODO', level: 'error' },
    ];

    const result = scanDiff({
      diffOutput: diff,
      filePath: 'main.go',
      denyPatterns,
      requirePatterns: [],
    });

    expect(result.passed).toBe(false);
    expect(result.denyMatches).toHaveLength(1);
    expect(result.denyMatches[0].matchedText).toBe('TODO');
  });
});
