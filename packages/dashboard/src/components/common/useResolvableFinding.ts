import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Resolution, ResolvableFinding } from './findingPrimitives.js';

// ── Hook types ─────────────────────────────────────────────────────────

export interface UseResolvableFindingOptions<
  TResource extends { id: string; findings: ResolvableFinding[] },
> {
  ws: WebSocket | null;
  project: string | null;
  resource: TResource | null;
  setResource: React.Dispatch<React.SetStateAction<TResource | null>>;
  /** e.g. 'resolve-review-finding' */
  resolveAction: string;
  /** e.g. 'review-finding-resolved' */
  resolvedEvent: string;
  /** e.g. 'reviewId' → sent to server */
  resourceIdField: string;
}

export interface UseResolvableFindingResult {
  resolvingId: string | null;
  toast: { message: string; canUndo: boolean } | null;
  showToast: (msg: string, canUndo?: boolean) => void;
  dismissToast: () => void;
  resolve: (findingId: string, resolution: Exclude<Resolution, 'pending'>) => void;
  undoResolve: () => void;
}

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Shape-sniff a websocket payload for an embedded full resource. Callers of the
 * hook may assign different names to the resource key on the server (review,
 * spec, testSpec, …). We first try the common ones, then fall back to a
 * generic scan for any object value with `{ id, findings }`.
 */
function extractResourceFromPayload<T extends { id: string; findings: ResolvableFinding[] }>(
  payload: any,
): T | null {
  if (!payload || typeof payload !== 'object') return null;
  const common = payload.review ?? payload.spec ?? payload.testSpec;
  if (common && typeof common === 'object' && 'id' in common && Array.isArray(common.findings)) {
    return common as T;
  }
  for (const key of Object.keys(payload)) {
    const v = payload[key];
    if (v && typeof v === 'object' && !Array.isArray(v) && 'id' in v && Array.isArray((v as any).findings)) {
      return v as T;
    }
  }
  return null;
}

// ── Hook ───────────────────────────────────────────────────────────────

/**
 * Manages the resolve/undo/toast lifecycle for any resource that owns a list
 * of {@link ResolvableFinding}s. Uses functional setState inside the WS
 * handler so the effect can stay scoped to `[ws, …action names]` without
 * re-subscribing on every resource update (the stale-closure bug we just
 * fixed in ReviewPage).
 */
export function useResolvableFinding<
  T extends { id: string; findings: ResolvableFinding[] },
>(opts: UseResolvableFindingOptions<T>): UseResolvableFindingResult {
  const { ws, project, resource, setResource, resolveAction, resolvedEvent, resourceIdField } = opts;

  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; canUndo: boolean } | null>(null);
  const toastTimeoutRef = useRef<number | null>(null);
  const lastResolveRef = useRef<{ findingId: string; prev: Resolution } | null>(null);

  // Keep refs to the latest props so the WS handler can read them without
  // re-subscribing on every prop change.
  const projectRef = useRef(project);
  const resolveActionRef = useRef(resolveAction);
  const resourceIdFieldRef = useRef(resourceIdField);
  useEffect(() => { projectRef.current = project; }, [project]);
  useEffect(() => { resolveActionRef.current = resolveAction; }, [resolveAction]);
  useEffect(() => { resourceIdFieldRef.current = resourceIdField; }, [resourceIdField]);

  const dismissToast = useCallback(() => {
    if (toastTimeoutRef.current) {
      window.clearTimeout(toastTimeoutRef.current);
      toastTimeoutRef.current = null;
    }
    setToast(null);
  }, []);

  const showToast = useCallback((message: string, canUndo = true) => {
    setToast({ message, canUndo });
    if (toastTimeoutRef.current) window.clearTimeout(toastTimeoutRef.current);
    toastTimeoutRef.current = window.setTimeout(() => setToast(null), 4000);
  }, []);

  const resolve = useCallback(
    (findingId: string, resolution: Exclude<Resolution, 'pending'>) => {
      if (!ws || !project || !resource) return;
      setResolvingId(findingId);
      const prev = resource.findings.find((f) => f.id === findingId)?.resolution ?? 'pending';
      lastResolveRef.current = { findingId, prev };
      ws.send(JSON.stringify({
        action: resolveAction,
        project,
        [resourceIdField]: resource.id,
        findingId,
        resolution,
      }));
    },
    [ws, project, resource, resolveAction, resourceIdField],
  );

  const undoResolve = useCallback(() => {
    if (!ws || !project || !resource || !lastResolveRef.current) return;
    const { findingId, prev } = lastResolveRef.current;
    lastResolveRef.current = null;
    setResolvingId(findingId);
    ws.send(JSON.stringify({
      action: resolveAction,
      project,
      [resourceIdField]: resource.id,
      findingId,
      resolution: prev,
    }));
  }, [ws, project, resource, resolveAction, resourceIdField]);

  // WS subscription — deliberately scoped so we don't tear down on every
  // resource update. We rely on functional setState to always read fresh
  // state from inside the handler.
  useEffect(() => {
    if (!ws) return;
    const handler = (event: MessageEvent) => {
      let msg: any;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg?.type !== resolvedEvent) return;

      const p = msg.payload ?? {};
      setResolvingId(null);
      setResource((prev) => {
        if (!prev) return prev;
        const embedded = extractResourceFromPayload<T>(p);
        if (embedded && prev.id === embedded.id) return embedded;
        if (p.findingId && p.resolution) {
          return {
            ...prev,
            findings: prev.findings.map((f) =>
              f.id === p.findingId ? { ...f, resolution: p.resolution as Resolution } : f,
            ),
          } as T;
        }
        return prev;
      });

      const res: Resolution | undefined = p.resolution;
      if (res && res !== 'pending') {
        const label = res === 'dismissed' ? 'Finding dismissed'
          : res === 'wont-fix' ? "Marked as won't fix"
          : 'Finding marked addressed';
        const canUndo = lastResolveRef.current?.findingId === p.findingId;
        setToast({ message: label, canUndo });
        if (toastTimeoutRef.current) window.clearTimeout(toastTimeoutRef.current);
        toastTimeoutRef.current = window.setTimeout(() => setToast(null), 4000);
      } else if (res === 'pending') {
        setToast({ message: 'Restored', canUndo: false });
        if (toastTimeoutRef.current) window.clearTimeout(toastTimeoutRef.current);
        toastTimeoutRef.current = window.setTimeout(() => setToast(null), 4000);
      }
    };
    ws.addEventListener('message', handler);
    return () => ws.removeEventListener('message', handler);
    // NOTE: deliberately exclude `resource` from deps — we read latest via
    // functional setState. This is what keeps us out of the stale-closure bug.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws, resolveAction, resolvedEvent, resourceIdField]);

  // Cleanup toast timer on unmount.
  useEffect(() => {
    return () => {
      if (toastTimeoutRef.current) window.clearTimeout(toastTimeoutRef.current);
    };
  }, []);

  return {
    resolvingId,
    toast,
    showToast,
    dismissToast,
    resolve,
    undoResolve,
  };
}
