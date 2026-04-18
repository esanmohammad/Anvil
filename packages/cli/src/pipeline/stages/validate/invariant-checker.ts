import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { glob } from 'node:fs/promises';

export interface Invariant {
  id: string;
  statement: string;
  type: 'file-exists' | 'import-pattern' | 'required-export';
  pattern: string;
  severity: 'error' | 'warning';
}

export interface InvariantViolation {
  invariantId: string;
  statement: string;
  severity: 'error' | 'warning';
  details: string;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findFilesWithContent(
  repoPath: string,
  pattern: string,
  fileGlob: string = '**/*.{ts,tsx,js,jsx,go}',
): Promise<string[]> {
  const matches: string[] = [];
  try {
    // Simple recursive search using readdir
    const { readdir } = await import('node:fs/promises');
    const regex = new RegExp(pattern);

    async function walkDir(dir: string): Promise<void> {
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = join(dir, entry.name);
          if (entry.name === 'node_modules' || entry.name === '.git') continue;
          if (entry.isDirectory()) {
            await walkDir(fullPath);
          } else if (entry.isFile()) {
            try {
              const content = await readFile(fullPath, 'utf-8');
              if (regex.test(content)) {
                matches.push(fullPath);
              }
            } catch {
              // Skip unreadable files
            }
          }
        }
      } catch {
        // Skip unreadable directories
      }
    }

    await walkDir(repoPath);
  } catch {
    // If glob fails, return empty
  }
  return matches;
}

/**
 * Checks a list of invariants against a repo.
 */
export async function checkInvariants(
  repoPath: string,
  invariants: Invariant[],
): Promise<InvariantViolation[]> {
  const violations: InvariantViolation[] = [];

  for (const inv of invariants) {
    switch (inv.type) {
      case 'file-exists': {
        const exists = await fileExists(join(repoPath, inv.pattern));
        if (!exists) {
          violations.push({
            invariantId: inv.id,
            statement: inv.statement,
            severity: inv.severity,
            details: `Required file not found: ${inv.pattern}`,
          });
        }
        break;
      }

      case 'import-pattern': {
        const files = await findFilesWithContent(repoPath, inv.pattern);
        if (files.length === 0) {
          violations.push({
            invariantId: inv.id,
            statement: inv.statement,
            severity: inv.severity,
            details: `No files match import pattern: ${inv.pattern}`,
          });
        }
        break;
      }

      case 'required-export': {
        const files = await findFilesWithContent(repoPath, inv.pattern);
        if (files.length === 0) {
          violations.push({
            invariantId: inv.id,
            statement: inv.statement,
            severity: inv.severity,
            details: `Required export not found: ${inv.pattern}`,
          });
        }
        break;
      }

      default:
        violations.push({
          invariantId: inv.id,
          statement: inv.statement,
          severity: inv.severity,
          details: `Unknown invariant type: ${(inv as any).type}`,
        });
    }
  }

  return violations;
}
