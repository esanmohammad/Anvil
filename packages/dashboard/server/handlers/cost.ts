/**
 * Cost WS routes (Recipe 7 / Phase 1).
 *
 * Migrated:
 *   - respond-cost-breach — echo `cost-breach-response`, error wire-type
 *     `cost-error`. After the response writes, the handler pushes a fresh
 *     cost snapshot via `broadcastCostSnapshot` (closure-side until the
 *     run registry is extracted in Phase 2).
 *
 * NOT migrated (closure-dependent — stay handler-side):
 *   - subscribe-cost, unsubscribe-cost (room model — pure broadcasts)
 *   - list-pending-breaches (cost-breach-handler reads)
 *   - get/update-pipeline-policy (policy file IO + project loader writes)
 */

import { route, type Handler } from './route.js';
import * as Z from './schemas.js';

export function costRoutes(): Record<string, Handler> {
  return {
    // ── Reads ───────────────────────────────────────────────────────────
    'get-cost-summary': route({
      input: Z.GetCostSummary,
      errorWireType: 'cost-error',
      handle: (input, deps) => {
        const ledger = deps.extras.costLedger;
        if (!ledger) return;
        return { summary: ledger.summarize(input.runId) };
      },
      wireType: 'cost-summary',
    }),

    'get-cost-breach': route({
      input: Z.GetCostBreach,
      errorWireType: 'cost-error',
      handle: (input, deps) => {
        const handler = deps.extras.costBreachHandler;
        if (!handler) return;
        return { breach: handler.getBreach(input.runId) };
      },
      wireType: 'cost-breach',
    }),

    'list-pending-breaches': route({
      input: Z.ListPendingBreaches,
      onParseFail: 'silent',
      errorWireType: 'cost-error',
      handle: (_input, deps) => {
        const handler = deps.extras.costBreachHandler;
        if (!handler) return;
        const breaches = handler.listPending?.() ?? [];
        return { breaches };
      },
      wireType: 'pending-breaches',
    }),

    'list-cost-breaches': route({
      input: Z.ListCostBreaches,
      onParseFail: 'silent',
      errorWireType: 'cost-error',
      handle: async (input, deps) => {
        const { existsSync, readdirSync, readFileSync } = await import('node:fs');
        const { join } = await import('node:path');
        const dir = join(deps.extras.anvilHome, 'cost-breaches');
        const out: unknown[] = [];
        if (existsSync(dir)) {
          const projects = input.project ? [input.project] : readdirSync(dir).filter((n: string) => !n.includes('.'));
          for (const p of projects) {
            const projDir = join(dir, p);
            if (!existsSync(projDir)) continue;
            for (const f of readdirSync(projDir)) {
              if (!f.endsWith('.json')) continue;
              try {
                const raw = readFileSync(join(projDir, f), 'utf-8');
                out.push(JSON.parse(raw));
              } catch { /* skip */ }
            }
          }
        }
        return { breaches: out };
      },
      wireType: 'cost-breaches',
    }),

    'subscribe-cost': route({
      input: Z.SubscribeCost,
      onParseFail: 'silent',
      handle: (input, deps) => {
        try { deps.extras.broadcastCostSnapshot?.(input.project, input.runId); }
        catch { /* ok */ }
      },
    }),

    'unsubscribe-cost': route({
      input: Z.UnsubscribeCost,
      onParseFail: 'silent',
      // Room model — clients just stop reacting to snapshots they ignore.
      handle: () => { /* no-op */ },
    }),

    'get-pipeline-policy': route({
      input: Z.GetPipelinePolicy,
      errorWireType: 'cost-error',
      handle: async (input, deps) => {
        const { loadPolicy } = await import('../pipeline-policy.js');
        const { existsSync, readFileSync } = await import('node:fs');
        const { join } = await import('node:path');
        const policy = loadPolicy(input.project, deps.extras.anvilHome);
        const overlayPath = join(deps.extras.anvilHome, 'projects', input.project, 'pipeline-policy.overlay.json');
        const overlay = existsSync(overlayPath) ? JSON.parse(readFileSync(overlayPath, 'utf-8')) : null;
        return { project: input.project, policy, overlay };
      },
      wireType: 'pipeline-policy',
    }),

    'update-pipeline-policy': route({
      input: Z.UpdatePipelinePolicy,
      errorWireType: 'cost-error',
      handle: async (input, deps) => {
        const { existsSync, readFileSync, writeFileSync, mkdirSync } = await import('node:fs');
        const { join } = await import('node:path');
        const patch = input.patch as {
          cost?: {
            onBreach?: 'ask' | 'auto-approve' | 'auto-reject';
            autoApproveBelow?: number;
            graceWindowSeconds?: number;
            limits?: { perRun?: number; perProjectDaily?: number };
          };
        };
        const cost = patch.cost ?? {};
        if (cost.graceWindowSeconds !== undefined && (cost.graceWindowSeconds < 10 || cost.graceWindowSeconds > 600)) {
          throw new Error('graceWindowSeconds must be in [10, 600]');
        }
        if (cost.autoApproveBelow !== undefined && cost.autoApproveBelow < 0) {
          throw new Error('autoApproveBelow must be >= 0');
        }
        const projDir = join(deps.extras.anvilHome, 'projects', input.project);
        if (!existsSync(projDir)) mkdirSync(projDir, { recursive: true });
        const overlayPath = join(projDir, 'pipeline-policy.overlay.json');
        const existing = existsSync(overlayPath) ? JSON.parse(readFileSync(overlayPath, 'utf-8')) : {};
        const merged = {
          ...existing,
          cost: {
            ...(existing.cost ?? {}),
            ...cost,
            limits: { ...(existing.cost?.limits ?? {}), ...(cost.limits ?? {}) },
          },
        };
        writeFileSync(overlayPath, JSON.stringify(merged, null, 2), 'utf-8');
        // Push fresh snapshot so any meters reading limits see new ceilings.
        try { deps.extras.broadcastCostSnapshot?.(input.project); } catch { /* ok */ }
        return { project: input.project, overlay: merged };
      },
      wireType: 'pipeline-policy-updated',
    }),

    // ── Mutations ───────────────────────────────────────────────────────
    'respond-cost-breach': route({
      input: Z.RespondCostBreach,
      errorWireType: 'cost-error',
      handle: async (input, deps) => {
        const { breach, project } = await deps.services.cost.respondBreach(input);
        deps.ws.send(JSON.stringify({ type: 'cost-breach-response', payload: { ok: true, breach } }));
        // Fresh snapshot so the modal/meter reflect the resolved state.
        // Stays handler-side until the run registry closure is extracted.
        deps.extras.broadcastCostSnapshot?.(project, input.runId);
      },
    }),
  };
}
