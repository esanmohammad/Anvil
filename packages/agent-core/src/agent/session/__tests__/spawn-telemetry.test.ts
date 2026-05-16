/**
 * Phase 6 of AGENT-PROCESS-CONSOLIDATION — verify `defaultAdapterFactory`
 * surfaces skill + MCP discovery as attributes on the active session span.
 *
 * Three cases:
 *   1. workspace with .claude/skills/foo/SKILL.md → session span carries
 *      anvil.skills.activated.count + .names.
 *   2. workspace with no skills + no mcp.json → no attrs (absence-stays-
 *      absent per observability ADR §O7).
 *   3. workspace with mcp.json → anvil.mcp.servers.count set.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trace, context as otelContext } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

import { resetTracer, getTracer } from '../../../telemetry/tracer.js';
import { enrichRequestWithWorkspace } from '../default-adapter-factory.js';
import type { AdapterRequest } from '../adapter.js';

let exporter: InMemorySpanExporter;
let provider: NodeTracerProvider;

/**
 * Sandbox HOME (and USERPROFILE on Windows) so the global fallbacks
 * inside `resolveSkillsDir` (`$HOME/.claude/skills/`) and
 * `findMcpConfigPath` (`$HOME/.claude/mcp.json`) can never observe the
 * developer's or CI runner's real home dir. Without this seam, the test
 * "empty workspace: no skill attrs (absence stays absent)" was flaky
 * because users with `~/.claude/skills/*` (common — claude-cli skills,
 * personal helpers) would surface a non-zero count.
 */
let sandboxHome: string | null = null;
let savedHome: string | undefined;
let savedUserprofile: string | undefined;

function installHomeSandbox(): void {
  sandboxHome = mkdtempSync(join(tmpdir(), 'anvil-tel-home-'));
  savedHome = process.env.HOME;
  savedUserprofile = process.env.USERPROFILE;
  process.env.HOME = sandboxHome;
  process.env.USERPROFILE = sandboxHome;
}

function uninstallHomeSandbox(): void {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedUserprofile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = savedUserprofile;
  if (sandboxHome) rmSync(sandboxHome, { recursive: true, force: true });
  sandboxHome = null;
}

async function installInMemoryExporter(): Promise<void> {
  installHomeSandbox();
  await resetTracer();
  exporter = new InMemorySpanExporter();
  provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: 'anvil-spawn-telemetry-test' }),
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  provider.register();
}

async function uninstallInMemoryExporter(): Promise<void> {
  try {
    await provider.forceFlush();
    await provider.shutdown();
  } catch {
    /* best-effort */
  }
  exporter.reset();
  trace.disable();
  uninstallHomeSandbox();
}

function makeRequest(overrides: Partial<AdapterRequest> = {}): AdapterRequest {
  return {
    prompt: 'do thing',
    model: 'qwen2.5-coder:7b',
    sessionId: 'sess-test',
    cwd: '/tmp',
    ...overrides,
  };
}

function makeWorkspaceWithSkill(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'anvil-skill-tel-'));
  const skillDir = join(dir, '.claude', 'skills', 'tel-skill');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    '---\nname: tel-skill\ndescription: Telemetry test skill.\n---\n\n# Body\n',
  );
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function makeWorkspaceWithMcp(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'anvil-mcp-tel-'));
  writeFileSync(
    join(dir, 'mcp.json'),
    JSON.stringify({ mcpServers: { tel: { command: 'echo', args: ['hi'] } } }),
  );
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function makeEmptyWorkspace(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'anvil-empty-tel-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Run `enrichRequestWithWorkspace` inside a parent span so the factory can
 * observe an active span via `trace.getActiveSpan()`. Returns the recorded
 * span by name.
 */
function runUnderParentSpan(name: string, fn: () => void): ReadableSpan {
  const tracer = getTracer();
  const span = tracer.startSpan(name);
  const ctx = trace.setSpan(otelContext.active(), span);
  otelContext.with(ctx, fn);
  span.end();

  const found = exporter.getFinishedSpans().find((s) => s.name === name);
  if (!found) {
    throw new Error(`Expected to find span "${name}"; got ${exporter.getFinishedSpans().map((s) => s.name).join(', ')}`);
  }
  return found;
}

describe('defaultAdapterFactory telemetry', () => {
  beforeEach(installInMemoryExporter);
  afterEach(uninstallInMemoryExporter);

  it('skills present: anvil.skills.activated.count + .names on active span', () => {
    const ws = makeWorkspaceWithSkill();
    try {
      const span = runUnderParentSpan('test.session', () => {
        enrichRequestWithWorkspace(
          makeRequest({ workspaceDir: ws.dir, model: 'qwen2.5-coder:7b' }),
          'ollama',
        );
      });
      assert.equal(span.attributes['anvil.skills.activated.count'], 1);
      const names = span.attributes['anvil.skills.activated.names'] as string;
      assert.ok(names && names.includes('tel-skill'), `expected names attr to include 'tel-skill', got "${names}"`);
    } finally {
      ws.cleanup();
    }
  });

  it('empty workspace: no skill attrs (absence stays absent)', () => {
    const ws = makeEmptyWorkspace();
    try {
      const span = runUnderParentSpan('test.session', () => {
        enrichRequestWithWorkspace(
          makeRequest({ workspaceDir: ws.dir, model: 'qwen2.5-coder:7b' }),
          'ollama',
        );
      });
      assert.equal(span.attributes['anvil.skills.activated.count'], undefined);
      assert.equal(span.attributes['anvil.skills.activated.names'], undefined);
      // With the HOME sandbox in beforeEach, no global skills can leak in
      // from the developer's or CI runner's actual home directory, so MCP
      // discovery should also stay silent — but only when the user has no
      // workspace-level mcp.json, which makeEmptyWorkspace() guarantees.
      assert.equal(span.attributes['anvil.mcp.servers.count'], undefined);
    } finally {
      ws.cleanup();
    }
  });

  it('mcp present: anvil.mcp.servers.count surfaces on active span', () => {
    const ws = makeWorkspaceWithMcp();
    try {
      const span = runUnderParentSpan('test.session', () => {
        enrichRequestWithWorkspace(
          makeRequest({ workspaceDir: ws.dir, model: 'claude-sonnet-4-6' }),
          'claude',
        );
      });
      assert.equal(span.attributes['anvil.mcp.servers.count'], 1);
    } finally {
      ws.cleanup();
    }
  });
});
