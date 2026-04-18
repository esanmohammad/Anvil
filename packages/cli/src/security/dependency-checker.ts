/**
 * DependencyChecker — detect new deps in package.json diff, check for risk signals.
 */

export interface DependencyFinding {
  name: string;
  version: string;
  type: 'new-dep' | 'new-dev-dep' | 'version-change';
  risk: 'low' | 'medium' | 'high';
  reason: string;
}

export interface DependencyCheckResult {
  findings: DependencyFinding[];
  hasHighRisk: boolean;
  newDependencies: string[];
}

export class DependencyChecker {
  private execCommand: ((cmd: string) => Promise<string>) | null;

  constructor(execCommand?: (cmd: string) => Promise<string>) {
    this.execCommand = execCommand ?? null;
  }

  /** Analyze a package.json diff for new/changed dependencies. */
  analyzeDiff(
    oldPkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> },
    newPkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> },
  ): DependencyCheckResult {
    const findings: DependencyFinding[] = [];
    const newDependencies: string[] = [];

    // Check dependencies
    const oldDeps = oldPkg.dependencies ?? {};
    const newDeps = newPkg.dependencies ?? {};

    for (const [name, version] of Object.entries(newDeps)) {
      if (!(name in oldDeps)) {
        newDependencies.push(name);
        findings.push({
          name,
          version,
          type: 'new-dep',
          risk: this.assessRisk(name, version),
          reason: 'New production dependency added',
        });
      } else if (oldDeps[name] !== version) {
        findings.push({
          name,
          version,
          type: 'version-change',
          risk: 'low',
          reason: `Version changed from ${oldDeps[name]} to ${version}`,
        });
      }
    }

    // Check devDependencies
    const oldDevDeps = oldPkg.devDependencies ?? {};
    const newDevDeps = newPkg.devDependencies ?? {};

    for (const [name, version] of Object.entries(newDevDeps)) {
      if (!(name in oldDevDeps)) {
        newDependencies.push(name);
        findings.push({
          name,
          version,
          type: 'new-dev-dep',
          risk: this.assessRisk(name, version),
          reason: 'New dev dependency added',
        });
      }
    }

    return {
      findings,
      hasHighRisk: findings.some((f) => f.risk === 'high'),
      newDependencies,
    };
  }

  /** Run npm audit if execCommand is available. */
  async audit(): Promise<string | null> {
    if (!this.execCommand) return null;
    try {
      return await this.execCommand('npm audit --json');
    } catch (err) {
      return (err as Error).message;
    }
  }

  /** Assess risk of a dependency based on heuristics. */
  private assessRisk(name: string, version: string): DependencyFinding['risk'] {
    // Scoped packages from known orgs are generally lower risk
    if (name.startsWith('@types/')) return 'low';

    // Git/URL dependencies are higher risk
    if (
      version.startsWith('git') ||
      version.startsWith('http') ||
      version.startsWith('file:')
    ) {
      return 'high';
    }

    // Exact versions with unusual ranges
    if (version.startsWith('>') || version === '*' || version === 'latest') {
      return 'medium';
    }

    return 'low';
  }
}
