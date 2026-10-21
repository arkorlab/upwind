import { buildProjectManifest, type ReservedRoute } from '@stayingupwind/core/manifest';
import { middlewareApplies } from '@stayingupwind/core/paas';
import { EDGE_BYPASS_COOKIE } from '@stayingupwind/core/request';
import { assert, describe, expect, it } from 'vitest';

import { fileRequestsFor } from '../src/browsers.ts';
import { claimedBy, escaping, type Target } from '../src/escaping.ts';
import { edgeReads, middlewareReads, routedReads } from '../src/routing-reads.ts';

const URL_OF_FILE = new URL('https://site.example/a.txt');
const AT = '2026-10-21T00:00:00.000Z';
const MANIFEST = buildProjectManifest({
  projectId: 'site',
  runId: 'run',
  generatedAt: AT,
  originHost: URL_OF_FILE.hostname,
  deployment: { assetSetHash: 'a'.repeat(64), observedAt: AT },
  app: { deploymentId: 'dpl_site', scriptName: 'app' },
  routes: [],
});

function clientHeaders(): Record<string, string> {
  return {
    via: 'the visitor',
    'x-arkor-test': 'untrusted',
    cookie: `session=kept; ${EDGE_BYPASS_COOKIE}=1`,
    rsc: '1',
    'next-router-state-tree': 'the client tree',
  };
}

describe('the headers used for pre-middleware rule and matcher checks', () => {
  it('keeps the raw classification view and leaves its input untouched', () => {
    const sent = clientHeaders();
    const raw = edgeReads(sent);
    const routed = routedReads(URL_OF_FILE, sent);

    expect(raw.get('via')).toBe('the visitor');
    expect(raw.get('cookie')).toBe(sent['cookie']);
    expect(raw.get('x-arkor-test')).toBe('untrusted');
    expect(routed.get('via')).toBe('1.1 arkor-edge');
    expect(routed.get('cookie')).toBe('session=kept');
    expect(routed.has('x-arkor-test')).toBe(false);
    expect(routed.get('next-router-state-tree')).toBe('the client tree');
  });

  it.each([
    {
      label: 'Via supplied by the edge',
      has: [{ type: 'header' as const, key: 'via', value: '^1[.]1 arkor-edge$' }],
      missing: [],
      expected: true,
    },
    {
      label: 'internal header taken off',
      has: [{ type: 'header' as const, key: 'x-arkor-test' }],
      missing: [],
      expected: false,
    },
    {
      label: 'absence of an internal header',
      has: [],
      missing: [{ type: 'header' as const, key: 'x-arkor-test' }],
      expected: true,
    },
    {
      label: 'recovery cookie taken off',
      has: [{ type: 'cookie' as const, key: EDGE_BYPASS_COOKIE }],
      missing: [],
      expected: false,
    },
    {
      label: 'absence of the recovery cookie',
      has: [],
      missing: [{ type: 'cookie' as const, key: EDGE_BYPASS_COOKIE }],
      expected: true,
    },
  ])('judges $label on the forwarded view', (example) => {
    const headers = middlewareReads({}, URL_OF_FILE, clientHeaders());
    const matcher = { sourceRegex: '^/a[.]txt$', has: example.has, missing: example.missing };

    expect(middlewareApplies([matcher], URL_OF_FILE, headers)).toBe(example.expected);
    expect(headers.get('rsc')).toBe('1');
  });

  it.each([
    { path: '/_next/data/build/a.json', expected: '1' },
    { path: '/a', expected: null },
  ])('uses the Pages data matcher marker for $path', (example) => {
    const url = new URL(example.path, URL_OF_FILE);
    const headers = middlewareReads({}, url, { 'x-nextjs-data': 'visitor' });

    expect(headers.get('x-nextjs-data')).toBe(example.expected);
    expect(headers.get('via')).toBe('1.1 arkor-edge');
  });

  it.each([
    {
      label: 'edge Via present',
      has: [{ type: 'header' as const, key: 'via', value: '^1[.]1 arkor-edge$' }],
      missing: [],
      expected: true,
    },
    {
      label: 'edge Via absent',
      has: [],
      missing: [{ type: 'header' as const, key: 'via' }],
      expected: false,
    },
    {
      label: 'recovery cookie absent',
      has: [],
      missing: [{ type: 'cookie' as const, key: EDGE_BYPASS_COOKIE }],
      expected: true,
    },
  ])('uses $label for both reservation and escape selection', (example) => {
    const rule: ReservedRoute = {
      sourceRegex: '^/a[.]txt$',
      beforeFiles: true,
      has: example.has,
      missing: example.missing,
    };
    const target: Target = {
      manifest: { ...MANIFEST, reservedRoutes: [rule] },
      url: URL_OF_FILE,
      prover: 'checker',
      exact: true,
      requestClass: 'file',
    };
    const sent = clientHeaders();

    expect(claimedBy(target, sent, () => true)).toBe(example.expected);
    expect(escaping(target, sent, () => true).kind).toBe(example.expected ? 'claimed' : 'escaped');
    expect(sent['via']).toBe('the visitor');
    expect(sent['cookie']).toContain(EDGE_BYPASS_COOKIE);
  });

  it('can escape a file reservation through a deployment header without changing the file class', () => {
    const rule: ReservedRoute = {
      sourceRegex: '^/a[.]txt$',
      beforeFiles: true,
      missing: [{ type: 'header', key: 'x-deployment-id', value: '^canary$' }],
    };
    const samples = fileRequestsFor({
      manifest: { ...MANIFEST, reservedRoutes: [rule] },
      url: URL_OF_FILE,
      prover: 'checker',
      exact: true,
      contentTypes: ['text/plain'],
    });
    const sample = samples[0];

    assert(sample?.kind === 'asked', 'no ordinary file witness');

    expect(samples).toHaveLength(1);
    expect(sample.headers['x-deployment-id']).toBe('canary');
  });
});
