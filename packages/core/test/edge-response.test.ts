import { describe, expect, it } from 'vitest';

import { answeredAsCandidate, manifestIdPrefix } from '../src/request/edge-response.ts';

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
