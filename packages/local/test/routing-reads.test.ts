import { middlewareApplies } from '@stayingupwind/core/paas';
import { EDGE_BYPASS_COOKIE } from '@stayingupwind/core/request';
import { describe, expect, it } from 'vitest';

import { edgeReads, middlewareReads, routedReads } from '../src/routing-reads.ts';

const URL_OF_FILE = new URL('https://site.example/a.txt');

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
});
