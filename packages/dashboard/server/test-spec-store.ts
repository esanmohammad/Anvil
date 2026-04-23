/**
 * TestSpecStore — versioned persistence for TestSpec artifacts.
 *
 * A TestSpec is the structured description of *what* should be tested for a
 * feature or PR. It lives BEFORE test code is authored and forms the contract
 * between the test-generation agent(s), the TestCaseStore, and the runner.
 *
 * Storage layout:
 *   ~/.anvil/tests/<project>/<slug>/
 *   ├── spec-v1.json, spec-v2.json, ...   # versioned TestSpec snapshots
 *   ├── spec-current.json                 # pointer
 *   ├── cases-v{N}.json                   # owned by TestCaseStore
 *   ├── runs/<runId>.json                 # owned by TestRunStore
 *   └── ...
 *
 * Slug derivation mirrors PlanStore: slugify(title) + uniqueSlug collision
 * suffix, so a spec sitting next to a plan can share the human-readable name.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import type { TestSpec, TestSpecPointer } from './test-types.js';

// ── Helpers ──────────────────────────────────────────────────────────────

function atomicWriteFileSync(filePath: string, data: string): void {
  const tmp = filePath + '.tmp';
  writeFileSync(tmp, data, 'utf-8');
  renameSync(tmp, filePath);
}

function readJsonSync<T>(filePath: string): T | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function slugify(input: string): string {
  let slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length > 50) slug = slug.slice(0, 50).replace(/-+$/, '');
  return slug || 'test';
}

// ── TestSpecStore ────────────────────────────────────────────────────────

export class TestSpecStore {
  private baseDir: string;

  constructor(anvilHome?: string) {
    const home = anvilHome ?? process.env.ANVIL_HOME ?? process.env.FF_HOME ?? join(homedir(), '.anvil');
    this.baseDir = join(home, 'tests');
    ensureDir(this.baseDir);
  }

  // ── Path helpers ──────────────────────────────────────────────────────

  getSpecDir(project: string, slug: string): string {
    return join(this.baseDir, project, slug);
  }

  private projectDir(project: string): string {
    return join(this.baseDir, project);
  }

  private versionPath(project: string, slug: string, version: number): string {
    return join(this.getSpecDir(project, slug), `spec-v${version}.json`);
  }

  private pointerPath(project: string, slug: string): string {
    return join(this.getSpecDir(project, slug), 'spec-current.json');
  }

  // ── Slug ──────────────────────────────────────────────────────────────

  private uniqueSlug(project: string, base: string): string {
    const dir = this.projectDir(project);
    if (!existsSync(dir) || !existsSync(join(dir, base))) return base;
    let n = 2;
    while (existsSync(join(dir, `${base}-${n}`))) n++;
    return `${base}-${n}`;
  }

  // ── CRUD ──────────────────────────────────────────────────────────────

  /** Create v1 of a new TestSpec from a partial payload. */
  createSpec(project: string, title: string, model: string, seed: Partial<TestSpec> = {}): TestSpec {
    const baseSlug = slugify(seed.title || title);
    const slug = this.uniqueSlug(project, baseSlug);
    const dir = this.getSpecDir(project, slug);
    ensureDir(dir);

    const now = new Date().toISOString();
    const spec: TestSpec = {
      version: 1,
      slug,
      project,
      title: seed.title || title.slice(0, 80),
      source: seed.source ?? { files: [] },
      behaviors: seed.behaviors ?? [],
      conventions: seed.conventions ?? {
        runner: 'unknown',
        assertionStyle: 'unknown',
        fileLayout: 'unknown',
        namingPattern: '',
        imports: {},
        examples: [],
      },
      model,
      createdAt: now,
      updatedAt: now,
    };

    atomicWriteFileSync(this.versionPath(project, slug, 1), JSON.stringify(spec, null, 2));
    this.writePointer(project, slug, {
      slug, title: spec.title, currentVersion: 1, updatedAt: now,
    });
    return spec;
  }

  /** Append a new version by merging updates into the current version. */
  bumpVersion(project: string, slug: string, updates: Partial<TestSpec>): TestSpec {
    const current = this.readCurrent(project, slug);
    if (!current) throw new Error(`TestSpec not found: ${project}/${slug}`);

    const next: TestSpec = {
      ...current,
      ...updates,
      // never let callers rewrite identity
      slug: current.slug,
      project: current.project,
      createdAt: current.createdAt,
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
    };

    atomicWriteFileSync(this.versionPath(project, slug, next.version), JSON.stringify(next, null, 2));
    this.writePointer(project, slug, {
      slug, title: next.title, currentVersion: next.version, updatedAt: next.updatedAt,
    });
    return next;
  }

  /** Read the current (latest) version. */
  readCurrent(project: string, slug: string): TestSpec | null {
    const pointer = readJsonSync<TestSpecPointer>(this.pointerPath(project, slug));
    if (!pointer) return null;
    return readJsonSync<TestSpec>(this.versionPath(project, slug, pointer.currentVersion));
  }

  /** Read a specific version. */
  readVersion(project: string, slug: string, version: number): TestSpec | null {
    return readJsonSync<TestSpec>(this.versionPath(project, slug, version));
  }

  /** List all versions for a spec (sorted ascending). */
  listVersions(project: string, slug: string): number[] {
    const dir = this.getSpecDir(project, slug);
    if (!existsSync(dir)) return [];
    const versions: number[] = [];
    for (const entry of readdirSync(dir)) {
      const m = entry.match(/^spec-v(\d+)\.json$/);
      if (m) versions.push(parseInt(m[1], 10));
    }
    return versions.sort((a, b) => a - b);
  }

  /** List all spec pointers for a project (or all projects if omitted). */
  listSpecs(project?: string): TestSpecPointer[] {
    const out: TestSpecPointer[] = [];
    const projects = project
      ? [project]
      : existsSync(this.baseDir)
        ? readdirSync(this.baseDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
        : [];

    for (const p of projects) {
      const dir = this.projectDir(p);
      if (!existsSync(dir)) continue;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const ptr = readJsonSync<TestSpecPointer>(this.pointerPath(p, entry.name));
        if (ptr) out.push(ptr);
      }
    }

    out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return out;
  }

  readPointer(project: string, slug: string): TestSpecPointer | null {
    return readJsonSync<TestSpecPointer>(this.pointerPath(project, slug));
  }

  // ── Markdown rendering ────────────────────────────────────────────────

  /** Render a TestSpec as markdown — useful for prompt injection or UI preview. */
  renderMarkdown(spec: TestSpec): string {
    const lines: string[] = [];
    lines.push(`# ${spec.title}`);
    lines.push(`> TestSpec v${spec.version} — ${spec.project} — ${spec.model}`);
    lines.push('');

    if (spec.source.plan) {
      lines.push(`**Plan:** \`${spec.source.plan.slug}\` v${spec.source.plan.version}`);
    }
    if (spec.source.prUrl) lines.push(`**PR:** ${spec.source.prUrl}`);
    if (spec.source.files.length) {
      lines.push(`**Files under test:** ${spec.source.files.map((f) => `\`${f}\``).join(', ')}`);
    }
    lines.push('');

    lines.push('## Conventions');
    lines.push(`- Runner: \`${spec.conventions.runner}\``);
    lines.push(`- Assertion style: \`${spec.conventions.assertionStyle}\``);
    lines.push(`- File layout: \`${spec.conventions.fileLayout}\``);
    lines.push(`- Naming pattern: \`${spec.conventions.namingPattern}\``);
    if (spec.conventions.setupPattern) lines.push(`- Setup: \`${spec.conventions.setupPattern}\``);
    if (spec.conventions.mockStyle) lines.push(`- Mock style: \`${spec.conventions.mockStyle}\``);
    if (spec.conventions.fixtureStyle) lines.push(`- Fixture style: \`${spec.conventions.fixtureStyle}\``);
    if (spec.conventions.examples.length) {
      lines.push(`- Examples: ${spec.conventions.examples.map((f) => `\`${f}\``).join(', ')}`);
    }
    lines.push('');

    lines.push('## Behaviors');
    if (!spec.behaviors.length) {
      lines.push('_No behaviors defined yet._');
    }
    for (const b of spec.behaviors) {
      lines.push(`### [${b.kind} · ${b.priority}] ${b.intent}`);
      lines.push(`- Target: \`${b.target.file}\` → \`${b.target.symbol}\``);
      if (b.preconditions.length) {
        lines.push(`- Preconditions:`);
        for (const p of b.preconditions) lines.push(`  - ${p}`);
      }
      lines.push(`- Inputs: ${b.inputs.description}`);
      if (b.inputs.generator) lines.push(`  - Generator: \`${b.inputs.generator}\``);
      lines.push(`- Expected: ${b.expected.description}`);
      lines.push(`  - Assertion: \`${b.expected.assertion}\``);
      if (b.mutationTargets?.length) {
        lines.push(`- Mutation targets: ${b.mutationTargets.map((m) => `\`${m}\``).join(', ')}`);
      }
      if (b.linkedFindingId) lines.push(`- Linked finding: \`${b.linkedFindingId}\``);
      if (b.linkedIncidentId) lines.push(`- Linked incident: \`${b.linkedIncidentId}\``);
      lines.push(`- Ground confidence: ${(b.ground.confidence * 100).toFixed(0)}% (${b.ground.files.length} files)`);
      lines.push('');
    }

    return lines.join('\n');
  }

  // ── Pointer ───────────────────────────────────────────────────────────

  private writePointer(project: string, slug: string, pointer: TestSpecPointer): void {
    ensureDir(this.getSpecDir(project, slug));
    atomicWriteFileSync(this.pointerPath(project, slug), JSON.stringify(pointer, null, 2));
  }
}
