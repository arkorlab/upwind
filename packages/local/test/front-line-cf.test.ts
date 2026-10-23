import { describe, expect, it } from 'vitest';

import { frontLineCf } from '../src/front-line-cf.ts';

describe('incoming cache metadata at the local front line', () => {
  it('keeps no-store and every unrelated field while removing only the equivalent legacy TTL', () => {
    const incoming = Object.freeze({
      cacheTtl: -1,
      cacheControl: 'no-store',
      cacheLevel: 'bypass',
      clientAcceptEncoding: 'gzip',
      country: 'JP',
      cacheTtlByStatus: { '200': 0 },
    });

    expect(frontLineCf(incoming, 'identity')).toStrictEqual({
      cacheControl: 'no-store',
      cacheLevel: 'bypass',
      clientAcceptEncoding: 'identity',
      country: 'JP',
      cacheTtlByStatus: { '200': 0 },
    });
    expect(incoming.cacheTtl).toBe(-1);
    expect(incoming.clientAcceptEncoding).toBe('gzip');
  });

  it.each([0, 60, -2, -2_147_483_648, 2_147_483_647])(
    'recognizes workerd’s exact synthesized directive for the int32 TTL %s',
    (cacheTtl) => {
      expect(frontLineCf({ cacheTtl, cacheControl: `max-age=${cacheTtl}` }, '')).toStrictEqual({
        cacheControl: `max-age=${cacheTtl}`,
        clientAcceptEncoding: '',
      });
    },
  );

  it.each([
    { cacheTtl: -1, cacheControl: 'private, no-store' },
    { cacheTtl: -1, cacheControl: 'max-age=-1' },
    { cacheTtl: 60, cacheControl: 'private, max-age=60' },
    { cacheTtl: 60, cacheControl: 'max-age=61' },
    { cacheTtl: 60, cacheControl: 'MAX-AGE=60' },
    { cacheTtl: 60, cacheControl: ' max-age=60' },
    { cacheTtl: '60', cacheControl: 'max-age=60' },
    { cacheTtl: 0.5, cacheControl: 'max-age=0.5' },
    { cacheTtl: 2_147_483_648, cacheControl: 'max-age=2147483648' },
    { cacheTtl: -2_147_483_649, cacheControl: 'max-age=-2147483649' },
    { cacheTtl: Infinity, cacheControl: 'max-age=Infinity' },
    { cacheTtl: NaN, cacheControl: 'max-age=NaN' },
    { cacheTtl: 60 },
    { cacheControl: 'private, no-store' },
    { cacheControl: 'no-cache', cacheForceRevalidate: true },
  ])('preserves unmatched or already valid metadata for native validation: %j', (incoming) => {
    expect(frontLineCf(incoming, 'br')).toStrictEqual({ ...incoming, clientAcceptEncoding: 'br' });
  });

  it('adds only the original encoding when no incoming metadata exists', () => {
    expect(frontLineCf(undefined, '')).toStrictEqual({ clientAcceptEncoding: '' });
  });
});
