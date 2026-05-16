/**
 * Pipeline-pause read routes (Recipe 7 / Phase 1).
 *
 * The pause module already exports its own envelope-shaped helpers
 * (`handleListPauses`, `handleGetPause`) — they return a full
 * `{type, payload}` object instead of just a payload. We call them
 * inside the `handle` callback and send directly on `ws` because the
 * shape doesn't fit the `wireType` echo path.
 *
 * Migrated:
 *   - list-pipeline-pauses
 *   - get-pipeline-pause
 *
 * NOT migrated (write — closure-dependent on `auditLog`,
 * `learningsStore`, the run-registry):
 *   - resume-pipeline-pause / cancel-pipeline-pause.
 */
import { route } from './route.js';
import * as Z from './schemas.js';
export function pauseRoutes() {
    return {
        /**
         * NOTE on `resume-pipeline`: there were two `case 'resume-pipeline':`
         * blocks in the legacy switch — the FIRST handled the checkpoint
         * replay (Replay button), the SECOND was the pause-flow resume.
         * Since both used the same action name, the second was dead code
         * (JS switch is top-down + break). The pause-flow `resume-pipeline`
         * handler is therefore NOT migrated here; the checkpoint replay
         * stays in `dashboard-server.ts` until Phase 2.5 picks it up.
         */
        'cancel-pipeline-pause': route({
            input: Z.CancelPipelinePause,
            onParseFail: 'silent',
            errorWireType: 'pipeline-pause-error',
            handle: async (input, deps) => {
                const store = deps.extras.pauseStore;
                if (!store)
                    return;
                const { handleCancelPause } = await import('../pipeline-pause-handlers.js');
                const env = handleCancelPause(store, input, deps.user ?? deps.extras.defaultUser);
                deps.ws.send(JSON.stringify(env));
                const state = store.get(input.runId ?? '');
                if (state)
                    deps.services.pipeline.emit('pipeline.cancelled', { pause: state });
            },
        }),
        'list-pipeline-pauses': route({
            input: Z.ListPipelinePauses,
            onParseFail: 'silent',
            errorWireType: 'pipeline-pause-error',
            handle: async (input, deps) => {
                const store = deps.extras.pauseStore;
                if (!store)
                    return;
                const { handleListPauses } = await import('../pipeline-pause-handlers.js');
                // The helper takes the *full* msg, not the parsed input — its
                // own zod schema accepts the same fields. Pass the parsed data
                // verbatim; passthrough fields are preserved.
                const env = handleListPauses(store, input);
                deps.ws.send(JSON.stringify(env));
            },
        }),
        'get-pipeline-pause': route({
            input: Z.GetPipelinePause,
            onParseFail: 'silent',
            errorWireType: 'pipeline-pause-error',
            handle: async (input, deps) => {
                const store = deps.extras.pauseStore;
                if (!store)
                    return;
                const { handleGetPause } = await import('../pipeline-pause-handlers.js');
                const env = handleGetPause(store, input);
                deps.ws.send(JSON.stringify(env));
            },
        }),
    };
}
//# sourceMappingURL=pauses.js.map