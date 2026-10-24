/**
 * Tests for cross-repo-detector.ts — polyglot route/client/queue detection and
 * the SQL-table false-positive fix.
 *
 * Fixtures model a small microservice estate (a Node gateway, Go and Java
 * services) of the kind the detector previously could not see at all.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { correlateCrossRepoEdges, detectCrossRepoEdges, extractCrossRepoSignals } from '../cross-repo-detector.js';
import type { CrossRepoSignals } from '../cross-repo-detector.js';
import type { CrossRepoEdge, WorkspaceMap, WorkspacePackage } from '../types.js';

let root: string;
const repo = (name: string) => ({ name, path: join(root, name), language: 'mixed' });
function write(repoName: string, rel: string, content: string): void {
  const full = join(root, repoName, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

before(() => {
  root = mkdtempSync(join(tmpdir(), 'xrepo-'));

  // Node gateway: hand-built service URLs + a bare fetch() (single capture group)
  write('gateway', 'api/endpoints.js', `
    const util = require('util');
    module.exports = {
      customersUrl: util.format("http://user%s/customers", domain),
      loginUrl: \`http://user\${domain}/login\`,
      cartsUrl: "http://carts/carts",
    };
    fetch('/health');
  `);
  write('gateway', 'lib/legacy.py', 'from util import helper\nfrom time import sleep\n');

  // Go user service: gorilla/mux routes
  write('user', 'api/transport.go', `
    r.Methods("GET").Path("/customers").Handler(h)
    r.Methods("POST").Path("/login").Handler(h)
    http.HandleFunc("/health", healthHandler)
  `);
  write('user', 'tools/gen.py', 'from util import helper\nfrom subprocess import run\n');
  write('user', 'db/schema.sql', 'CREATE TABLE customers (id text);\nSELECT * FROM customers;\n');

  // Java orders service: Spring route + ServiceUri client calls
  write('orders', 'src/OrdersController.java', `
    @RequestMapping(path = "/orders", method = RequestMethod.GET)
    public URI getPaymentUri() {
      return new ServiceUri(new Hostname("payment"), new Domain(domain), "/paymentAuth").toUri();
    }
  `);
  write('orders', 'db/migrate.sql', 'INSERT INTO customers (id) VALUES (1);\n');

  // Go payment service
  write('payment', 'main.go', 'r.Path("/paymentAuth").Handler(h)\nr.Path("/health").Handler(h)\n');

  // Java shipping -> queue-master over RabbitMQ
  write('shipping', 'src/Config.java', `
    final static String queueName = "shipping-task";
    rabbitTemplate.convertAndSend("shipping-task", shipment);
  `);
  write('queue-master', 'src/Consumer.java', '@RabbitListener(queues = "shipping-task")\npublic void onShipment(Shipment s) {}\n');

  // Node billing API + a UI calling it through template-literal URLs; a Go/Python
  // worker sharing its env vars (read in code, no .env template anywhere).
  write('billing', 'src/server.ts', `
    app.get('/api/invoices/:id', getInvoice);
    router.get('/api/invoices/:invoiceId/lines', getLines);
    const db = process.env.BILLING_DB_URL;
    const bucket = process.env['INVOICE_BUCKET'];
    const mode = process.env.NODE_ENV;
  `);
  write('billing-ui', 'src/client.ts', `
    export const getInvoice = (id: string) => fetch(\`http://billing/api/invoices/\${id}\`);
    export const getLines = (id: string) => axios.get(\`\${BILLING_URL}/api/invoices/\${id}/lines\`);
    export const anything = (p: string) => fetch(\`\${base}/\${p}\`);
    const mode = process.env.NODE_ENV;
  `);
  write('billing-worker', 'main.go', 'dsn := os.Getenv("BILLING_DB_URL")\nport := os.Getenv("PORT")\n');
  write('billing-worker', 'jobs/export.py', 'bucket = os.environ.get("INVOICE_BUCKET")\nport = os.environ["PORT"]\n');

  // Go kafka-go consumer: the topic is a struct field.
  write('notifier', 'consumer.go', 'r := kafka.NewReader(kafka.ReaderConfig{Brokers: brokers, Topic: "order-created", GroupID: "notifier"})\n');

  // A checkout whose location contains a path-filter keyword ("deploy").
  write('deploy/checkout', 'config/app.yaml', 'url: "billing.prod.svc"\n');
});

after(() => rmSync(root, { recursive: true, force: true }));

describe('extractCrossRepoSignals — polyglot coverage', () => {
  it('finds Go gorilla/mux and net/http route definitions', () => {
    const s = extractCrossRepoSignals(join(root, 'user'));
    assert.deepEqual(Object.keys(s.apiRoutes ?? {}).sort(), ['/customers', '/health', '/login']);
  });

  it('finds Spring MVC route definitions', () => {
    const s = extractCrossRepoSignals(join(root, 'orders'));
    assert.ok('/orders' in (s.apiRoutes ?? {}));
  });

  it('finds hand-built service URLs (format strings, template literals, plain strings)', () => {
    const s = extractCrossRepoSignals(join(root, 'gateway'));
    assert.deepEqual(Object.keys(s.apiClients ?? {}).sort(), ['/carts', '/customers', '/health', '/login']);
  });

  it('finds Java ServiceUri-style client calls', () => {
    const s = extractCrossRepoSignals(join(root, 'orders'));
    assert.ok('/paymentAuth' in (s.apiClients ?? {}));
  });

  it('does not throw on a bare fetch() with a single capture group', () => {
    assert.doesNotThrow(() => extractCrossRepoSignals(join(root, 'gateway')));
  });

  it('finds Go kafka-go topics set as a struct field', () => {
    assert.ok('order-created' in (extractCrossRepoSignals(join(root, 'notifier')).events ?? {}));
  });

  it('finds RabbitMQ queue names with dashes', () => {
    assert.ok('shipping-task' in (extractCrossRepoSignals(join(root, 'shipping')).events ?? {}));
    assert.ok('shipping-task' in (extractCrossRepoSignals(join(root, 'queue-master')).events ?? {}));
  });

  it('does not treat Python/JS `from x import` as a database table', () => {
    const tables = Object.keys(extractCrossRepoSignals(join(root, 'user')).dbTables ?? {});
    assert.ok(!tables.includes('util'), `util leaked in: ${tables}`);
    assert.ok(!tables.includes('subprocess'), `subprocess leaked in: ${tables}`);
    assert.ok(tables.includes('customers'), `real SQL table missing: ${tables}`);
  });
});

describe('extractCrossRepoSignals — checkout-independent paths', () => {
  it('records file paths relative to the repo root', () => {
    const s = extractCrossRepoSignals(join(root, 'user'));
    assert.equal(s.apiRoutes?.['/customers'], join('api', 'transport.go'));
    assert.equal(s.dbTables?.customers, join('db', 'schema.sql'));
    assert.equal(extractCrossRepoSignals(join(root, 'shipping')).events?.['shipping-task'], join('src', 'Config.java'));
  });

  it('applies path filters to the repo-relative path, not the checkout location', () => {
    // Checked out under …/deploy/… — that must not turn every YAML into a k8s manifest.
    assert.deepEqual(extractCrossRepoSignals(join(root, 'deploy', 'checkout')).k8sRefs, []);
  });
});

describe('extractCrossRepoSignals — template-literal clients + env vars in code', () => {
  it('finds HTTP clients whose URL interpolates params or a base URL', () => {
    const clients = Object.keys(extractCrossRepoSignals(join(root, 'billing-ui')).apiClients ?? {}).sort();
    // `${base}/${p}` has no literal segment and is not a usable route key.
    assert.deepEqual(clients, ['/api/invoices/:param', '/api/invoices/:param/lines']);
  });

  it('reads env vars from code (TS, Go, Python)', () => {
    assert.deepEqual(extractCrossRepoSignals(join(root, 'billing')).envVars?.sort(), ['BILLING_DB_URL', 'INVOICE_BUCKET', 'NODE_ENV']);
    assert.deepEqual(extractCrossRepoSignals(join(root, 'billing-worker')).envVars?.sort(), ['BILLING_DB_URL', 'INVOICE_BUCKET', 'PORT']);
  });
});

const key = (e: { edgeType: string; sourceRepo: string; targetRepo: string; evidence: string }) =>
  `${e.edgeType} ${e.sourceRepo}->${e.targetRepo} ${e.evidence}`;

describe('detectCrossRepoEdges — end to end', () => {
  it('produces only true edges across the fixture estate', async () => {
    const edges = await detectCrossRepoEdges(
      ['gateway', 'user', 'orders', 'payment', 'shipping', 'queue-master'].map(repo),
      new Map(),
    );
    const got = new Set(edges.map(key));

    assert.ok(got.has('http gateway->user API endpoint: /customers'));
    assert.ok(got.has('http gateway->user API endpoint: /login'));
    assert.ok(got.has('http orders->payment API endpoint: /paymentAuth'));
    assert.ok([...got].some((k) => k.startsWith('event-schema') && k.endsWith('shipping-task')));
    assert.ok([...got].some((k) => k.startsWith('database') && k.endsWith('Shared table: customers')));

    const bogus = edges.filter((e) => e.edgeType === 'database' && /Shared table: (util|time|subprocess|the|http)$/.test(e.evidence));
    assert.equal(bogus.length, 0, `false-positive table edges: ${bogus.map((e) => e.evidence).join(', ')}`);
  });

  it('links template-literal clients to routes and services sharing env vars', async () => {
    const edges = await detectCrossRepoEdges(['billing', 'billing-ui', 'billing-worker'].map(repo), new Map());
    const got = new Set(edges.map(key));

    assert.ok(got.has('http billing-ui->billing API endpoint: /api/invoices/:param'), [...got].join('\n'));
    assert.ok(got.has('http billing-ui->billing API endpoint: /api/invoices/:param/lines'));
    assert.ok(got.has('env-var billing->billing-worker Shared env var: BILLING_DB_URL'));
    assert.ok(got.has('env-var billing->billing-worker Shared env var: INVOICE_BUCKET'));
    assert.ok(![...got].some((k) => k.endsWith('Shared env var: NODE_ENV')), 'generic runtime var linked repos');
  });

  it('keys edge endpoints by repo-relative paths', async () => {
    const edges = await detectCrossRepoEdges(
      ['gateway', 'user', 'orders', 'payment', 'billing', 'billing-ui'].map(repo),
      new Map(),
    );
    assert.ok(edges.length > 0);
    for (const e of edges) {
      assert.ok(!e.sourceNode.includes(root) && !e.targetNode.includes(root), `absolute path in ${e.sourceNode} -> ${e.targetNode}`);
    }
    assert.ok(edges.some((e) => e.targetRepo === 'billing' && e.targetNode === `${join('src', 'server.ts')}::/api/invoices/:param`));
  });
});

describe('correlateCrossRepoEdges — env vars', () => {
  it('skips env vars read by nearly every repo', () => {
    const signals = new Map<string, CrossRepoSignals>(
      Array.from({ length: 6 }, (_, i) => [`svc${i}`, { envVars: i < 2 ? ['SENTRY_DSN', 'LEDGER_DB_URL'] : ['SENTRY_DSN'] }]),
    );
    const env = correlateCrossRepoEdges(signals).filter((e) => e.edgeType === 'env-var').map((e) => e.evidence);
    assert.deepEqual(env, ['Shared env var: LEDGER_DB_URL']);
  });
});

const fmt = (e: CrossRepoEdge) =>
  `${e.edgeType} ${e.confidence} ${e.sourceRepo}::${e.sourceNode} -> ${e.targetRepo}::${e.targetNode} | ${e.evidence}`;

describe('correlateCrossRepoEdges — golden edge set', () => {
  it('emits exactly these edges across all 14 strategies', () => {
    // Map order decides the direction of symmetric edges (earlier repo = source).
    const signals = new Map(Object.entries<CrossRepoSignals>({
      billing: {
        npmDeps: ['@org/logger', '@org/billing-sdk', '@org/logger'],
        types: { Invoice: 'src/types.ts', Money: 'src/money.ts' },
        envVars: ['BILLING_DB_URL', 'NODE_ENV', 'SENTRY_DSN', 'BILLING_DB_URL'],
        events: { 'invoice.created': 'src/events.ts' },
        apiRoutes: { '/api/invoices/:param': 'src/server.ts', '/health': 'src/server.ts' },
        apiClients: { '/health': 'src/self-check.ts' },
        grpcDefs: { Ledger: 'proto/ledger.proto' },
        dbTables: { invoices: 'db/schema.sql', customers: 'db/schema.sql' },
        redisPrefixes: { 'billing:invoice': 'src/cache.ts' },
        buckets: { 'invoice-pdfs': 'src/pdf.ts' },
        apiSpecPaths: { '/api/invoices/:param': 'openapi.yaml', '/api/invoices': 'openapi.yaml' },
        constants: { 'billing.invoice.v1': { name: 'INVOICE_SCHEMA', filePath: 'src/schema.ts' } },
      },
      'billing-ui': {
        npmDeps: ['@org/logger', '@org/ui-kit'],
        types: { Invoice: 'src/api.ts' },
        envVars: ['BILLING_URL', 'SENTRY_DSN', 'NODE_ENV'],
        apiClients: { '/api/invoices/:param': 'src/client.ts', '/api/invoices/:param/lines': 'src/client.ts', '/carts': 'src/cart.ts' },
        httpCalls: { '/api/invoices/:param': 'src/client.ts', '/api/invoices': 'src/list.ts' },
        constants: { 'billing.invoice.v1': { name: 'SCHEMA_ID', filePath: 'src/const.ts' } },
        composeRefs: [
          { file: 'docker-compose.yml', service: 'billing', evidence: 'Docker Compose depends_on: billing' },
          { file: 'docker-compose.yml', service: 'billing-ui', evidence: 'Docker Compose depends_on: billing-ui' },
          { file: 'docker-compose.yml', service: 'postgres', evidence: 'Docker Compose depends_on: postgres' },
        ],
      },
      'billing-worker': {
        envVars: ['BILLING_DB_URL', 'SENTRY_DSN', 'PORT'],
        events: { 'invoice.created': 'jobs/consume.go', 'invoice.paid': 'jobs/consume.go' },
        grpcClients: { Ledger: 'main.go' },
        dbTables: { invoices: 'internal/repo.go' },
        redisPrefixes: { 'billing:invoice': 'internal/cache.go' },
        buckets: { 'invoice-pdfs': 'jobs/export.py' },
        k8sRefs: [
          { file: 'k8s/deploy.yaml', service: 'billing', evidence: 'K8s service DNS: billing.prod.svc' },
          { file: 'k8s/deploy.yaml', service: 'ledger', evidence: 'K8s env service ref: ledger' },
        ],
      },
      'mta-ledger': {
        npmDeps: ['@org/logger'],
        envVars: ['SENTRY_DSN', 'AUDIT_URL'],
        events: { 'invoice.paid': 'src/consumer.ts' },
        grpcDefs: { Ledger: 'proto/ledger.proto' },
        grpcClients: { Ledger: 'src/self.ts' },
        dbTables: { ledger_entries: 'db/001.sql', customers: 'db/002.sql' },
      },
      gateway: {
        envVars: ['SENTRY_DSN', 'AUDIT_URL'],
        apiRoutes: { '/carts': 'src/routes.ts' },
        apiClients: { '/health': 'src/probe.ts', '/api/invoices/:param': 'src/proxy.ts' },
        httpCalls: { '/api/invoices': 'src/proxy.ts' },
        constants: {
          'billing.invoice.v1': { name: 'INV', filePath: 'src/c.ts' },
          'https://auth.example.com': { name: 'AUTH_URL', filePath: 'src/c.ts' },
        },
        composeRefs: [{ file: 'deploy/compose.yaml', service: 'mta_ledger', evidence: 'Docker Compose link: mta_ledger' }],
      },
      auth: {
        envVars: ['SENTRY_DSN', 'AUDIT_URL'],
        types: { Money: 'src/money.ts' },
        apiSpecPaths: { '/api/invoices': 'specs/openapi.json' },
        constants: { 'https://auth.example.com': { name: 'ISSUER', filePath: 'src/config.ts' } },
      },
      web: { npmDeps: ['@org/ui-kit'], envVars: ['SENTRY_DSN'] },
    }));
    const pkg = (name: string, dependencies: string[]): WorkspacePackage =>
      ({ name, path: '', relativePath: `packages/${name.split('/')[1]}`, ecosystem: 'npm', manifestFile: 'package.json', dependencies });
    const wsMap = (packages: WorkspacePackage[]): WorkspaceMap =>
      ({ repoPath: '', packages, nameToPackage: new Map(packages.map((p) => [p.name, p])), pathAliases: new Map() });
    const workspaceMaps = new Map<string, WorkspaceMap>([
      ['billing', wsMap([pkg('@billing/api', ['@billing/core', 'lodash']), pkg('@billing/core', ['@billing/core']), pkg('@billing/cli', ['@billing/api', '@billing/core'])])],
      ['web', wsMap([pkg('@web/app', ['@web/app'])])],
    ]);

    assert.deepEqual(correlateCrossRepoEdges(signals, workspaceMaps).map(fmt).sort(), [
      'api-contract 0.9 billing-ui::src/client.ts::/api/invoices/:param -> billing::openapi.yaml::/api/invoices/:param | OpenAPI endpoint: /api/invoices/:param',
      'api-contract 0.9 billing-ui::src/list.ts::/api/invoices -> auth::specs/openapi.json::/api/invoices | OpenAPI endpoint: /api/invoices',
      'api-contract 0.9 billing-ui::src/list.ts::/api/invoices -> billing::openapi.yaml::/api/invoices | OpenAPI endpoint: /api/invoices',
      'api-contract 0.9 gateway::src/proxy.ts::/api/invoices -> auth::specs/openapi.json::/api/invoices | OpenAPI endpoint: /api/invoices',
      'api-contract 0.9 gateway::src/proxy.ts::/api/invoices -> billing::openapi.yaml::/api/invoices | OpenAPI endpoint: /api/invoices',
      'database 0.85 billing::db/schema.sql::customers -> mta-ledger::db/002.sql::customers | Shared table: customers',
      'database 0.85 billing::db/schema.sql::invoices -> billing-worker::internal/repo.go::invoices | Shared table: invoices',
      'env-var 0.6 billing::env::BILLING_DB_URL -> billing-worker::env::BILLING_DB_URL | Shared env var: BILLING_DB_URL',
      'env-var 0.6 gateway::env::AUDIT_URL -> auth::env::AUDIT_URL | Shared env var: AUDIT_URL',
      'env-var 0.6 mta-ledger::env::AUDIT_URL -> auth::env::AUDIT_URL | Shared env var: AUDIT_URL',
      'env-var 0.6 mta-ledger::env::AUDIT_URL -> gateway::env::AUDIT_URL | Shared env var: AUDIT_URL',
      'event-schema 0.85 billing-worker::jobs/consume.go::invoice.paid -> mta-ledger::src/consumer.ts::invoice.paid | Shared event/topic: invoice.paid',
      'event-schema 0.85 billing::src/events.ts::invoice.created -> billing-worker::jobs/consume.go::invoice.created | Shared event/topic: invoice.created',
      'grpc 0.9 billing-worker::main.go::LedgerClient -> billing::proto/ledger.proto::Ledger | gRPC service: Ledger',
      'grpc 0.9 billing-worker::main.go::LedgerClient -> mta-ledger::proto/ledger.proto::Ledger | gRPC service: Ledger',
      'grpc 0.9 mta-ledger::src/self.ts::LedgerClient -> billing::proto/ledger.proto::Ledger | gRPC service: Ledger',
      'http 0.8 billing-ui::src/cart.ts::/carts -> gateway::src/routes.ts::/carts | API endpoint: /carts',
      'http 0.8 billing-ui::src/client.ts::/api/invoices/:param -> billing::src/server.ts::/api/invoices/:param | API endpoint: /api/invoices/:param',
      'http 0.8 billing-worker::k8s/deploy.yaml::k8s-env -> mta-ledger::k8s-service::ledger | K8s env service ref: ledger',
      'http 0.8 billing-worker::k8s/deploy.yaml::k8s-ref -> billing::k8s-service::billing | K8s service DNS: billing.prod.svc',
      'http 0.8 gateway::src/probe.ts::/health -> billing::src/server.ts::/health | API endpoint: /health',
      'http 0.8 gateway::src/proxy.ts::/api/invoices/:param -> billing::src/server.ts::/api/invoices/:param | API endpoint: /api/invoices/:param',
      'http 0.85 billing-ui::docker-compose.yml::compose -> billing::service::billing | Docker Compose depends_on: billing',
      'http 0.85 gateway::deploy/compose.yaml::compose -> mta-ledger::service::mta_ledger | Docker Compose link: mta_ledger',
      'npm-dep 0.7 billing-ui::package.json::@org/logger -> mta-ledger::package.json::@org/logger | Shared scoped dependency: @org/logger',
      'npm-dep 0.7 billing-ui::package.json::@org/ui-kit -> web::package.json::@org/ui-kit | Shared scoped dependency: @org/ui-kit',
      'npm-dep 0.7 billing::package.json::@org/logger -> billing-ui::package.json::@org/logger | Shared scoped dependency: @org/logger',
      'npm-dep 0.7 billing::package.json::@org/logger -> mta-ledger::package.json::@org/logger | Shared scoped dependency: @org/logger',
      'redis 0.75 billing::src/cache.ts::redis:billing:invoice -> billing-worker::internal/cache.go::redis:billing:invoice | Shared Redis key prefix: billing:invoice',
      's3 0.8 billing::src/pdf.ts::s3:invoice-pdfs -> billing-worker::jobs/export.py::s3:invoice-pdfs | Shared bucket: invoice-pdfs',
      'shared-constant 0.7 billing-ui::src/const.ts::SCHEMA_ID -> gateway::src/c.ts::INV | Shared constant value: "billing.invoice.v1" (SCHEMA_ID / INV)',
      'shared-constant 0.7 billing::src/schema.ts::INVOICE_SCHEMA -> billing-ui::src/const.ts::SCHEMA_ID | Shared constant value: "billing.invoice.v1" (INVOICE_SCHEMA / SCHEMA_ID)',
      'shared-constant 0.7 billing::src/schema.ts::INVOICE_SCHEMA -> gateway::src/c.ts::INV | Shared constant value: "billing.invoice.v1" (INVOICE_SCHEMA / INV)',
      'shared-constant 0.7 gateway::src/c.ts::AUTH_URL -> auth::src/config.ts::ISSUER | Shared constant value: "https://auth.example.com" (AUTH_URL / ISSUER)',
      'shared-type 0.9 billing::src/money.ts::Money -> auth::src/money.ts::Money | Shared type: Money',
      'shared-type 0.9 billing::src/types.ts::Invoice -> billing-ui::src/api.ts::Invoice | Shared type: Invoice',
      'workspace-dep 1 billing::pkg::@billing/api -> billing::pkg::@billing/core | @billing/api depends on @billing/core (package.json)',
      'workspace-dep 1 billing::pkg::@billing/cli -> billing::pkg::@billing/api | @billing/cli depends on @billing/api (package.json)',
      'workspace-dep 1 billing::pkg::@billing/cli -> billing::pkg::@billing/core | @billing/cli depends on @billing/core (package.json)',
    ]);
  });
});

describe('correlateCrossRepoEdges — scale', () => {
  it('joins 3000 repos in time linear in signals + edges, not repo pairs', () => {
    // Every repo holds 10 keys of its own per field plus one it shares with its
    // neighbour, and calls the next repo: ~470k signals, 27k edges. Comparing
    // repo pairs would take ~700M key lookups here (minutes); the hash join
    // takes well under a second.
    const N = 3000;
    const own = (field: string, i: number) => Array.from({ length: 10 }, (_, k) => `${field}-${i}-${k}`);
    const keyed = (field: string, i: number, extra: string) =>
      Object.fromEntries([...own(field, i), extra].map((k) => [k, `src/${field}.ts`]));
    const pair = (field: string, i: number) => keyed(field, i, `${field}-pair-${i >> 1}`);
    const next = (i: number) => (i + 1) % N;
    const signals = new Map<string, CrossRepoSignals>(Array.from({ length: N }, (_, i) => [`svc-${i}`, {
      npmDeps: [...own('@org/npm', i), `@org/npm-pair-${i >> 1}`],
      envVars: [...own('ENV', i), `ENV_PAIR_${i >> 1}`],
      types: pair('type', i),
      events: pair('event', i),
      dbTables: pair('table', i),
      redisPrefixes: pair('redis', i),
      buckets: pair('bucket', i),
      constants: Object.fromEntries([...own('v/const', i), `v/const-pair-${i >> 1}`].map((v) => [v, { name: 'C', filePath: 'src/c.ts' }])),
      apiRoutes: keyed('/route', i, `/route/${i}`),
      apiClients: keyed('/call', i, `/route/${next(i)}`),
      grpcDefs: keyed('Svc', i, `Svc${i}`),
      grpcClients: keyed('Cli', i, `Svc${next(i)}`),
      apiSpecPaths: keyed('/spec', i, `/spec/${i}`),
      httpCalls: keyed('/fetch', i, `/spec/${next(i)}`),
      composeRefs: [{ file: 'docker-compose.yml', service: `svc-${next(i)}`, evidence: 'compose' }],
      k8sRefs: [{ file: 'k8s/app.yaml', service: `svc-${next(i)}`, evidence: 'K8s service DNS' }],
    }]));

    const start = performance.now();
    const edges = correlateCrossRepoEdges(signals);
    const ms = performance.now() - start;

    // 8 symmetric strategies × N/2 pairs + 5 directional strategies × N calls.
    assert.equal(edges.length, 8 * (N / 2) + 5 * N);
    assert.ok(ms < 5000, `correlating ${N} repos took ${ms.toFixed(0)} ms`);
  });
});
