/**
 * Feature Store — manages the feature folder structure where all artifacts
 * from a feature request are stored permanently.
 *
 * Directory layout:
 *   ~/.anvil/features/<project>/<feature-slug>/
 *   ├── feature.json
 *   ├── CLARIFICATION.md
 *   ├── REQUIREMENTS.md
 *   ├── repos/<repo>/REQUIREMENTS.md | SPECS.md | TASKS.md
 *   └── runs/<run-id>.json
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ── Types ────────────────────────────────────────────────────────────────

type StageStatus = 'pending' | 'completed' | 'failed';

export interface FeatureRecord {
  slug: string;
  project: string;
  description: string;
  status: 'in-progress' | 'completed' | 'failed' | 'cancelled';
  createdAt: string;
  updatedAt: string;
  lastRunId: string | null;
  totalCost: number;
  model: string;
  stages: {
    clarify: StageStatus;
    requirements: StageStatus;
    repoRequirements: Record<string, StageStatus>;
    specs: Record<string, StageStatus>;
    tasks: Record<string, StageStatus>;
    build: Record<string, StageStatus>;
    validate: Record<string, StageStatus>;
    ship: StageStatus;
  };
  repos: string[];
  prUrls: string[];
  sandboxUrl: string | null;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function atomicWriteFileSync(filePath: string, data: string): void {
  const tmp = filePath + '.tmp';
  writeFileSync(tmp, data, 'utf-8');
  renameSync(tmp, filePath);
}

function readJsonSync<T>(filePath: string): T | null {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// ── FeatureStore ─────────────────────────────────────────────────────────

export class FeatureStore {
  private baseDir: string;

  constructor(anvilHome?: string) {
    const home = anvilHome ?? process.env.ANVIL_HOME ?? process.env.FF_HOME ?? join(homedir(), '.anvil');
    this.baseDir = join(home, 'features');
    ensureDir(this.baseDir);
  }

  // ── Slug generation ──────────────────────────────────────────────────

  static slugify(description: string): string {
    let slug = description
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')   // non-alphanumeric → hyphens
      .replace(/-{2,}/g, '-')         // collapse multiple hyphens
      .replace(/^-+|-+$/g, '');       // strip leading/trailing hyphens

    if (slug.length > 50) {
      slug = slug.slice(0, 50).replace(/-+$/, '');
    }

    return slug || 'feature';
  }

  // ── Directory helpers ────────────────────────────────────────────────

  getFeatureDir(project: string, slug: string): string {
    return join(this.baseDir, project, slug);
  }

  private featureJsonPath(project: string, slug: string): string {
    return join(this.getFeatureDir(project, slug), 'feature.json');
  }

  private projectDir(project: string): string {
    return join(this.baseDir, project);
  }

  // ── Unique slug ──────────────────────────────────────────────────────

  private uniqueSlug(project: string, baseSlug: string): string {
    const sysDir = this.projectDir(project);
    if (!existsSync(sysDir)) return baseSlug;

    if (!existsSync(join(sysDir, baseSlug))) return baseSlug;

    let counter = 2;
    while (existsSync(join(sysDir, `${baseSlug}-${counter}`))) {
      counter++;
    }
    return `${baseSlug}-${counter}`;
  }

  // ── CRUD ─────────────────────────────────────────────────────────────

  createFeature(project: string, description: string, model: string): FeatureRecord {
    const baseSlug = FeatureStore.slugify(description);
    const slug = this.uniqueSlug(project, baseSlug);
    const dir = this.getFeatureDir(project, slug);
    ensureDir(dir);
    ensureDir(join(dir, 'repos'));
    ensureDir(join(dir, 'runs'));

    const now = new Date().toISOString();
    const record: FeatureRecord = {
      slug,
      project,
      description,
      status: 'in-progress',
      createdAt: now,
      updatedAt: now,
      lastRunId: null,
      totalCost: 0,
      model,
      stages: {
        clarify: 'pending',
        requirements: 'pending',
        repoRequirements: {},
        specs: {},
        tasks: {},
        build: {},
        validate: {},
        ship: 'pending',
      },
      repos: [],
      prUrls: [],
      sandboxUrl: null,
    };

    atomicWriteFileSync(this.featureJsonPath(project, slug), JSON.stringify(record, null, 2));
    return record;
  }

  getFeature(project: string, slug: string): FeatureRecord | null {
    return readJsonSync<FeatureRecord>(this.featureJsonPath(project, slug));
  }

  listFeatures(project?: string): FeatureRecord[] {
    const results: FeatureRecord[] = [];

    const projects = project
      ? [project]
      : existsSync(this.baseDir)
        ? readdirSync(this.baseDir, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => d.name)
        : [];

    for (const sys of projects) {
      const sysDir = this.projectDir(sys);
      if (!existsSync(sysDir)) continue;

      const entries = readdirSync(sysDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const record = this.getFeature(sys, entry.name);
        if (record) results.push(record);
      }
    }

    // Sort newest first
    results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return results;
  }

  updateFeature(project: string, slug: string, updates: Partial<FeatureRecord>): void {
    const jsonPath = this.featureJsonPath(project, slug);
    const existing = readJsonSync<FeatureRecord>(jsonPath);
    if (!existing) {
      throw new Error(`Feature not found: ${project}/${slug}`);
    }

    const merged: FeatureRecord = {
      ...existing,
      ...updates,
      // Never allow overwriting identity fields
      slug: existing.slug,
      project: existing.project,
      updatedAt: new Date().toISOString(),
    };

    // Deep-merge stages if provided
    if (updates.stages) {
      merged.stages = {
        ...existing.stages,
        ...updates.stages,
        repoRequirements: { ...existing.stages.repoRequirements, ...updates.stages.repoRequirements },
        specs: { ...existing.stages.specs, ...updates.stages.specs },
        tasks: { ...existing.stages.tasks, ...updates.stages.tasks },
        build: { ...existing.stages.build, ...updates.stages.build },
        validate: { ...existing.stages.validate, ...updates.stages.validate },
      };
    }

    atomicWriteFileSync(jsonPath, JSON.stringify(merged, null, 2));
  }

  // ── Artifacts ────────────────────────────────────────────────────────

  writeArtifact(project: string, slug: string, relativePath: string, content: string): void {
    const featureDir = this.getFeatureDir(project, slug);
    if (!existsSync(featureDir)) {
      throw new Error(`Feature not found: ${project}/${slug}`);
    }

    // Security: prevent path traversal
    const fullPath = join(featureDir, relativePath);
    if (!fullPath.startsWith(featureDir + '/') && fullPath !== featureDir) {
      throw new Error(`Path traversal detected: ${relativePath}`);
    }

    const parentDir = join(fullPath, '..');
    ensureDir(parentDir);

    atomicWriteFileSync(fullPath, content);
  }

  readArtifact(project: string, slug: string, relativePath: string): string | null {
    const featureDir = this.getFeatureDir(project, slug);
    const fullPath = join(featureDir, relativePath);

    // Security: prevent path traversal
    if (!fullPath.startsWith(featureDir + '/') && fullPath !== featureDir) {
      return null;
    }

    try {
      return readFileSync(fullPath, 'utf-8');
    } catch {
      return null;
    }
  }

  // ── Runs ─────────────────────────────────────────────────────────────

  recordRun(project: string, slug: string, runId: string, summary: object): void {
    const runsDir = join(this.getFeatureDir(project, slug), 'runs');
    ensureDir(runsDir);

    const runPath = join(runsDir, `${runId}.json`);
    atomicWriteFileSync(runPath, JSON.stringify(summary, null, 2));

    // Update lastRunId on the feature record
    this.updateFeature(project, slug, { lastRunId: runId });
  }
}
