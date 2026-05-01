# `@anvil/memory-core` — Flows

Sequence-style descriptions of the core paths through the package. Every
arrow + box maps to actual symbols in `src/`. See `ARCHITECTURE.md` for
the static module map.

## 1. Write path — `HybridMemoryStore.add(memory)`

```
caller (auto-learner via ProposalQueue, or migration importer)
  │
  │  store.add(m: Memory)
  ▼
HybridMemoryStore.add (src/storage/hybrid-store.ts)
  ├─ result = scrubMemory(m)
  │     │
  │     ▼  text = typeof content === 'string' ? content : safeStringify(content)
  │        scrub(text, scrubberOpts)   ← src/scrubber/scrub.ts
  │           ├─ resolveScrubMode(env) → 'off' | 'regex' | 'llm'
  │           ├─ if mode==='off' return passthrough
  │           └─ for rule in SCRUB_RULES:
  │                replace(rule.pattern, rule.placeholder)
  │                rule.category === 'credential' ? hardReject = true
  │
  ├─ result.hardReject?
  │      throw new HardRejectError(message, redactions)
  │      ↑ caller MUST catch — credential rules block the write
  │
  ├─ cleaned = applyScrubResult(m, result)
  │     │      stringContent → ...m, content: result.cleaned
  │     │      structured     → JSON.parse(cleaned) round-trip if possible
  │     │                       else leave content untouched
  │     ▼
  ├─ jsonl.append(cleaned)            ← src/storage/jsonl-store.ts
  │     fs.appendFileSync(filePath, JSON.stringify(m) + '\n')
  │
  └─ sqlite.upsert(cleaned)           ← src/storage/sqlite-store.ts
        db.transaction(() => {
          upsertMemoryRow(m)          ← INSERT OR REPLACE INTO memory(...)
          replaceTags(m.id, m.tags)   ← memory_tag many-to-many
          replaceFts(m.id, contentText) ← memory_fts virtual table
          replaceEdges(m.id, m.links, validAt) ← memory_edge
        })()

returns ScrubResult | null  (null when no scrubbing was needed)
```

If SQLite write fails, the JSONL append already succeeded —
`rebuildIndexFromJsonl()` is the recovery path.

## 2. Read path — `HybridMemoryStore.query(ns, opts)`

```
store.query(ns, opts)
  │
  ├─ search = { limit: opts.limit, namespace: ns }
  └─ runQuery(opts, search, ns):
       opts.text?    → sqlite.searchByText(opts.text, search)   ← FTS5 BM25
       opts.tags?    → sqlite.searchByTags(opts.tags, search)   ← memory_tag
       opts.validAt? → sqlite.validAtTime(opts.validAt, search) ← bitemporal
       else          → allInNamespace(ns, opts.limit)           ← scan
                       ↑ ORDER BY confidence DESC, last_accessed DESC

  applyBitemporalFilter(rows, opts):
    opts.includeInvalidated || opts.validAt? return rows
    else filter out rows with bitemporal.invalidAt set
```

`queryAll(opts)` is the same flow without the namespace filter — used
by migrations + `--scope=*` admin paths.

## 3. Bi-temporal soft-delete — `store.invalidate(id, ...)`

```
invalidate(id, invalidAt, reason, runId?)
  │
  ├─ before = sqlite.findById(id)
  ├─ if !before return false
  ├─ sqlite.invalidate(id, invalidAt, reason, runId)
  │      UPDATE memory SET invalid_at=?, prov_invalidated_run_id=?,
  │                         prov_invalidated_reason=? WHERE id=?
  │
  ├─ after = sqlite.findById(id)
  ├─ jsonl.append(after)             ← tombstone record in audit trail
  └─ return true
```

`pruneExpired(now?)` walks `memory` for rows whose `expires_at < now`
and invalidates each via the same path.

`hardDeleteInvalidatedOlderThan(cutoff)` is the only path that
physically drops rows. JSONL is NOT rewritten — the audit trail
survives.

## 4. Hybrid retrieval — `hybridSearch(store, query, opts)`

```
hybridSearch(store, query, opts)              ← src/retrieve/hybrid.ts
  │
  ├─ bm25Hits   = bm25Search(store, query, { namespace, limit:20 })
  │      └─ store.searchByText(query, ...) over FTS5
  │
  ├─ vectorHits = await vectorSearch(store, query, { namespace, limit:20 })
  │      └─ stub today: returns []
  │         (LanceDB lookup planned; sleeptime will populate embeddings)
  │
  ├─ seeds = dedupeById([...bm25Hits, ...vectorHits])
  │
  ├─ graphHits = expandNeighbors(store, seeds, { limit:20 })
  │      └─ store.neighborsOf(seedIds, opts) → memory_edge 1-hop
  │
  └─ reciprocalRankFusion([                   ← src/retrieve/fusion.ts
       { results: bm25Hits,   weight: 1.0 },
       { results: vectorHits, weight: 1.0 },
       { results: graphHits,  weight: 0.5 },
     ], { k: 60, limit })
       └─ score(m) = Σ_stream weight / (k + rank(m, stream))
       └─ sort desc, slice to limit
```

## 5. Personalized PageRank retrieval — `pprSearch`

```
pprSearch(store, namespace, seeds, opts)       ← src/retrieve/ppr-search.ts
  │
  ├─ seedMap = Array.isArray(seeds)
  │              ? Map(seeds.map(id => [id, 1]))
  │              : seeds
  │
  ├─ { adjacency, nodes } = extractNamespaceSubgraph(store, namespace)
  │       └─ load every memory in ns + all memory_edge rows
  │       └─ build PprAdjacency = Map<sourceId, [{target, weight}]>
  │
  ├─ { scores, iterations, converged } = personalizedPageRank(
  │       adjacency, seedMap, opts                     ← src/retrieve/ppr.ts
  │   )
  │       └─ power iteration:
  │            score = (1-α) · personalization
  │                  + α · normalized(Wᵀ · score)
  │            stop when L1 delta < ε (default 1e-6)
  │            or iterations > maxIterations (default 100)
  │            α = dampingFactor (default 0.85)
  │
  ├─ ranked = scores entries
  │       .filter(id is in nodes)
  │       .filter(excludeInvalidated ? !memory.bitemporal.invalidAt : true)
  │       .sort desc by score
  │
  └─ return { memories: limited, scores: Map, iterations, converged }
```

## 6. Sleeptime consolidation — `consolidate(store, queue, ns, opts)`

```
consolidate(store, queue, namespace, opts)     ← src/sleeptime/consolidate.ts
  │
  ├─ pending = queue.listPending({ namespace, limit })
  │             └─ SELECT * FROM proposal WHERE status='pending' ...
  │
  └─ for each proposal in pending:
       ├─ decision = await (opts.decideFn ?? defaultDecide)(store, proposal)
       │       │
       │       └─ defaultDecide(store, proposal):       ← src/sleeptime/ratify.ts
       │             dup = findNearestDuplicate(store, proposal.candidate)
       │             dup?.exact?  → { kind:'merge-into', targetId: dup.memory.id }
       │             else         → { kind:'add' }
       │
       └─ outcome = ratifyProposal({ store, queue, proposal, decision, now, runId })
              switch decision.kind:
              ├─ 'add':
              │     stamped = { ...candidate, provenance: { ...prov, ratifiedAt: now }}
              │     store.add(stamped)
              │     queue.updateStatus(proposal.id, 'ratified', { ratifiedTo: stamped.id, decidedAt: now })
              │
              ├─ 'merge-into':
              │     target = store.findById(decision.targetId)
              │     target gone? → fall through to 'add'
              │     merged = {
              │       ...target,
              │       confidence: clamp(target.confidence + 5, 0, 100),
              │       decay: { ...decay,
              │                strength: clamp(strength + 5, 0, 100),
              │                rehearseCount: rehearseCount + 1,
              │                lastAccessed: now },
              │     }
              │     store.add(merged)
              │     queue.updateStatus(proposal.id, 'merged-into', { ratifiedTo: target.id, decidedAt: now })
              │
              ├─ 'reject':
              │     queue.updateStatus(proposal.id, 'rejected', { rejectedReason: decision.reason, decidedAt: now })
              │
              └─ 'supersede':
                    candidate = withSupersedesLink(proposal.candidate, targetId, now)
                    stamped   = stampRatified(candidate, now)
                    store.add(stamped)
                    store.invalidate(targetId, now, `superseded-by:${stamped.id}`, runId)
                    queue.updateStatus(proposal.id, 'ratified', { ratifiedTo: stamped.id, decidedAt: now })

returns { scanned, ratified, merged, rejected, superseded }
```

## 7. Reflection — `reflectOnRun(opts)`

```
reflectOnRun({ queue, namespace, runContext, llmInvoke, now, ttlDays })
  │                                              ← src/reflect/reflector.ts
  ├─ userPrompt = buildReflectionUserPrompt(runContext)   ← prompts.ts
  │
  ├─ rawOutput = await opts.llmInvoke(REFLECTION_SYSTEM_PROMPT, userPrompt)
  │       ↑ caller-supplied invoker. memory-core does not bundle a model.
  │
  ├─ reflection = parseReflectionJson(rawOutput)          ← extractor.ts
  │       └─ tolerant of surrounding prose; locates JSON block
  │       └─ returns { failures[], successes[], surprises[], skillProposals[] }
  │
  └─ enqueued = reflectIntoProposals(queue, reflection, { namespace, runId, now, ttlDays })
                                                          ← mapper.ts
       │
       └─ for each item:
            queue.enqueue(buildMemory(item, ns, ttl), reason)
                  ↑ status='pending', awaits sleeptime ratification

returns { enqueuedCounts, reflection, rawOutput }
```

The pipeline never writes durable memory itself — every reflection
becomes a proposal. Sleeptime decides what survives.

## 8. PR-as-episode — `recordPrEpisode(store, episode, opts)`

```
recordPrEpisode(store, episode, opts)            ← src/episode/pr-episode.ts
  │
  ├─ memory = buildPrEpisodeMemory(episode, opts)
  │       id          = ulid()
  │       kind        = 'episodic'
  │       content     = episode  (PrEpisode object — JSON-stringified for FTS)
  │       tags        = ['pr-episode', `ci:${ciStatus}`,
  │                      merge ? `merge:${...}`, review ? `review:${...}`]
  │       confidence  = 80
  │       ttlDays     = opts.ttlDays ?? 365
  │       bitemporal  = { validAt: now }
  │       decay       = { lastAccessed: now, strength: 90, rehearseCount: 0 }
  │       provenance  = { createdBy: 'pr-episode', ratifiedAt: now,
  │                       sourceRunId: runId }
  │       ↑ ratifiedAt = now means auto-ratified; bypasses ProposalQueue
  │         (structured episodes are low-noise per plan §12)
  │
  └─ store.add(memory)
        └─ JSONL append + SQLite upsert
        └─ FTS indexes JSON.stringify(content), so BM25 matches against
           intent / plan / file paths / commit shas

returns Memory<PrEpisode>
```

`retrievePrEpisodes(store, query, opts)` is BM25 over the `pr-episode`
tag with optional CI/merge/review filters.

## 9. Drift sweep — `verifyCodeBindings(store, ns, opts)`

```
verifyCodeBindings(store, namespace, opts)       ← src/drift/verify.ts
  │
  ├─ now           = opts.now ?? new Date().toISOString()
  ├─ driftPolicy   = opts.driftPolicy   ?? 'downweight'
  ├─ missingPolicy = opts.missingPolicy ?? 'invalidate'
  ├─ staleCutoff   = opts.staleAfterDays ? now - days : null
  │
  ├─ memories = store.query(namespace, { includeInvalidated: true })
  │
  └─ for each memory m:
       ├─ !m.codeBinding?               → result.noBinding++,    continue
       ├─ staleCutoff && lastVerifiedAt > cutoff
       │                                 → result.skippedFresh++, continue
       │
       ├─ outcome = checkCodeBindingDrift(m.codeBinding, { workspaceRoot })
       │       ↑ src/drift/drift-detector.ts
       │         - file missing? → { status: 'missing' }
       │         - else: hash = computeStructuralHash(content, language)
       │           hash === binding.structuralHash ? 'fresh' : 'drifted'
       │
       │  (errors are caught + logged to stderr, then continue)
       │
       ├─ status === 'fresh':
       │       result.fresh++
       │       stampLastVerified(store, m, now, currentHash)
       │             store.add({ ...m, codeBinding: { ..., lastVerifiedAt: now,
       │                                              structuralHash: currentHash } })
       │
       ├─ status === 'drifted':
       │       result.drifted++; touchedIds.push(m.id)
       │       applyDriftPolicy(store, m, driftPolicy, { reason: `code-drift:${file}` })
       │             'invalidate' → store.invalidate(m.id, now, reason, runId)
       │             'downweight' → store.add({ ...m,
       │                              decay: { ..., strength: round(strength * downweightFactor) },
       │                              codeBinding: { ..., lastVerifiedAt: now } })
       │
       └─ status === 'missing':
              result.missing++; touchedIds.push(m.id)
              applyDriftPolicy(store, m, missingPolicy, { reason: `code-missing:${file}` })

returns { fresh, drifted, missing, noBinding, skippedFresh, touchedIds }
```

## 10. Migration importer — `importLegacyMemories(legacyRoot, store, opts)`

```
importLegacyMemories(legacyRoot, store, opts)    ← src/migrate/importer.ts
  │
  ├─ existsSync(legacyRoot)? else log + return empty report
  │
  └─ for each dirent in readdirSync(legacyRoot):
       ├─ skip if not a directory
       ├─ legacyFile = <dirent>/memories.jsonl
       ├─ skip if !existsSync(legacyFile)
       │
       ├─ filesScanned++
       ├─ ns = interpretLegacyDir(dirent)
       │       ↑ 'global' / '_global' → { scope: 'global' }
       │       ↑ otherwise            → { scope: 'project', projectId: <dir> }
       │
       ├─ if !dryRun && !skipBackup:
       │     copyFileSync(legacyFile, `${legacyFile}.pre-migration.bak`)
       │     (only if .bak doesn't already exist)
       │
       └─ for each legacy entry in readJSONL(legacyFile):
            ├─ entriesScanned++
            ├─ build v2 Memory<string>:
            │     id          = entry.id              (preserved → idempotent upsert)
            │     namespace   = ns
            │     kind        = 'semantic'
            │     subtype     = entry.kind            (legacy vocabulary → SemanticSubtype)
            │     content     = entry.content
            │     tags        = entry.tags
            │     confidence  = entry.confidence
            │     ttlDays     = entry.ttlDays
            │     bitemporal  = { validAt: entry.createdAt }
            │     decay       = { lastAccessed: now, strength: 100, rehearseCount: 0 }
            │     provenance  = { createdBy: 'migration', sourceRunId: 'pre-migration', createdAt: now }
            │
            ├─ if dryRun: continue
            ├─ try store.add(m):
            │     ScrubResult.redactions.length > 0 → report.scrubbed++
            │     success                           → report.imported++
            │
            └─ catch HardRejectError:
                  report.rejected++
                  report.errors.push({ file, entryId: m.id, reason })

returns { filesScanned, entriesScanned, imported, skipped, scrubbed, rejected, byNamespace, errors }
```

## 11. Auto-rebuild on store open

```
HybridMemoryStore.open({ jsonlPath, sqlitePath, skipAutoRebuild?, scrubber? })
  │
  ├─ jsonl  = new JsonlAppendLog(jsonlPath)
  ├─ sqlite = new SqliteHotIndex(sqlitePath)
  │           ↑ applies SCHEMA_SQL idempotently
  │           ↑ runs additive migrations (PRAGMA-detect missing columns)
  │           ↑ inserts SCHEMA_VERSION row
  │
  ├─ store = new HybridMemoryStore(jsonl, sqlite, scrubberOpts)
  │
  └─ if !skipAutoRebuild && jsonl.exists() && sqlite.count() === 0:
       records = jsonl.readAll()                      ← skips malformed lines
       if records.length > 0:
         stderr.write("rebuilding SQLite hot index from <path> ...")
         store.rebuildIndexFromJsonl()
              └─ tx:
                   DELETE FROM memory; DELETE FROM memory_tag; DELETE FROM memory_fts;
                   for each m in records: sqlite.upsert(m)

returns store
```

This is the recovery path when the SQLite file is deleted, corrupted,
or out-of-sync after a manual edit to the JSONL.

## 12. Inspector flow (dashboard / admin)

```
new MemoryInspector(store)
  └─ this.store = store
  └─ this.queue = new ProposalQueue(store.sqlite)

inspector.list(filter)
  ├─ filter.search?
  │     filter.namespace ? store.query(ns, { text, limit, includeInvalidated })
  │                      : store.queryAll(...)
  ├─ filter.namespace? store.query(ns, { limit, includeInvalidated })
  └─ else              store.queryAll({ limit, includeInvalidated })
  └─ in-JS filter on .kind / .subtype

inspector.detail(id)         → store.findById(id)
inspector.listProposals(...) → queue.list(status, { namespace, limit })

inspector.ratifyProposal(id):
  ├─ proposal = queue.get(id)
  ├─ status === 'pending'? else { ok: false }
  ├─ store.add(proposal.candidate)
  └─ queue.updateStatus(id, 'ratified', { ratifiedTo: proposal.candidate.id })
       ↑ admin-only — bypasses defaultDecide

inspector.rejectProposal(id, reason):
  └─ queue.updateStatus(id, 'rejected', { rejectedReason: reason })

inspector.driftSweep(opts, namespace) → verifyCodeBindings(store, namespace, opts)

inspector.stats(namespace?):
  ├─ memories = (namespace ? store.query(ns, ..) : store.queryAll(..))
  │              with includeInvalidated: true
  ├─ aggregate byKind / bySubtype / topTags (top 20) / invalidated / withCodeBinding
  └─ return InspectorStats
```
