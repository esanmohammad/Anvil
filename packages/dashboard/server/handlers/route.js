/**
 * Handler-route helper (Recipe 7 / Phase 1 of the dashboard decomposition).
 *
 * Today, every `case '<action>':` body in `dashboard-server.ts`
 * `handleClientMessage` repeats the same boilerplate:
 *
 *   const parsed = Z.<Action>.safeParse(msg);
 *   if (!parsed.success) { ws.send({type:'error',...}); break; }
 *   const result = doWork(parsed.data, ...);
 *   if ('error' in result) { ws.send({type:'error',...}); break; }
 *   ws.send({ type: '<wire>', payload: result });
 *
 * `route()` collapses that into a small typed configuration value. Each
 * registered route is `(msg, ws, deps) => Promise<void>` — same signature
 * as inlining the case body. The registry (`handlers/registry.ts`) maps
 * `msg.action` → one of these handlers.
 *
 * ### Reply shapes supported
 *
 * 1. **Echo back a single wire frame.** The most common case. Pass
 *    `wireType: 'plan-updated'` and have `handle` return the payload
 *    object. The helper sends `{ type: 'plan-updated', payload }`.
 *
 * 2. **Discriminated union on the result.** Many service methods return
 *    `{ result } | { error: 'X' }`. Pass `errorMessage(err, input)` to
 *    translate the typed error code into the human-facing message that
 *    today's case body builds. The helper detects `'error' in result`
 *    and routes to `errorWireType` (default: `'error'`).
 *
 * 3. **Fire-and-forget.** Service mutation already emitted through the
 *    bridge (e.g. `add-plan-comment` doesn't echo). Return `void` /
 *    `undefined` from `handle` and omit `wireType`.
 *
 * 4. **Hand-rolled wire writes.** Some handlers send multiple frames
 *    (e.g. `subscribe-cost` sends a snapshot AND joins a room) or shape
 *    the payload from input + result. Use `handle: async (input, deps) =>
 *    { deps.ws.send(...); }` and return `void` to keep total control.
 *
 * ### Error handling
 *
 * Exceptions thrown inside `handle` are caught and converted to
 * `{ type: errorWireType, payload: { message } }`. The default
 * `errorWireType` is `'error'` to match the legacy default; per-domain
 * routes (reviews, incidents, cost) override it to `'review-error'`,
 * `'incident-error'`, `'cost-error'` etc.
 *
 * ### Why we don't import `WsClient` from dashboard-server.ts
 *
 * `WsClient` is a structural type (`{ readyState; send(data) }`). We
 * declare it here to keep `handlers/*.ts` free of an import dependency
 * on the monolith — once Phase 1 lands, the registry is imported by
 * `dashboard-server.ts`, not the other way around.
 */
/**
 * Define one route. The returned `Handler` is what the registry stores.
 *
 * @param opts.input         Zod schema for the inbound message.
 * @param opts.handle        Async body — receives parsed input + deps.
 * @param opts.wireType      If set + `handle` returns a non-error result,
 *                           the result is sent as `{ type: wireType, payload }`.
 * @param opts.errorWireType Wire-type for errors (default `'error'`).
 *                           Override for review/cost/incident domains.
 * @param opts.errorMessage  Maps a typed error code (e.g. `'plan-not-found'`)
 *                           to the human message that goes onto the wire.
 *                           Defaults to using the code verbatim.
 */
export function route(opts) {
    return async function handler(msg, deps) {
        const parsed = opts.input.safeParse(msg);
        if (!parsed.success) {
            if (opts.onParseFail === 'silent')
                return;
            const extra = opts.errorEcho ? opts.errorEcho(msg) : undefined;
            sendError(deps.ws, opts.errorWireType ?? 'error', parsed.error.message, extra);
            return;
        }
        try {
            const result = await opts.handle(parsed.data, deps);
            if (result === undefined || result === null)
                return;
            if (typeof result === 'object' && 'error' in result && typeof result.error === 'string') {
                const code = result.error;
                const message = opts.errorMessage ? opts.errorMessage(code, parsed.data) : code;
                const extra = opts.errorEcho ? opts.errorEcho(parsed.data) : undefined;
                sendError(deps.ws, opts.errorWireType ?? 'error', message, extra);
                return;
            }
            if (opts.wireType) {
                deps.ws.send(JSON.stringify({ type: opts.wireType, payload: result }));
            }
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const extra = opts.errorEcho ? opts.errorEcho(parsed.data) : undefined;
            sendError(deps.ws, opts.errorWireType ?? 'error', message, extra);
        }
    };
}
function sendError(ws, wireType, message, extra) {
    ws.send(JSON.stringify({ type: wireType, payload: { ...(extra ?? {}), message } }));
}
//# sourceMappingURL=route.js.map