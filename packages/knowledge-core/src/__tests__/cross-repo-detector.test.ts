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
