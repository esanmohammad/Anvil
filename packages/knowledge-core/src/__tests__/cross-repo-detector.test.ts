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
import { detectCrossRepoEdges, extractCrossRepoSignals } from '../cross-repo-detector.js';

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

describe('detectCrossRepoEdges — end to end', () => {
  it('produces only true edges across the fixture estate', async () => {
    const edges = await detectCrossRepoEdges(
      ['gateway', 'user', 'orders', 'payment', 'shipping', 'queue-master'].map(repo),
      new Map(),
    );
    const key = (e: { edgeType: string; sourceRepo: string; targetRepo: string; evidence: string }) =>
      `${e.edgeType} ${e.sourceRepo}->${e.targetRepo} ${e.evidence}`;
    const got = new Set(edges.map(key));

    assert.ok(got.has('http gateway->user API endpoint: /customers'));
    assert.ok(got.has('http gateway->user API endpoint: /login'));
    assert.ok(got.has('http orders->payment API endpoint: /paymentAuth'));
    assert.ok([...got].some((k) => k.startsWith('event-schema') && k.endsWith('shipping-task')));
    assert.ok([...got].some((k) => k.startsWith('database') && k.endsWith('Shared table: customers')));

    const bogus = edges.filter((e) => e.edgeType === 'database' && /Shared table: (util|time|subprocess|the|http)$/.test(e.evidence));
    assert.equal(bogus.length, 0, `false-positive table edges: ${bogus.map((e) => e.evidence).join(', ')}`);
  });
});
