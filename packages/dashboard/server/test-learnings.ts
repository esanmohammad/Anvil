/**
 * TestLearningsStore — per-project calibration for the test-generation loop.
 *
 * Over time, a project accumulates signal about its own tests: which cases
 * are flaky, which behaviors have produced false positives, which bugs were
 * caught by generated tests, where mutation coverage is weak, and which
 * convention rules get violated most. We persist that signal once per
 * project and inject a condensed form into generator/auditor prompts so the
 * next run is calibrated by history — same idea as review-learner.
 *
 * Storage layout:
 *   ~/.anvil/tests/<project>/learnings.json
 *
 * (Deliberately stored at the project level, not per-slug — learnings are
 *  cross-feature: flaky caseIds, dismissed behaviorIds, and mutation scores
 *  are more useful when aggregated across every spec in the project.)
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import type {
  TestFinding,
  TestLearnings,
  TestPersona,
  TestResolution,
  TestSeverity,
} from './test-types.js';

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

// Severity weight used when ranking bugsCaught in prompt output.
const SEVERITY_WEIGHT: Record<TestSeverity, number> = {
  blocker: 5,
  error: 4,
  warn: 3,
  info: 2,
  nit: 1,
};

// ── TestLearningsStore ───────────────────────────────────────────────────

export class TestLearningsStore {
  private baseDir: string;

  constructor(anvilHome?: string) {
    const home = anvilHome ?? process.env.ANVIL_HOME ?? process.env.FF_HOME ?? join(homedir(), '.anvil');
    this.baseDir = join(home, 'tests');
    ensureDir(this.baseDir);
  }

  // ── Path helpers ──────────────────────────────────────────────────────

  private projectDir(project: string): string {
    return join(this.baseDir, project);
  }

  private learningsPath(project: string): string {
    return join(this.projectDir(project), 'learnings.json');
  }

  // ── Read ──────────────────────────────────────────────────────────────

  /** Read the current learnings for a project, creating an empty shell if missing. */
  read(project: string): TestLearnings {
    const existing = readJsonSync<TestLearnings>(this.learningsPath(project));
    if (existing) return existing;
    return this.empty(project);
  }

  private empty(project: string): TestLearnings {
    return {
      projectSlug: project,
      flakyTests: [],
      falsePositives: [],
      bugsCaught: [],
      mutationScoreByFile: {},
      conventionDrift: [],
      updatedAt: new Date().toISOString(),
    };
  }

  // ── Write primitives ──────────────────────────────────────────────────

  private writeLearnings(project: string, learnings: TestLearnings): TestLearnings {
    ensureDir(this.projectDir(project));
    const next: TestLearnings = { ...learnings, updatedAt: new Date().toISOString() };
    atomicWriteFileSync(this.learningsPath(project), JSON.stringify(next, null, 2));
    return next;
  }

  // ── Recorders ─────────────────────────────────────────────────────────

  /**
   * Record a resolution transition on a TestFinding. Mirrors the
   * review-learner contract:
   *   - only record when `prior !== finding.resolution`
   *   - `dismissed` on a behavior-linked finding is a false-positive signal
   *   - `wont-fix` on a convention finding is a drift signal
   *
   * No-op when the transition carries no learnable signal.
   */
  recordResolution(project: string, finding: TestFinding, prior: TestResolution): void {
    if (prior === finding.resolution) return;
    const learnings = this.read(project);

    // Dismissed + tied to a behavior → false positive.
    if (finding.resolution === 'dismissed' && finding.behaviorId) {
      const existingIdx = learnings.falsePositives.findIndex(
        (fp) => fp.behaviorId === finding.behaviorId,
      );
      const entry: TestLearnings['falsePositives'][number] = {
        behaviorId: finding.behaviorId,
        reason: finding.description.slice(0, 200),
        ...(finding.persona !== undefined ? { persona: finding.persona } : {}),
        recordedAt: new Date().toISOString(),
      };
      if (existingIdx === -1) learnings.falsePositives.push(entry);
      else learnings.falsePositives[existingIdx] = entry;
    }

    // Won't-fix + convention → drift signal.
    if (finding.resolution === 'wont-fix' && finding.category === 'convention') {
      const rule = finding.description.slice(0, 80) || 'unspecified';
      const existingIdx = learnings.conventionDrift.findIndex((d) => d.rule === rule);
      if (existingIdx === -1) {
        learnings.conventionDrift.push({ rule, violations: 1 });
      } else {
        learnings.conventionDrift[existingIdx] = {
          rule,
          violations: learnings.conventionDrift[existingIdx].violations + 1,
        };
      }
    }

    this.writeLearnings(project, learnings);
  }

  /**
   * Record the current flaky-test status for a case. Overwrites the existing
   * entry for the same caseId so `failureRate` reflects the latest snapshot.
   */
  recordFlaky(project: string, caseId: string, failureRate: number): void {
    const learnings = this.read(project);
    const idx = learnings.flakyTests.findIndex((f) => f.caseId === caseId);
    const entry = {
      caseId,
      failureRate,
      lastSeen: new Date().toISOString(),
    };
    if (idx === -1) learnings.flakyTests.push(entry);
    else learnings.flakyTests[idx] = entry;
    this.writeLearnings(project, learnings);
  }

  /**
   * Record that a generated behavior caught a real bug on a PR. Appends —
   * we deliberately do not dedupe, since the same behavior catching two
   * bugs in two PRs is stronger signal than one.
   */
  recordBugCaught(
    project: string,
    behaviorId: string,
    prUrl: string,
    severity: TestSeverity,
  ): void {
    const learnings = this.read(project);
    learnings.bugsCaught.push({
      behaviorId,
      prUrl,
      severity,
      recordedAt: new Date().toISOString(),
    });
    this.writeLearnings(project, learnings);
  }

  /**
   * Merge a mutation-score snapshot keyed by file path. New files are
   * added; existing files take the latest score (not an average — mutation
   * runs are usually authoritative for the current HEAD).
   */
  updateMutationScore(project: string, byFile: Record<string, number>): void {
    const learnings = this.read(project);
    for (const [file, score] of Object.entries(byFile)) {
      learnings.mutationScoreByFile[file] = score;
    }
    this.writeLearnings(project, learnings);
  }

  // ── Prompt rendering ──────────────────────────────────────────────────

  /**
   * Produce a concise calibration string suitable for injecting into the
   * generator/auditor prompt. Returns '' if there is not enough signal yet.
   */
  formatForPrompt(project: string): string {
    const l = readJsonSync<TestLearnings>(this.learningsPath(project));
    if (!l) return '';

    const hasSignal =
      l.flakyTests.length > 0 ||
      l.falsePositives.length > 0 ||
      l.bugsCaught.length > 0 ||
      Object.keys(l.mutationScoreByFile).length > 0 ||
      l.conventionDrift.length > 0;
    if (!hasSignal) return '';

    const lines: string[] = [];
    lines.push('## Test-generation calibration (from this project\'s history)');

    // Flaky tests — quarantine candidates.
    const flaky = [...l.flakyTests]
      .filter((f) => f.failureRate >= 0.1)
      .sort((a, b) => b.failureRate - a.failureRate)
      .slice(0, 10);
    if (flaky.length) {
      lines.push('**Known flaky cases — prefer deterministic assertions, mark `@flaky` if regenerated:**');
      for (const f of flaky) {
        lines.push(`- \`${f.caseId}\`: ${(f.failureRate * 100).toFixed(0)}% failure (last seen ${f.lastSeen})`);
      }
    }

    // False positives — behaviors to avoid re-raising.
    const fps = l.falsePositives.slice(-20);
    if (fps.length) {
      lines.push('**Behaviors with dismissed findings — only re-raise with strong evidence:**');
      for (const fp of fps) {
        const persona = fp.persona ? ` [${fp.persona}]` : '';
        lines.push(`- \`${fp.behaviorId}\`${persona}: ${fp.reason}`);
      }
    }

    // Bugs caught — wins to emulate.
    if (l.bugsCaught.length) {
      const ranked = [...l.bugsCaught]
        .sort((a, b) => (SEVERITY_WEIGHT[b.severity] ?? 0) - (SEVERITY_WEIGHT[a.severity] ?? 0))
        .slice(0, 10);
      lines.push('**Behaviors that previously caught real bugs — consider analogous cases:**');
      for (const b of ranked) {
        lines.push(`- \`${b.behaviorId}\` (${b.severity}): ${b.prUrl}`);
      }
    }

    // Mutation weakness — files that need more edge cases.
    const weakMutation = Object.entries(l.mutationScoreByFile)
      .filter(([, score]) => score < 0.6)
      .sort((a, b) => a[1] - b[1])
      .slice(0, 10);
    if (weakMutation.length) {
      lines.push('**Files with weak mutation coverage — prioritise edge-case behaviors:**');
      for (const [file, score] of weakMutation) {
        lines.push(`- \`${file}\`: ${(score * 100).toFixed(0)}% killed`);
      }
    }

    // Convention drift — rules we repeatedly have to skip.
    const drift = [...l.conventionDrift]
      .sort((a, b) => b.violations - a.violations)
      .slice(0, 10);
    if (drift.length) {
      lines.push('**Convention rules repeatedly waived — do not re-flag unless severity warrants:**');
      for (const d of drift) {
        lines.push(`- "${d.rule}" (${d.violations}× waived)`);
      }
    }

    lines.push(`_Updated ${l.updatedAt}._`);
    return lines.join('\n');
  }
}

// Re-export the persona type at the module boundary so callers that only
// import from test-learnings don't have to reach into test-types just for
// the optional `persona` field on recorded events.
export type { TestPersona };
