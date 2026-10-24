import { describe, expect, it } from 'vitest';

import { routeEntrySchema } from '../src/manifest/schema.ts';
import {
  answeredAsCandidate,
  manifestIdPrefix,
  respondedUnderPolicy,
  routeDebugValue,
} from '../src/request/edge-response.ts';

const IDS = [
  { value: 'abcdef0123456789', expected: 'abcdef01' },
  { value: 'a:b+_~ z-rest', expected: 'a:b+_~%20z' },
  { value: 'line\r\nbreak', expected: 'line%5Cr%5Cnbr' },
  { value: 'nul\0byte', expected: 'nul%5Cu0000byte' },
  { value: 'a;b', expected: 'a%3Bb' },
  { value: 'a ', expected: 'a%20' },
  { value: ' a ', expected: '%20a%20' },
  { value: ' '.repeat(8), expected: '%20%20%20%20%20%20%20%20' },
  { value: '1234567 tail', expected: '1234567%20' },
  { value: 'a%b', expected: 'a%25b' },
  { value: 'a%3Bb', expected: 'a%253Bb' },
  { value: '\u{D800}', expected: '%5Cud800' },
  { value: '\u{DC00}', expected: '%5Cudc00' },
  { value: '123456😀', expected: '123456%F0%9F%98%80' },
  { value: '1234567😀', expected: '1234567%5Cud83d' },
] as const;

describe('a manifest identity in a diagnostic field', () => {
  it.each(IDS)('keeps $expected header-safe and verifiable', ({ value, expected }) => {
    const prefix = manifestIdPrefix(value);

    expect(prefix).toBe(expected);

    const headers = new Headers({ 'x-arkor-edge': `shell;policy=policy;m=${prefix}` });
    const markers = { debug: headers.get('x-arkor-edge') ?? '', validated: true };
    const candidate = { manifestId: value, policyId: 'policy' };

    expect(answeredAsCandidate(markers, candidate)).toBe(true);
    expect(answeredAsCandidate(markers, { ...candidate, manifestId: 'zzzzzzzz' })).toBe(false);
    expect(answeredAsCandidate(markers, { ...candidate, policyId: 'other' })).toBe(false);
    expect(answeredAsCandidate({ ...markers, validated: false }, candidate)).toBe(false);
  });
});

const ROUTES = [
  { pathname: '/', expected: '/' },
  { pathname: '/items/[id]', expected: '/items/[id]' },
  { pathname: '/items/[...parts]', expected: '/items/[...parts]' },
  { pathname: '/percent%3B', expected: '/percent%3B' },
  { pathname: '/a;b', expected: '~%2Fa%3Bb' },
  { pathname: '/a%3Bb', expected: '/a%3Bb' },
  { pathname: '/line\r\nbreak', expected: '~%2Fline%5Cr%5Cnbreak' },
  { pathname: '/nul\0byte', expected: '~%2Fnul%5Cu0000byte' },
  { pathname: '/space ', expected: '~%2Fspace%20' },
  { pathname: '/日本', expected: '~%2F%E6%97%A5%E6%9C%AC' },
  { pathname: '/\u{D800}', expected: '~%2F%5Cud800' },
  { pathname: '/\u{DC00}', expected: '~%2F%5Cudc00' },
  { pathname: String.raw`/\ud800`, expected: String.raw`/\ud800` },
] as const;

describe('a route identity in a diagnostic field', () => {
  it.each(ROUTES)('keeps $expected distinct and header-safe', ({ pathname, expected }) => {
    expect(routeEntrySchema.shape.pathname.parse(pathname)).toBe(pathname);

    const value = routeDebugValue(pathname);
    const headers = new Headers({ 'x-arkor-edge': `shell;route=${value}` });

    expect(value).toBe(expected);
    expect(headers.get('x-arkor-edge')?.split(';')).toStrictEqual(['shell', `route=${expected}`]);
  });

  it('cannot confuse an escaped value with another valid route name', () => {
    expect(routeEntrySchema.shape.pathname.safeParse('~%2Fa%3Bb').success).toBe(false);
    expect(routeDebugValue('/a;b')).not.toBe(routeDebugValue('/a%3Bb'));
    expect(routeDebugValue('/日本')).not.toBe(routeDebugValue('/%E6%97%A5%E6%9C%AC'));
    expect(routeDebugValue('/\u{D800}')).not.toBe(routeDebugValue(String.raw`/\ud800`));
  });
});

const MANIFEST_ID = 'abcdef0123456789abcdef0123456789';
const CANDIDATE = { manifestId: MANIFEST_ID, policyId: 'v1' };
const DEBUG = `shell;strategy=kv;src=kv;m=abcdef01;policy=v1`;

describe('respondedUnderPolicy', () => {
  it('matches the policy field whole', () => {
    const debug = 'asset;strategy=workers-cache;admit=1;bytes=1024;project=p;policy=v1-beta';

    expect(respondedUnderPolicy(debug, 'v1-beta')).toBe(true);
    // A substring test would accept this response for a run validating `v1`.
    expect(respondedUnderPolicy(debug, 'v1')).toBe(false);
    expect(respondedUnderPolicy(DEBUG, 'v1')).toBe(true);
    expect(respondedUnderPolicy('', 'v1')).toBe(false);
  });
});

describe('answeredAsCandidate', () => {
  it('accepts a validated response from the named manifest and policy', () => {
    expect(answeredAsCandidate({ debug: DEBUG, validated: true }, CANDIDATE)).toBe(true);
  });

  /**
   * A validation header the edge cannot verify is ignored in silence and the active pointer
   * answers. When the candidate reuses the active policy — benchmarking a new manifest does
   * exactly that — the policy field alone would accept that answer as the candidate's.
   */
  it('refuses a response the edge did not mark validated', () => {
    expect(answeredAsCandidate({ debug: DEBUG, validated: false }, CANDIDATE)).toBe(false);
  });

  it('refuses a response from another manifest under the same policy', () => {
    const other = 'shell;strategy=kv;src=kv;m=99999999;policy=v1';

    expect(answeredAsCandidate({ debug: other, validated: true }, CANDIDATE)).toBe(false);
  });

  it('refuses a response from another policy and one with no debug header at all', () => {
    const other = `shell;strategy=kv;src=kv;m=abcdef01;policy=v2`;

    expect(answeredAsCandidate({ debug: other, validated: true }, CANDIDATE)).toBe(false);
    expect(answeredAsCandidate({ debug: '', validated: true }, CANDIDATE)).toBe(false);
  });
});
