import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export type PipelineStage = 'plan' | 'implement' | 'review' | 'test' | 'ship';

export interface PolicyFormState {
  enabled: boolean;
  pauseAfter: PipelineStage[];
  autoApproveIfRisk: 'low' | 'med' | 'never';
  autoApproveIfConfidence: number;
  cost: {
    onBreach: 'ask' | 'auto-approve' | 'auto-reject';
    perRun: number | null;
    perProjectDaily: number | null;
    perStage: Partial<Record<PipelineStage, number>>;
    autoApproveBelow: number | null;
    graceWindowSeconds: number | null;
  };
  notifications: {
    slack: boolean;
    email: boolean;
    timeoutHours: number | null;
  };
  qa: {
    enabled: boolean;
    maxQuestionsPerStage: number;
  };
}

export interface PolicyHookState {
  effective: Record<string, unknown> | null;
  overlay: Record<string, unknown> | null;
  form: PolicyFormState;
  dirty: boolean;
  status: 'idle' | 'loading' | 'saving' | 'saved' | 'error';
  error: string | null;
}

export interface PolicyHook extends PolicyHookState {
  setEnabled(v: boolean): void;
  setPauseAfter(stages: PipelineStage[]): void;
  togglePauseStage(stage: PipelineStage): void;
  setAutoApproveRisk(v: 'low' | 'med' | 'never'): void;
  setAutoApproveConfidence(v: number): void;
  setCost(p: Partial<PolicyFormState['cost']>): void;
  setNotifications(p: Partial<PolicyFormState['notifications']>): void;
  setQA(p: Partial<PolicyFormState['qa']>): void;
  reset(): void;
  save(): void;
}

const DEFAULT_FORM: PolicyFormState = {
  enabled: true,
  pauseAfter: ['plan'],
  autoApproveIfRisk: 'low',
  autoApproveIfConfidence: 0.85,
  cost: {
    onBreach: 'ask',
    perRun: 10,
    perProjectDaily: 30,
    perStage: {},
    autoApproveBelow: 0.15,
    graceWindowSeconds: 60,
  },
  notifications: { slack: false, email: false, timeoutHours: 2 },
  qa: { enabled: true, maxQuestionsPerStage: 5 },
};

function effectiveToForm(effective: Record<string, unknown> | null): PolicyFormState {
  if (!effective) return DEFAULT_FORM;
  const e = effective as Record<string, any>;
  const defaults = (e.defaults ?? {}) as Record<string, any>;
  const cost = (e.cost ?? {}) as Record<string, any>;
  const limits = (cost.limits ?? {}) as Record<string, any>;
  const notif = (e.notifications ?? {}) as Record<string, any>;
  const qa = (e.qa ?? {}) as Record<string, any>;

  const risk = defaults.autoApproveIfRisk;
  const formRisk: 'low' | 'med' | 'never'
    = risk === 'low' || risk === 'med' ? risk : 'never';

  return {
    enabled: e.enabled !== false,
    pauseAfter: Array.isArray(defaults.pauseAfter) ? (defaults.pauseAfter as PipelineStage[]) : [],
    autoApproveIfRisk: formRisk,
    autoApproveIfConfidence: typeof defaults.autoApproveIfConfidence === 'number'
      ? defaults.autoApproveIfConfidence
      : 0.85,
    cost: {
      onBreach: cost.onBreach ?? 'ask',
      perRun: typeof limits.perRun === 'number' ? limits.perRun : null,
      perProjectDaily: typeof limits.perProjectDaily === 'number' ? limits.perProjectDaily : null,
      perStage: (limits.perStage ?? {}) as Partial<Record<PipelineStage, number>>,
      autoApproveBelow: typeof cost.autoApproveBelow === 'number' ? cost.autoApproveBelow : null,
      graceWindowSeconds: typeof cost.graceWindowSeconds === 'number' ? cost.graceWindowSeconds : null,
    },
    notifications: {
      slack: notif.slack === true,
      email: notif.email === true,
      timeoutHours: typeof notif.timeoutHours === 'number' ? notif.timeoutHours : null,
    },
    qa: {
      enabled: qa.enabled !== false,
      maxQuestionsPerStage: typeof qa.maxQuestionsPerStage === 'number' ? qa.maxQuestionsPerStage : 5,
    },
  };
}

function formToPatch(form: PolicyFormState): Record<string, unknown> {
  const patch: Record<string, unknown> = {
    enabled: form.enabled,
    defaults: {
      pauseAfter: form.pauseAfter,
      autoApproveIfConfidence: form.autoApproveIfConfidence,
    },
    qa: {
      enabled: form.qa.enabled,
      maxQuestionsPerStage: form.qa.maxQuestionsPerStage,
    },
    notifications: {
      slack: form.notifications.slack,
      email: form.notifications.email,
    },
  };
  const defaults = patch.defaults as Record<string, unknown>;
  if (form.autoApproveIfRisk !== 'never') {
    defaults.autoApproveIfRisk = form.autoApproveIfRisk;
  }
  if (form.notifications.timeoutHours != null) {
    (patch.notifications as Record<string, unknown>).timeoutHours = form.notifications.timeoutHours;
  }
  const cost: Record<string, unknown> = {
    onBreach: form.cost.onBreach,
    limits: {
      ...(form.cost.perRun != null ? { perRun: form.cost.perRun } : {}),
      ...(form.cost.perProjectDaily != null ? { perProjectDaily: form.cost.perProjectDaily } : {}),
      ...(Object.keys(form.cost.perStage).length > 0 ? { perStage: form.cost.perStage } : {}),
    },
  };
  if (form.cost.autoApproveBelow != null) cost.autoApproveBelow = form.cost.autoApproveBelow;
  if (form.cost.graceWindowSeconds != null) cost.graceWindowSeconds = form.cost.graceWindowSeconds;
  patch.cost = cost;
  return patch;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

export function usePolicy(ws: WebSocket | null, project: string | null): PolicyHook {
  const [state, setState] = useState<PolicyHookState>({
    effective: null,
    overlay: null,
    form: DEFAULT_FORM,
    dirty: false,
    status: 'idle',
    error: null,
  });
  const serverFormRef = useRef<PolicyFormState>(DEFAULT_FORM);

  // Fetch on mount + when project changes.
  useEffect(() => {
    if (!ws || !project) return;
    setState((s) => ({ ...s, status: 'loading', error: null }));
    try {
      ws.send(JSON.stringify({ action: 'get-pipeline-policy', project }));
    } catch { /* ws may not be ready */ }
  }, [ws, project]);

  // Subscribe to server messages.
  useEffect(() => {
    if (!ws) return;
    const handler = (event: MessageEvent) => {
      let msg: { type?: string; payload?: any };
      try { msg = JSON.parse(event.data); } catch { return; }
      if (!msg.type || !msg.payload) return;
      if (msg.type === 'pipeline-policy' && msg.payload.project === project) {
        const eff = msg.payload.policy as Record<string, unknown> | null;
        const overlay = msg.payload.overlay as Record<string, unknown> | null;
        const form = effectiveToForm(eff);
        serverFormRef.current = form;
        setState({ effective: eff, overlay, form, dirty: false, status: 'idle', error: null });
      } else if ((msg.type === 'pipeline-policy-updated' || msg.type === 'pipeline-policy-saved')
                 && msg.payload.project === project) {
        const eff = msg.payload.effective as Record<string, unknown> | null;
        const overlay = msg.payload.overlay as Record<string, unknown> | null;
        const form = effectiveToForm(eff);
        serverFormRef.current = form;
        setState((s) => ({
          ...s,
          effective: eff,
          overlay,
          form,
          dirty: false,
          status: msg.type === 'pipeline-policy-updated' ? 'saved' : s.status,
          error: null,
        }));
      } else if (msg.type === 'pipeline-policy-error') {
        setState((s) => ({ ...s, status: 'error', error: msg.payload?.message ?? 'unknown error' }));
      }
    };
    ws.addEventListener('message', handler);
    return () => ws.removeEventListener('message', handler);
  }, [ws, project]);

  const setForm = useCallback((next: PolicyFormState) => {
    setState((s) => ({
      ...s,
      form: next,
      dirty: !deepEqual(next, serverFormRef.current),
      status: s.status === 'saved' ? 'idle' : s.status,
    }));
  }, []);

  const setEnabled = useCallback((v: boolean) => {
    setState((s) => {
      const next = { ...s.form, enabled: v };
      return {
        ...s,
        form: next,
        dirty: !deepEqual(next, serverFormRef.current),
        status: s.status === 'saved' ? 'idle' : s.status,
      };
    });
  }, []);

  const setPauseAfter = useCallback((stages: PipelineStage[]) => {
    setState((s) => {
      const next = { ...s.form, pauseAfter: stages };
      return {
        ...s,
        form: next,
        dirty: !deepEqual(next, serverFormRef.current),
        status: s.status === 'saved' ? 'idle' : s.status,
      };
    });
  }, []);

  const togglePauseStage = useCallback((stage: PipelineStage) => {
    setState((s) => {
      const has = s.form.pauseAfter.includes(stage);
      const next = {
        ...s.form,
        pauseAfter: has ? s.form.pauseAfter.filter((x) => x !== stage) : [...s.form.pauseAfter, stage],
      };
      return {
        ...s,
        form: next,
        dirty: !deepEqual(next, serverFormRef.current),
        status: s.status === 'saved' ? 'idle' : s.status,
      };
    });
  }, []);

  const setAutoApproveRisk = useCallback((v: 'low' | 'med' | 'never') => {
    setState((s) => {
      const next = { ...s.form, autoApproveIfRisk: v };
      return {
        ...s,
        form: next,
        dirty: !deepEqual(next, serverFormRef.current),
        status: s.status === 'saved' ? 'idle' : s.status,
      };
    });
  }, []);

  const setAutoApproveConfidence = useCallback((v: number) => {
    setState((s) => {
      const next = { ...s.form, autoApproveIfConfidence: v };
      return {
        ...s,
        form: next,
        dirty: !deepEqual(next, serverFormRef.current),
        status: s.status === 'saved' ? 'idle' : s.status,
      };
    });
  }, []);

  const setCost = useCallback((p: Partial<PolicyFormState['cost']>) => {
    setState((s) => {
      const next = { ...s.form, cost: { ...s.form.cost, ...p } };
      return {
        ...s,
        form: next,
        dirty: !deepEqual(next, serverFormRef.current),
        status: s.status === 'saved' ? 'idle' : s.status,
      };
    });
  }, []);

  const setNotifications = useCallback((p: Partial<PolicyFormState['notifications']>) => {
    setState((s) => {
      const next = { ...s.form, notifications: { ...s.form.notifications, ...p } };
      return {
        ...s,
        form: next,
        dirty: !deepEqual(next, serverFormRef.current),
        status: s.status === 'saved' ? 'idle' : s.status,
      };
    });
  }, []);

  const setQA = useCallback((p: Partial<PolicyFormState['qa']>) => {
    setState((s) => {
      const next = { ...s.form, qa: { ...s.form.qa, ...p } };
      return {
        ...s,
        form: next,
        dirty: !deepEqual(next, serverFormRef.current),
        status: s.status === 'saved' ? 'idle' : s.status,
      };
    });
  }, []);

  const reset = useCallback(() => {
    setState((s) => ({ ...s, form: serverFormRef.current, dirty: false, status: 'idle', error: null }));
  }, []);

  const save = useCallback(() => {
    if (!ws || !project) return;
    setState((s) => ({ ...s, status: 'saving', error: null }));
    try {
      ws.send(JSON.stringify({
        action: 'update-pipeline-policy',
        project,
        patch: formToPatch(state.form),
      }));
    } catch (err) {
      setState((s) => ({ ...s, status: 'error', error: String(err) }));
    }
  }, [ws, project, state.form]);

  return useMemo<PolicyHook>(() => ({
    ...state,
    setEnabled,
    setPauseAfter,
    togglePauseStage,
    setAutoApproveRisk,
    setAutoApproveConfidence,
    setCost,
    setNotifications,
    setQA,
    reset,
    save,
  }), [state, setEnabled, setPauseAfter, togglePauseStage, setAutoApproveRisk,
       setAutoApproveConfidence, setCost, setNotifications, setQA, reset, save]);
}
