/**
 * Phase S4 — sandbox network policy tests.
 *
 * Pure module under test — no Docker required. Covers:
 *   - resolveNetworkPolicy ordering (project block > stage allow >
 *     project allow > built-in package-manager hosts).
 *   - dockerRunNetworkArgs flag shape per resolved policy.
 *   - dnsmasqConfigBody allow + sinkhole rendering.
 *   - iptablesRulesForPolicy default-deny + allow-list shape.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveNetworkPolicy,
  dockerRunNetworkArgs,
  dnsmasqConfigBody,
  iptablesRulesForPolicy,
} from '../sandbox/network-policy.js';

describe('resolveNetworkPolicy', () => {
  it('falls back to default-deny + package-manager allow-list when no overlay', () => {
    const r = resolveNetworkPolicy({ stagePolicy: undefined, projectOverlay: undefined });
    assert.equal(r.default, 'deny');
    assert.ok(r.allowList!.includes('registry.npmjs.org'));
    assert.ok(r.allowList!.includes('github.com'));
    assert.ok(r.allowList!.includes('localhost'));
    assert.ok(r.sources.allowList.includes('package-manager'));
  });

  it('layers stage + project + package-manager allow-lists in order', () => {
    const r = resolveNetworkPolicy({
      stagePolicy: {
        mode: 'container',
        fsMode: 'overlay',
        limits: { network: { default: 'deny', allowList: ['stage.example.com'] } },
      },
      projectOverlay: { default: 'deny', allowList: ['project.example.com'] },
    });
    assert.ok(r.allowList!.includes('stage.example.com'));
    assert.ok(r.allowList!.includes('project.example.com'));
    assert.ok(r.allowList!.includes('registry.npmjs.org'));
  });

  it('project blockList wins over stage allow', () => {
    const r = resolveNetworkPolicy({
      stagePolicy: {
        mode: 'container',
        fsMode: 'overlay',
        limits: { network: { default: 'deny', allowList: ['nasty.example.com'] } },
      },
      projectOverlay: { default: 'deny', blockList: ['nasty.example.com'] },
    });
    assert.ok(!(r.allowList ?? []).includes('nasty.example.com'));
    assert.ok((r.blockList ?? []).includes('nasty.example.com'));
  });

  it('respects explicit allow when default is allow', () => {
    const r = resolveNetworkPolicy({
      stagePolicy: { mode: 'container', fsMode: 'overlay' },
      projectOverlay: { default: 'allow' },
    });
    assert.equal(r.default, 'allow');
  });

  it('skips the package-manager layer when includePackageManagerHosts=false', () => {
    const r = resolveNetworkPolicy({
      stagePolicy: { mode: 'container', fsMode: 'overlay' },
      projectOverlay: { default: 'deny', allowList: ['only.example.com'] },
      includePackageManagerHosts: false,
    });
    assert.deepEqual(r.allowList, ['only.example.com']);
  });
});

describe('dockerRunNetworkArgs', () => {
  it('returns no flags when default is allow with no allowList', () => {
    const args = dockerRunNetworkArgs({
      default: 'allow', allowList: [], blockList: [], allowLoopback: true,
      sources: { blockList: 'merged', allowList: [] },
    });
    assert.deepEqual(args, []);
  });

  it('returns --network none when default is deny with empty allowList + loopback', () => {
    const args = dockerRunNetworkArgs({
      default: 'deny', allowList: [], blockList: [], allowLoopback: true,
      sources: { blockList: 'merged', allowList: [] },
    });
    assert.deepEqual(args, ['--network', 'none']);
  });

  it('uses the custom bridge + DNS when there is an allowList', () => {
    const args = dockerRunNetworkArgs({
      default: 'deny', allowList: ['github.com'], blockList: [], allowLoopback: true,
      sources: { blockList: 'merged', allowList: ['package-manager'] },
    });
    assert.deepEqual(args, ['--network', 'anvil-sandbox', '--dns', '127.0.0.11']);
  });

  it('honors a custom DNS resolver', () => {
    const args = dockerRunNetworkArgs({
      default: 'deny', allowList: ['github.com'], blockList: [], allowLoopback: true,
      dnsResolver: '10.0.0.1',
      sources: { blockList: 'merged', allowList: ['stage'] },
    });
    assert.ok(args.includes('--dns'));
    assert.equal(args[args.indexOf('--dns') + 1], '10.0.0.1');
  });
});

describe('dnsmasqConfigBody', () => {
  it('emits a server= entry per allow-list host and the sinkhole when default-deny', () => {
    const body = dnsmasqConfigBody({
      default: 'deny',
      allowList: ['github.com', '*.npmjs.com', 'localhost'],
      blockList: ['tracker.com'],
      allowLoopback: true,
      sources: { blockList: 'merged', allowList: ['stage'] },
    });
    assert.match(body, /server=\/github\.com\//);
    assert.match(body, /server=\/npmjs\.com\//);  // wildcard stripped
    assert.match(body, /address=\/tracker\.com\/0\.0\.0\.0/);
    assert.match(body, /address=\/#\/0\.0\.0\.0/);  // sinkhole
    // Loopback names are NEVER added to dnsmasq — handled by the runtime.
    assert.ok(!/server=\/localhost\//.test(body));
  });

  it('omits the sinkhole when default is allow', () => {
    const body = dnsmasqConfigBody({
      default: 'allow',
      allowList: [],
      blockList: ['tracker.com'],
      allowLoopback: true,
      sources: { blockList: 'project', allowList: [] },
    });
    assert.ok(!body.includes('address=/#/'));
    assert.match(body, /address=\/tracker\.com\//);
  });
});

describe('iptablesRulesForPolicy', () => {
  it('emits default-DROP + DNS pass-through + per-host accept', () => {
    const rules = iptablesRulesForPolicy({
      default: 'deny',
      allowList: ['github.com', '*.npmjs.com'],
      blockList: ['tracker.com'],
      allowLoopback: true,
      sources: { blockList: 'merged', allowList: ['package-manager'] },
    });
    assert.ok(rules.includes('iptables -P OUTPUT DROP'));
    assert.ok(rules.some((r) => /-A OUTPUT -o lo -j ACCEPT/.test(r)));
    assert.ok(rules.some((r) => /--dport 53.*ACCEPT/.test(r)));
    assert.ok(rules.some((r) => /-d github\.com -j ACCEPT/.test(r)));
    assert.ok(rules.some((r) => /-d npmjs\.com -j ACCEPT/.test(r)));
    assert.ok(rules.some((r) => /-d tracker\.com -j DROP/.test(r)));
  });

  it('uses default ACCEPT when policy is default-allow', () => {
    const rules = iptablesRulesForPolicy({
      default: 'allow', allowList: [], blockList: [], allowLoopback: true,
      sources: { blockList: 'merged', allowList: [] },
    });
    assert.ok(rules.includes('iptables -P OUTPUT ACCEPT'));
  });
});
