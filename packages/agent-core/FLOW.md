# `@anvil/agent-core` — Flows

Sequence-style descriptions of the core paths through the package. Every
arrow + box maps to actual symbols in `src/`. See `ARCHITECTURE.md` for the
static module map.

## 1. Single-shot — `runLLM` / `runClaude` / `runGemini`

Used by knowledge-core (repo profiler, service-mesh inferrer, RAG
evaluator) and any analytical caller that wants `prompt + system → text`.

```
caller
  │
  │  runLLM(prompt, system, { provider:'claude', model, timeoutMs })
  ▼
src/single-shot.ts
  ├─ loadLlmConfig()  ← cached; reads ANVIL_LLM_MODE / API_KEY / BIN
  │      (legacy aliases warn once on stderr)
  ├─ provider === 'gemini' ? runGemini : runClaude
  └─ runClaude:
       │
       ├─ withInvokeSpan({ provider:'claude', model, ...}, exec, applyResult)
       │     │
       │     ▼
       │  starts gen_ai.invoke span
       │     │
       │     │   if mode === 'api' → runViaApi  (HTTP fetch to api.anthropic.com or OpenAI-compat)
       │     │   else              → runViaCli  (spawn claude --output-format stream-json)
       │     │
       │     ▼
       │  ClaudeResult { result, costUsd, inputTokens, outputTokens, durationMs }
       │     │
       │     ▼
       │  applyResult — sets span attrs:
       │     gen_ai.usage.input_tokens / output_tokens
       │     gen_ai.usage.cost_{input,output,total}_usd  (from cost.ts)
       │     anvil.duration_ms / anvil.transport
       │
       └─ returns ClaudeResult
```

Subprocess tracking: every spawn is added to `activeProcesses` Set.
SIGINT / SIGTERM handlers iterate and `proc.kill('SIGTERM')` to prevent
orphans.

## 2. Streaming agent run — `AgentManager.spawn()`

The dashboard / cli use this for the build / validate / ship stages.

```
caller
  │
  │  manager.spawn(spec: SpawnConfig)
  ▼
AgentManager (src/agent/session/session-registry.ts)
  ├─ proc = new AgentProcess(spec, { adapterFactory, now, setTimeoutImpl })
  ├─ checkpointHook?.lookup(...) ?
  │      hit → state.status='done', appendOutput(hit.output),
  │            nextTick(() => emit('agent-done')), return state
  ├─ wireProcess(agentId, proc, spec)  ← re-emit content/activity/result/exit
  ├─ proc.start()
  └─ return proc.getState()                     ← status='running'

AgentProcess.start() (session.ts)
  ├─ openSessionSpan()                ← anvil.agent.session
  ├─ adapter = factory(buildAdapterRequest(spec, sessionId))
  │     │
  │     ▼ defaultAdapterFactory (default-adapter-factory.ts)
  │       ├─ provider = resolveProvider(model)
  │       ├─ rawAdapter = ProviderRegistry.get(provider) || claude
  │       └─ return new LanguageModelBridge(req, rawAdapter, provider)
  │                  ↑ already wrapped by instrumentModelAdapter at
  │                    register time
  ├─ wireAdapter(adapter)             ← bridge → AgentProcess events
  ├─ otelContext.with(sessionContext, () => adapter.start())
  └─ status='running'

LanguageModelBridge.start() (language-model-bridge.ts)
  └─ runAdapter():
       ├─ sink = createStreamSink()         ← Writable parsing NDJSON
       ├─ result = await this.adapter.run(buildAdapterConfig(), sink)
       │     │
       │     ▼  instrumentModelAdapter wrapper opens gen_ai.invoke span
       │        as a CHILD of anvil.agent.session (AsyncLocalStorage
       │        propagates the session context)
       │
       │   while running, sink.write() lines arrive:
       │     handleStreamLine(line)
       │       ├─ {type:'assistant', message.content[]} → handleAssistantBlocks
       │       │     ├─ {type:'text'}      → emit 'content', emit 'activity'(kind:text)
       │       │     ├─ {type:'tool_use'}  → emit 'activity'(kind:tool_use)
       │       │     │                       openToolSpan(name, input, id)
       │       │     │                         ← gen_ai.tool.<name> child span
       │       │     └─ {type:'thinking'}  → emit 'activity'(kind:thinking)
       │       └─ {type:'user', message.content[]} → handleUserBlocks
       │             └─ {type:'tool_result', tool_use_id, is_error}
       │                                    closeToolSpan(toolUseId,{isError})
       │
       ├─ closeOpenToolSpans()  ← any tool whose tool_result never came
       ├─ if runError: emit 'error-output', emit 'exit'(1)
       └─ if result:
              emit 'result', { result, cost, sessionId }
              emit 'exit'(0)

AgentProcess.wireAdapter (session.ts)
  ├─ on 'content'  → appendOutput(state, chunk); emit 'content'
  ├─ on 'activity' → pushActivity(state, activity); emit 'activity'
  ├─ on 'result'   → status='done', accumulate cost, span attrs
  │                  (anvil.agent.total_cost_usd / total_*_tokens),
  │                  emit 'result', closeSessionSpan('done')
  ├─ on 'error-output' → state.error+=text; emit 'error-output'
  └─ on 'exit' (code) →
        already done/killed? emit 'exit', return
        non-zero?            status='error', closeSessionSpan('error')
        zero + grace window:
            elapsed<5s & no output & cost=0 → 'error'
            else                            → 'done'

AgentManager.wireProcess
  ├─ on 'content'      → emit 'agent-output',   { agentId, chunk }
  ├─ on 'activity'     → emit 'agent-activity', { agentId, activity }
  ├─ on 'result' (data)→ fireCostHook(...)        ← ledger / cost-reject
  │                       fireCheckpointRecord(...)← cache the output
  │                       emit 'agent-done',     { agent: state }
  ├─ on 'error-output' → emit 'agent-error',     { agentId, error }
  └─ on 'exit'         → state.status='error'? emit 'agent-error'
                         state.status='done' && finishedAt!=startedAt
                                                 ? emit 'agent-done'
```

### 2.1 Resume — `AgentProcess.sendInput(text)`

```
sendInput(text)
  ├─ appendOutput("\n\n> User: " + text + "\n\n"); emit 'content'
  ├─ status='running'; finishedAt=null
  ├─ resumeAdapter = factory(buildAdapterRequest(spec', sessionId, {resume:true, cwdOverride}))
  ├─ wireAdapter(resumeAdapter)
  └─ otelContext.with(sessionContext, () => resumeAdapter.start())
                            ↑ same session span; the resume's gen_ai.invoke
                              becomes a sibling of the initial run's invoke
```

`accumulateCost` adds resume cost into the running aggregate;
`stopReason` of the most recent call wins.

## 3. `LlmRouter.invoke()` — chain walk

```
caller
  │  invokeWithSpans(router, opts)             ← router/telemetry.ts
  ▼
opens anvil.router.invoke parent span (tag, run_id, project, user)
  │
  ▼
LlmRouter.invoke(opts)                         ← router/router.ts
  ├─ enforceBudgetPreflight(opts)
  │      ├─ computeRemainingBudget (daily / per-run / per-tag)
  │      └─ if <=0 and onBreach='fail' → throw
  │
  ├─ chain = buildChain(opts)
  │     opts.model pinned? → [{ model: opts.model }]
  │     else → [{ model: route.primary }, ...route.fallbacks]
  │
  └─ for step in chain:
       │
       ├─ if step>0 && priorAttempted && !shouldTryFallback(link, lastErrorClass)
       │      continue  ← `on:` gate didn't match
       │
       ├─ adapter = resolver.resolve(link.model)
       ├─ if !circuitBreaker.canAttempt(adapter.provider) continue
       ├─ circuitBreaker.reserveAttempt(adapter.provider)
       │
       ├─ retryRun = await runWithRetry(
       │       fn = async () => {
       │         await rateLimiter.acquire(adapter.provider, estimatedTokens)
       │         return adapter.invoke(llmOpts)
       │       },
       │       { policyFor, classify, sleep, now, random, signal }
       │   )
       │   └─ retry: per-error-class RetryPolicy (attempts/backoff/baseMs/maxMs/jitter)
       │      classify uses errorClassifiers[provider] then classifyError
       │
       ├─ ledger.record({ ts, runId, project, user, tag, provider, model,
       │                  tokens, costUsd, durationMs, fallbackIndex,
       │                  attemptCount, errorClass })
       │   └─ writes one row to ~/.anvil/router/spend.sqlite
       │
       ├─ retryRun.result?
       │     yes → circuitBreaker.recordSuccess(provider)
       │           opens anvil.router.attempt child span (per attempt)
       │           return RouteOutcome { result, attempts, totalCostUsd, budgetRemainingUsd }
       │     no  → if !isTerminal(lastErrorClass): circuitBreaker.recordFailure
       │           else break (auth / content_policy / invalid_request)
       │           if totalCostUsd > maxFallbackCostUsd: break
       │
       └─ chain exhausted → throw RouterError(...)
```

Terminal classes (`auth`, `content_policy`, `invalid_request`) never
trigger fallback. `content_policy` specifically never crosses providers.

`gen_ai.invoke` spans (from `instrumentModelAdapter` or future native
LanguageModel impls) become grandchildren of `anvil.router.invoke`
through the OTel context preserved by `runWithRetry`.

## 4. Headless `runAgent` (Inspect-AI contract)

```
runAgent(task, workspace, options)             ← src/headless/runner.ts
  │
  ├─ if !options.model: throw  ← caller MUST inject a LanguageModel
  │
  ├─ skillContext = composeSkillContext(task.systemPrompt, {
  │       workspaceRoot, allowedTools: task.allowedTools
  │    })
  │     │
  │     ▼ src/skills/compose.ts
  │       resolveSkillsDir → loadSkills → activateSkills(maxBytes=32 KB)
  │       → renderSkillsForPrompt → applyToolPolicy
  │
  ├─ mcpServers = loadMcpServers({ workspaceRoot })   ← src/mcp/config-loader.ts
  ├─ mcpClients = mcpServers.map(c => new McpAgentClient(c))
  ├─ { tools, mcpDispatch } = await buildAgentToolset(builtIn, mcpClients)
  │
  ├─ messages.push({ role:'system', content: systemPrompt })
  ├─ messages.push({ role:'user',   content: task.prompt })
  │
  ├─ loop until iterations >= maxToolLoopIterations (default 25):
  │    │
  │    ├─ Date.now() > deadline? finishReason='error' break
  │    │
  │    ├─ result = await options.model.invoke({
  │    │     model, messages, tools, maxTokens, temperature
  │    │   })
  │    │
  │    ├─ usage += result.usage; costUsd += result.costUsd
  │    ├─ messages.push({ role:'assistant', content: result.text })
  │    │
  │    ├─ result.toolCalls.length === 0?
  │    │     finalAnswer = result.text
  │    │     finishReason = result.finishReason==='length' ? 'length' : 'end'
  │    │     break
  │    │
  │    └─ for each call in result.toolCalls:
  │         ├─ deadline check
  │         ├─ callRecord = await dispatchToolCall(call, mcpDispatch, builtInDispatch, workspace)
  │         │     │
  │         │     ├─ mcpDispatch.get(call.name)? → mcpClient.callTool(name, args)
  │         │     ├─ else builtInDispatch?       → builtInDispatch(name, args, workspace)
  │         │     └─ else                        → error: "No dispatcher for tool ..."
  │         │
  │         ├─ toolCalls.push(callRecord)
  │         └─ messages.push({ role:'tool', name, toolCallId, content: JSON.stringify(...) })
  │
  ├─ if iterations >= max && finishReason==='tool-use':
  │       finishReason = 'length'
  │       error = 'tool-loop iterations exhausted'
  │
  └─ finally: Promise.all(mcpClients.map(c => c.close().catch(noop)))

returns AgentTrajectory {
  messages, toolCalls, model, usage, costUsd,
  finalAnswer, finishReason, error?, durationMs
}
```

## 5. `runWithCheckpoint` — cache-aware agent call

```
runWithCheckpoint(store, blobs, opts)          ← src/checkpoint/runner.ts
  │
  ├─ key = computeKey(opts.runFamily, opts.inputs)
  │     └─ sha256( stable(stage, taskId, promptVersion, toolVersions, model, inputs) )
  │
  ├─ existing = store.get(project, runFamily, key)
  ├─ existing?.status==='completed' && blobs.exists(existing.outputRef)?
  │     bytes = blobs.read(outputRef)
  │     if bytes: opts.onHit?(existing); return opts.deserialize(bytes)
  │     ↑ NO agent invocation
  │
  ├─ opts.onMiss?()
  ├─ store.begin(project, runFamily, opts.inputs, opts.cost)
  │
  ├─ // Per-call SIGTERM/SIGINT handlers — own closures so concurrent
  │  // wrappers don't trip each other up. registeredWrappers WeakSet
  │  // tracks for leak-detection only.
  │  for sig in [SIGTERM, SIGINT]:
  │     fn = (s) => store.interrupt(project, runFamily, key, undefined, `signal:${s}`)
  │                 + opts.onInterrupt?.(s)
  │     process.on(sig, fn); handlers.push({sig, fn})
  │
  ├─ try:
  │     out = await opts.run()                  ← the actual agent call
  │     interrupted? return out (caller decides whether to honor)
  │     payload = opts.serialize(out)
  │     store.complete(project, runFamily, key, payload, opts.cost)
  │     return out
  │  catch err:
  │     !interrupted? store.fail(project, runFamily, key, err.message)
  │     throw
  │  finally:
  │     for {sig, fn} of handlers: process.off(sig, fn)
  │     registeredWrappers.delete(registry)
```

On-disk layout:

```
<anvilHome>/checkpoints/<project>/<runFamily>/<stage>/<hash>.json
<anvilHome>/checkpoints/_blobs/<sha[0:2]>/<sha>
```

All record writes go through tmp + `renameSync` for atomicity.

## 6. Provider resolution path (model-id → adapter)

Two slightly different resolvers exist; both end at `ProviderRegistry`:

```
defaultAdapterFactory.resolveProvider(modelId)
  ├─ id startsWith 'ollama:'                          → 'ollama'
  ├─ id startsWith 'gemini-'                          → cli on PATH ? 'gemini-cli' : 'gemini'
  ├─ id startsWith gpt-/o1/o3/o4/chatgpt-             → 'openai'
  ├─ id includes '/'                                  → 'openrouter'
  ├─ /^[a-z0-9_.-]+:[a-z0-9_.-]+$/ && !claude         → 'ollama'
  └─ default                                          → 'claude'

ProviderRegistry.resolveFromModelId(modelId)         ← simpler; used by stage resolver
  ├─ claude-* | sonnet | opus | haiku                 → 'claude'
  ├─ gpt-* | o1* | o3* | o4* | chatgpt-*              → 'openai'
  ├─ gemini-*                                         → 'gemini'
  ├─ contains '/'                                     → 'openrouter'
  └─ default                                          → 'claude'

ProviderRegistry.resolveForStage(stage, modelId, providerOverride?)
  ├─ providerName = override ?? resolveFromModelId(modelId)
  ├─ adapter = adapters.get(providerName)  ← fall back to claude with warning
  └─ AGENTIC_STAGES.has(stage) && adapter.tier !== 'agentic'
       → fall back to claude with warning
```

## 7. Telemetry context propagation

```
anvil.router.invoke   (router/telemetry.ts:invokeWithSpans)
  └─ anvil.router.attempt   (per RouteAttempt — opened in router.ts inside loop)
        └─ gen_ai.invoke    (instrumentModelAdapter or future native LanguageModel)
              └─ gen_ai.tool.<name>   (LanguageModelBridge per tool_use)

OR (driven via AgentProcess instead of router):

anvil.agent.session   (session.ts:openSessionSpan)
  └─ gen_ai.invoke    (initial run + every resume become siblings)
        └─ gen_ai.tool.<name>
```

Context propagation uses Node's `AsyncLocalStorage` (via OTel
`context.with`). Adapters do NOT manipulate context themselves — the
seam is at the registry wrap and at `AgentProcess.runWithSessionContext`.

## 8. Cost calculation hand-off

```
adapter.run(...) returns ModelAdapterResult {
   inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
   reasoningTokens, costUsd, ...
}
                                       │
                                       ▼
instrumentModelAdapter (telemetry/instrument.ts)
  └─ bd = calculateCostBreakdown(result.model, usage)        ← cost.ts
        │
        ├─ MODEL_ALIASES[model] || model → LiteLLM key
        ├─ loadModelPrices()['key'] → input/output/cache rates
        └─ returns { inputUsd, outputUsd, cacheReadUsd, cacheWriteUsd, totalUsd }

  totalUsd = bd.totalUsd > 0 ? bd.totalUsd : result.costUsd
                                       │
                                       ├─ span.setAttribute(GenAi.USAGE_COST_*)
                                       └─ recordGenAiCall({...}) → metrics/OTLP
```

`calculateCostBreakdown` is silent (returns 0) for unknown models;
the wrapper falls back to the adapter's reported `costUsd` so we never
undercount.
