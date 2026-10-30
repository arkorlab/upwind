import { describe, expect, it } from 'vitest';

import {
  publicationDeadline,
  publicationExpired,
  publicationIdentity,
  publicationTagOf,
} from '../src/cache/publication.ts';

const grant = {
  scope: 'project',
  dataGeneration: 'generation-1',
  publicationEpoch: 2,
  release: { id: 'release-1', digest: 'a'.repeat(64) },
  validUntil: 60_000,
};

describe('publication bounds', () => {
  it('keeps immutable absolute deadlines through composition and delayed copies', async () => {
    const first = await publicationTagOf(grant);
    const renewed = await publicationTagOf({ ...grant, validUntil: 90_000 });

    expect(publicationDeadline([first, renewed])).toBe(60_000);
    expect(publicationExpired([first], 59_999)).toBe(false);
    expect(publicationExpired([first], 60_000)).toBe(true);
    expect(publicationExpired(structuredClone([first]), 90_000)).toBe(true);
  });

  it('refuses missing, malformed and mismatched required grants', async () => {
    const required = {
      version: 1 as const,
      identities: [await publicationIdentity(grant)],
      routes: ['/'],
    };

    expect(publicationExpired([], 1, required)).toBe(true);
    expect(publicationExpired(['upwind:publication:v1:bad:123'], 1)).toBe(true);

    const other = await publicationTagOf({ ...grant, dataGeneration: 'generation-2' });

    expect(publicationExpired([other], 1, required)).toBe(true);
    expect(publicationExpired([await publicationTagOf(grant)], 1, required)).toBe(false);
  });

  it('includes release and generation in identity, but never the renewal deadline', async () => {
    await expect(publicationIdentity({ ...grant, validUntil: 90_000 })).resolves.toBe(
      await publicationIdentity(grant),
    );
    await expect(
      publicationIdentity({ ...grant, release: { ...grant.release, id: 'release-2' } }),
    ).resolves.not.toBe(await publicationIdentity(grant));
  });
});
