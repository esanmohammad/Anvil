/**
 * Phase 4f.7 tests — `prompt-builders` lift the 6 system / user prompt
 * builders + 2 helpers that `pipeline-runner.ts` carried for the agent
 * stages. Tests use a stub `PromptBuilderContext` so we exercise the
 * persona override paths, KB-on/off branches, manifest prefix, and
 * resume context without instantiating MemoryStore / KnowledgeBaseManager.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildClarifyExplorePrompt,
  buildManifestPrefix,
  buildPerTaskPrompt,
  buildProjectPrompt,
  buildRepoProjectPrompt,
  buildRepoStagePrompt,
  buildStagePrompt,
  injectTemplateVars,
  warnIfSystemPromptOversized,
  type PromptBuilderContext,
  type StageInfo,
  type KbTier,
} from '../steps/prompt-builders.js';
import type { ParsedTask } from '../engineer-task-bundler.js';

interface CtxOverrides {
  emit?: (event: string, payload: unknown) => void;
  kb?: { content: string; sourceLabel: string };
  kbTier?: KbTier | 'none';
  manifestBlock?: string;
  memoryBlock?: string;
  conventionsBlock?: string;
  hlReqs?: string;
  repoArtifacts?: { requirements: string; specs: string; tasks: string; build: string };
  failureContext?: string;
  actionType?: PromptBuilderContext['actionType'];
  baseBranch?: string;
  repoNames?: string[];
  projectYaml?: string;
  projectInfoRepos?: Array<{ name: string; github: string; language: string; repoKind: string; description: string }>;
  kbManager?: PromptBuilderContext['kbManager'];
}

function makeCtx(overrides: CtxOverrides = {}): PromptBuilderContext {
  const events: Array<{ event: string; payload: unknown }> = [];
  const ctx: PromptBuilderContext = {
    project: 'demo',
    feature: 'add login',
    model: 'claude',
    workspaceDir: '/tmp/ws',
    baseBranch: overrides.baseBranch ?? 'main',
    failureContext: overrides.failureContext,
    actionType: overrides.actionType,
    repoNames: overrides.repoNames ?? ['api', 'web'],
    featureSlug: 'add-login',
    projectYaml: overrides.projectYaml ?? 'project: demo',
    projectInfo: overrides.projectInfoRepos
      ? { repos: overrides.projectInfoRepos } as unknown as PromptBuilderContext['projectInfo']
      : null,
    repoPaths: { api: '/tmp/api', web: '/tmp/web' },
    getStableMemoryBlock: () => overrides.memoryBlock ?? '',
    getStableConventionsBlock: () => overrides.conventionsBlock ?? '',
    getStableProjectYamlSlice: (n) => (overrides.projectYaml ?? 'project: demo').slice(0, n),
    getStableKbBlock: () => overrides.kb ?? { content: '', sourceLabel: 'none' },
    getStableManifestBlock: () => overrides.manifestBlock ?? '',
    getLockedKbTier: () => overrides.kbTier ?? 'full',
    loadRepoArtifacts: () => overrides.repoArtifacts ?? { requirements: '', specs: '', tasks: '', build: '' },
    loadHighLevelRequirements: () => overrides.hlReqs ?? '',
    kbManager: overrides.kbManager ?? null,
    emit: overrides.emit ?? ((event, payload) => events.push({ event, payload })),
  };
  return ctx;
}

const EMPTY_PERSONA_STAGE: StageInfo = { name: 'unknown-stage-foo', persona: 'no-such-persona', label: 'Unknown' };

// ── injectTemplateVars ──────────────────────────────────────────────────

describe('injectTemplateVars', () => {
  it('replaces {{key}} placeholders with values', () => {
    const out = injectTemplateVars('Hello {{name}}, project {{proj}}!', { name: 'Anvil', proj: 'demo' });
    assert.equal(out, 'Hello Anvil, project demo!');
  });

  it('leaves untouched placeholders that have no value', () => {
    const out = injectTemplateVars('A {{a}} B {{b}}', { a: '1' });
    assert.equal(out, 'A 1 B {{b}}');
  });
});

// ── warnIfSystemPromptOversized ────────────────────────────────────────

describe('warnIfSystemPromptOversized', () => {
  it('emits a warn event when prompt exceeds 60KB', () => {
    const events: Array<{ event: string; payload: any }> = [];
    const ctx = makeCtx({ emit: (e, p) => events.push({ event: e, payload: p }) });
    warnIfSystemPromptOversized(ctx, 'engineer/build', 'x'.repeat(60_001));
    assert.equal(events.length, 1);
    assert.equal(events[0].event, 'project-event');
    assert.equal(events[0].payload.level, 'warn');
    assert.match(events[0].payload.message, /system prompt is/);
  });

  it('stays silent when prompt is under 60KB', () => {
    const events: Array<{ event: string; payload: unknown }> = [];
    const ctx = makeCtx({ emit: (e, p) => events.push({ event: e, payload: p }) });
    warnIfSystemPromptOversized(ctx, 'engineer/build', 'x'.repeat(59_999));
    assert.equal(events.length, 0);
  });
});

// ── buildManifestPrefix ────────────────────────────────────────────────

describe('buildManifestPrefix', () => {
  it('returns empty string when manifest block is empty (cache stability)', () => {
    assert.equal(buildManifestPrefix(makeCtx({ manifestBlock: '' })), '');
  });

  it('wraps the block with the manifest discipline section when populated', () => {
    const out = buildManifestPrefix(makeCtx({ manifestBlock: 'acceptance: [...]' }));
    assert.match(out, /## Feature manifest/);
    assert.match(out, /Manifest discipline:/);
    assert.match(out, /authoritative/);
  });
});

// ── buildClarifyExplorePrompt ──────────────────────────────────────────

describe('buildClarifyExplorePrompt', () => {
  it('includes the numbered-question format directive', () => {
    const out = buildClarifyExplorePrompt(makeCtx());
    assert.match(out, /1\. \*\*\[Question topic\]\*\*:/);
    assert.match(out, /Please answer these questions/);
  });

  it('uses the KB index path when kbManager has an index', () => {
    // Legacy threshold: kbReport.length > 100 → must produce a non-trivial blob.
    const fakeKb = {
      getIndexForPrompt: () => 'INDEX:repos\n' + 'x'.repeat(80),
      getQueryContextForPrompt: () => 'QUERY:login\n' + 'y'.repeat(50),
      getAllGraphReports: () => '',
    } as unknown as PromptBuilderContext['kbManager'];
    const out = buildClarifyExplorePrompt(makeCtx({ kbManager: fakeKb }));
    assert.match(out, /INDEX:repos/);
    assert.match(out, /QUERY:login/);
    assert.match(out, /## Codebase Knowledge Graph/);
  });

  it('falls back to plain exploration when no KB present', () => {
    const out = buildClarifyExplorePrompt(makeCtx());
    // No KB blob present (>100 chars threshold) → fallback exploration text.
    assert.match(out, /Explore the codebase thoroughly/);
  });
});

// ── buildStagePrompt ───────────────────────────────────────────────────

describe('buildStagePrompt', () => {
  it('produces the requirements stage prompt with prevArtifact context', () => {
    const ctx = makeCtx();
    const out = buildStagePrompt(ctx, { name: 'requirements', persona: 'analyst', label: 'Reqs' }, 'PRIOR ART');
    assert.match(out, /Feature: "add login"/);
    assert.match(out, /high-level requirements/);
    assert.match(out, /Repositories: api, web/);
    assert.match(out, /## Previous stage output:/);
    assert.match(out, /PRIOR ART/);
  });

  it('builds the ship stage prompt with PR labels reflecting actionType', () => {
    const ctx = makeCtx({ actionType: 'bugfix' });
    const out = buildStagePrompt(ctx, { name: 'ship', persona: 'engineer', label: 'Ship' }, '');
    assert.match(out, /--label "anvil"/);
    assert.match(out, /--label "bug"/);
    assert.match(out, /gh pr create --base "main"/);
  });

  it('appends the resume context when failureContext is set', () => {
    const ctx = makeCtx({ failureContext: 'previous run timed out' });
    const out = buildStagePrompt(ctx, { name: 'requirements', persona: 'analyst', label: 'Reqs' }, '');
    assert.match(out, /This is a RETRY/);
    assert.match(out, /previous run timed out/);
  });
});

// ── buildRepoStagePrompt ──────────────────────────────────────────────

describe('buildRepoStagePrompt', () => {
  it('routes repo-requirements to the per-repo prompt template', () => {
    const out = buildRepoStagePrompt(
      makeCtx({ hlReqs: 'HL:overall behavior' }),
      { name: 'repo-requirements', persona: 'analyst', label: 'Repo Reqs' },
      'api',
      'PREV',
    );
    assert.match(out, /requirements specific to the "api"/);
    assert.match(out, /## High-Level Requirements/);
    assert.match(out, /HL:overall behavior/);
    assert.match(out, /## Prior stage output:/);
  });

  it('routes specs to the spec-writer template using repo-scoped requirements', () => {
    const out = buildRepoStagePrompt(
      makeCtx({ repoArtifacts: { requirements: 'api req body', specs: '', tasks: '', build: '' } }),
      { name: 'specs', persona: 'architect', label: 'Specs' },
      'api',
      '',
    );
    assert.match(out, /## Requirements for api/);
    assert.match(out, /api req body/);
    assert.match(out, /detailed technical specification/);
  });

  it('routes build to the per-repo build template with task-bundle wiring', () => {
    const out = buildRepoStagePrompt(
      makeCtx({
        repoArtifacts: {
          requirements: '',
          specs: '',
          tasks: '### TASK-001: Add foo\n- **Scope**: `a.ts`\n',
          build: '',
        },
      }),
      { name: 'build', persona: 'engineer', label: 'Build' },
      'api',
      '',
    );
    assert.match(out, /## Implementation Tasks for api/);
    assert.match(out, /Read\/Grep\/Glob\/Agent are disabled/);
  });

  it('routes validate to the verdict-required template', () => {
    const out = buildRepoStagePrompt(
      makeCtx(),
      { name: 'validate', persona: 'tester', label: 'Validate' },
      'api',
      '',
    );
    assert.match(out, /VERDICT: PASS/);
    assert.match(out, /VERDICT: FAIL/);
    assert.match(out, /Validation Steps/);
  });
});

// ── buildPerTaskPrompt ──────────────────────────────────────────────────

describe('buildPerTaskPrompt', () => {
  it('builds the per-task prompt with header + task block + instructions', () => {
    const task: ParsedTask = {
      id: 'TASK-001',
      title: 'Add foo',
      files: [],
      specRef: null,
      prerequisites: [],
      block: '### TASK-001: Add foo\n- **Scope**: `a.ts`',
    };
    const out = buildPerTaskPrompt(makeCtx(), 'api', '/tmp/api', task, '');
    assert.match(out, /Feature: "add login"/);
    assert.match(out, /You are implementing exactly one task: TASK-001/);
    assert.match(out, /## Your task/);
    assert.match(out, /## Instructions/);
  });

  it('includes the prerequisite-tasks line when prerequisites are non-empty', () => {
    const task: ParsedTask = {
      id: 'TASK-002', title: 'B', files: [], specRef: null,
      prerequisites: ['TASK-001'], block: '### TASK-002: B',
    };
    const out = buildPerTaskPrompt(makeCtx(), 'api', '/tmp/api', task, '');
    assert.match(out, /Prerequisite tasks already complete: TASK-001/);
  });

  it('appends a retry-context section when failureContext is set', () => {
    const task: ParsedTask = {
      id: 'TASK-001', title: 'A', files: [], specRef: null,
      prerequisites: [], block: '### TASK-001: A',
    };
    const out = buildPerTaskPrompt(
      makeCtx({ failureContext: 'flaky test' }),
      'api', '/tmp/api', task, '',
    );
    assert.match(out, /This is a RETRY/);
    assert.match(out, /flaky test/);
  });
});

// ── buildProjectPrompt + buildRepoProjectPrompt — fallback path ────────

describe('buildProjectPrompt — persona-prompt fallback', () => {
  it('returns the minimal fallback when the persona file is missing', () => {
    // EMPTY_PERSONA_STAGE.persona doesn't exist → loadPersonaPromptSync returns ''.
    const out = buildProjectPrompt(makeCtx(), EMPTY_PERSONA_STAGE);
    assert.match(out, /You are the no-such-persona agent/);
    assert.match(out, /Project YAML:/);
  });
});

describe('buildRepoProjectPrompt — persona-prompt fallback', () => {
  it('returns the minimal per-repo fallback when persona file is missing', () => {
    const out = buildRepoProjectPrompt(makeCtx(), EMPTY_PERSONA_STAGE, 'api');
    assert.match(out, /You are the no-such-persona agent working on "api"/);
    assert.match(out, /Repository: api/);
  });

  it('includes repo info from projectInfo when available', () => {
    const ctx = makeCtx({
      projectInfoRepos: [{
        name: 'api',
        github: 'org/api',
        language: 'TypeScript',
        repoKind: 'service',
        description: 'API service',
      }],
    });
    const out = buildRepoProjectPrompt(ctx, EMPTY_PERSONA_STAGE, 'api');
    assert.match(out, /GitHub: org\/api/);
    assert.match(out, /Language: TypeScript/);
    assert.match(out, /Description: API service/);
  });
});
