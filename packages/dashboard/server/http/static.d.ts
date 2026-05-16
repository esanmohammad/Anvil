/**
 * Static file handler (Phase 3 round-8 extraction from
 * `dashboard-server.ts`).
 *
 * `createStaticHandler(deps)` returns the `(req, res)` callback wired
 * into `createServer(...)`. It first tries the webhook routes
 * (`/share/*`, `/api/*` — defined in `./webhook-routes.ts`); falls
 * through to disk-backed static serving from `staticDir`, with
 * directory-traversal protection. Missing paths land on `index.html`
 * so the React app's client-side router can handle deep links.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { KnowledgeBaseManager } from '../knowledge-base-manager.js';
import { type WebhookDeps } from './webhook-routes.js';
export interface StaticHandlerDeps {
    staticDir: string;
    anvilHome: string;
    kbManagerRef: {
        current: KnowledgeBaseManager | null;
    };
    webhookDepsRef: {
        current: WebhookDeps | null;
    };
}
export declare function createStaticHandler(deps: StaticHandlerDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
//# sourceMappingURL=static.d.ts.map