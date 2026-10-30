import { describe, expect, it } from 'vitest';

import { unsupportedPublication } from '../src/publication.ts';

describe('publication runtime capability', () => {
  const publication = { version: 1 as const, identities: ['a'.repeat(64)], routes: ['/'] };

  it('refuses protected deployment through an unaware runtime', () => {
    expect(unsupportedPublication({ publication, bundle: {} })).toContain('enforcing Function');
    expect(
      unsupportedPublication({ publication, bundle: { publicationGrants: 1 } }),
    ).toBeUndefined();
  });

  it('keeps unprotected deployments compatible with older bundles', () => {
    expect(unsupportedPublication({ bundle: {} })).toBeUndefined();
  });
});
