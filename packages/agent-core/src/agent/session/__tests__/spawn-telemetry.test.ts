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

async function installInMemoryExporter(): Promise<void> {
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
      // Note: anvil.mcp.servers.count may still appear if the user has a
      // global ~/.claude/mcp.json (rank-5 fallback in findMcpConfigPath).
      // We assert only on per-workspace skill-absence to keep the test
      // robust across machines.
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
