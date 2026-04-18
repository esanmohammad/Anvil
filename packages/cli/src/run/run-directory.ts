// Run directory management

import { mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SUBDIRS = ['artifacts', 'checkpoints', 'agent-output'] as const;

export class RunDirectory {
  private readonly basePath: string;
  private readonly runId: string;

  constructor(basePath: string, runId: string) {
    this.basePath = basePath;
    this.runId = runId;
  }

  getRunPath(): string {
    return join(this.basePath, this.runId);
  }

  create(): void {
    const runPath = this.getRunPath();
    mkdirSync(runPath, { recursive: true });
    for (const sub of SUBDIRS) {
      mkdirSync(join(runPath, sub), { recursive: true });
    }
  }

  exists(): boolean {
    return existsSync(this.getRunPath());
  }

  getPath(sub: string): string {
    const p = join(this.getRunPath(), sub);
    if (!existsSync(p)) {
      mkdirSync(p, { recursive: true });
    }
    return p;
  }

  listArtifacts(): string[] {
    const artifactsDir = join(this.getRunPath(), 'artifacts');
    if (!existsSync(artifactsDir)) {
      return [];
    }
    return readdirSync(artifactsDir);
  }
}
