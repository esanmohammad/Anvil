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
import { readFile, stat } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { tryWebhookRoutes } from './webhook-routes.js';
/** Minimal MIME table — extend as needed; unmatched extensions fall back to `application/octet-stream`. */
const MIME = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.ttf': 'font/ttf',
    '.map': 'application/json',
};
export function createStaticHandler(deps) {
    return async (req, res) => {
        const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
        // All /share/* + /api/* webhook routes live in ./webhook-routes.ts
        // since Phase 2.8. Returns true if a route handled the request.
        if (await tryWebhookRoutes(req, res, deps.anvilHome, deps.kbManagerRef, deps.webhookDepsRef)) {
            return;
        }
        // Security: resolve and validate path to prevent directory traversal
        const requestedPath = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        let filePath = resolve(deps.staticDir, requestedPath);
        const resolvedStatic = resolve(deps.staticDir);
        if (!filePath.startsWith(resolvedStatic + '/') && filePath !== resolvedStatic) {
            res.writeHead(403, { 'Content-Type': 'text/plain' });
            res.end('Forbidden');
            return;
        }
        try {
            const s = await stat(filePath);
            if (s.isDirectory())
                filePath = join(filePath, 'index.html');
        }
        catch {
            filePath = join(deps.staticDir, 'index.html');
        }
        try {
            const data = await readFile(filePath);
            const ext = extname(filePath);
            res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
            res.end(data);
        }
        catch {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found');
        }
    };
}
//# sourceMappingURL=static.js.map