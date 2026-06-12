/**
 * Phase 8 tests for router OTel spans.
 *
 * Verifies:
 *   - 1 parent `anvil.router.invoke` per call
 *   - 1 child `anvil.router.attempt` per RouteAttempt
 *   - R10 attributes present on parent + child
 *   - Status codes set correctly on success / failure
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

import { resetTracer } from '../telemetry/tracer.js';
import {
  LlmRouter,
  DEFAULT_RETRY_POLICY,
  invokeWithSpans,
  ROUTER_INVOKE_SPAN,
  ROUTER_ATTEMPT_SPAN,
  RouterAttr,
} from '../router/index.js';
import type { RouterConfig, AdapterResolver } from '../router/index.js';
import type {
  LanguageModel,
  LanguageModelInvokeOptions,
  InvokeResult,
  ProviderCapabilities,
  ProviderName,
  StreamEvent,
} from '../types.js';

// ── Test-local OTel provider ───────────────────────────────────────────────

let exporter: InMemorySpanExporter;
let provider: NodeTracerProvider;

async function installInMemoryExporter(): Promise<void> {
  await resetTracer();
  exporter = new InMemorySpanExporter();
  provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: 'anvil-router-test' }),
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  provider.register();
}

async function tearDownExporter(): Promise<void> {
  await exporter.shutdown();
  await provider.shutdown();
  await resetTracer();
  trace.disable();
}

beforeEach(installInMemoryExporter);
afterEach(tearDownExporter);

// ── Fakes ──────────────────────────────────────────────────────────────────

const fakeCapabilities: ProviderCapabilities = {
  tier: 'function-calling',
  streaming: false,
  toolUse: false,
  fileSystem: false,
  shellExecution: false,
  sessionResume: false,
};

function fakeOk(model = 'm', costUsd = 0.001): InvokeResult {
  return {
    text: 'ok',
    toolCalls: [],
    usage: { inputTokens: 1, outputTokens: 1 },
    costUsd,
    durationMs: 1,
    provider: 'claude',
    model,
    finishReason: 'end',
  };
}

function makeMatrix(
  models: Record<
    string,
    { provider: ProviderName; responses: Array<{ ok?: () => InvokeResult; err?: () => unknown }> }
  >,
): AdapterResolver {
  const calls: Record<string, number> = {};
  return {
    resolve: (id) => {
      const def = models[id];
      if (!def) throw new Error(`unknown ${id}`);
      calls[id] = calls[id] ?? 0;
      const adapter: LanguageModel = {
        provider: def.provider,
        capabilities: fakeCapabilities,
        supportsModel: () => true,
        getModelPricing: () => null,
        checkAvailability: async () => ({ available: true }),
        invokeStream: async function* (): AsyncGenerator<StreamEvent, InvokeResult> {
          throw new Error('invokeStream not exercised in this telemetry test');
        },
        invoke: async (_o: LanguageModelInvokeOptions) => {
          const idx = calls[id];
          calls[id] = idx + 1;
          const r = def.responses[idx];
          if (!r) throw new Error(`${id}: out of responses`);
          if (r.err) throw r.err();
          return r.ok!();
        },
      };
      return adapter;
    },
  };
}

const noRetry: RouterConfig['retryPolicy'] = {
  ...DEFAULT_RETRY_POLICY,
  rate_limit: { ...DEFAULT_RETRY_POLICY.rate_limit, attempts: 0 },
  server_5xx: { ...DEFAULT_RETRY_POLICY.server_5xx, attempts: 0 },
  timeout: { ...DEFAULT_RETRY_POLICY.timeout, attempts: 0 },
  unknown: { ...DEFAULT_RETRY_POLICY.unknown, attempts: 0 },
};

function spansByName(name: string): ReadableSpan[] {
  return exporter.getFinishedSpans().filter((s) => s.name === name);
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('invokeWithSpans (Phase 8)', () => {
  it('emits 1 parent + 1 attempt span on simple success', async () => {
    const router = new LlmRouter({
      config: {
        routes: [{ tag: 'planner', primary: 'm' }],
        retryPolicy: noRetry,
      },
      resolver: makeMatrix({ m: { provider: 'claude', responses: [{ ok: () => fakeOk('m') }] } }),
    });
    const out = await invokeWithSpans(router, { tag: 'planner', prompt: 'q', runId: 'r-1' });
    assert.equal(out.result?.text, 'ok');

    const parents = spansByName(ROUTER_INVOKE_SPAN);
    const attempts = spansByName(ROUTER_ATTEMPT_SPAN);
    assert.equal(parents.length, 1);
    assert.equal(attempts.length, 1);

    const parent = parents[0];
    assert.equal(parent.attributes[RouterAttr.TAG], 'planner');
    assert.equal(parent.attributes[RouterAttr.RUN_ID], 'r-1');
    assert.equal(parent.attributes[RouterAttr.ATTEMPT_COUNT], 1);
    assert.equal(parent.status.code, SpanStatusCode.OK);

    const child = attempts[0];
    assert.equal(child.attributes[RouterAttr.PROVIDER], 'claude');
    assert.equal(child.attributes[RouterAttr.MODEL], 'm');
    assert.equal(child.attributes[RouterAttr.ATTEMPT], 0);
    assert.equal(child.attributes[RouterAttr.FALLBACK_INDEX], 0);
    assert.equal(child.status.code, SpanStatusCode.OK);
  });

  it('emits one attempt span per RouteAttempt across a fallback walk', async () => {
    const router = new LlmRouter({
      config: {
        routes: [
          { tag: 'planner', primary: 'a', fallbacks: [{ model: 'b' }] },
        ],
        retryPolicy: noRetry,
      },
      resolver: makeMatrix({
        a: {
          provider: 'claude',
          responses: [{ err: () => Object.assign(new Error('500'), { status: 500 }) }],
        },
        b: { provider: 'openai', responses: [{ ok: () => fakeOk('b') }] },
      }),
    });
    const out = await invokeWithSpans(router, { tag: 'planner', prompt: 'q' });
    assert.equal(out.result?.model, 'b');

    const attempts = spansByName(ROUTER_ATTEMPT_SPAN);
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].attributes[RouterAttr.ERROR_CLASS], 'server_5xx');
    assert.equal(attempts[0].status.code, SpanStatusCode.ERROR);
    assert.equal(attempts[1].attributes[RouterAttr.FALLBACK_INDEX], 1);
    assert.equal(attempts[1].status.code, SpanStatusCode.OK);
  });

  it('marks the parent span ERROR on terminal failure', async () => {
    const router = new LlmRouter({
      config: {
        routes: [{ tag: 'planner', primary: 'm' }],
        retryPolicy: noRetry,
      },
      resolver: makeMatrix({
        m: {
          provider: 'claude',
          responses: [{ err: () => Object.assign(new Error('401'), { status: 401 }) }],
        },
      }),
    });
    await assert.rejects(invokeWithSpans(router, { tag: 'planner', prompt: 'q' }));
    const parent = spansByName(ROUTER_INVOKE_SPAN)[0];
    assert.equal(parent.status.code, SpanStatusCode.ERROR);
    const child = spansByName(ROUTER_ATTEMPT_SPAN)[0];
    assert.equal(child.attributes[RouterAttr.ERROR_CLASS], 'auth');
  });
});
