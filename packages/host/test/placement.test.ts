import { describe, expect, it } from 'vitest';

import { placementMapSchema } from '../src/delivery/placement.ts';

const PLACED = {
  backend: 'r2',
  locator: 'blobs/a',
  byteLength: 1,
  verifiedAt: '2026-10-13T00:00:00.000Z',
} as const;

describe("a manifest's placements", () => {
  it('are kept by the digest of each artifact placed', () => {
    const placements = { ['a'.repeat(64)]: [PLACED] };

    expect(placementMapSchema.safeParse({ manifestId: 'm', placements }).success).toBe(true);
  });

  /** An artifact is found by its digest on every backend, and by nothing else. */
  it.each(['html', 'A'.repeat(64), 'a'.repeat(63)])('are not kept by %j', (key) => {
    const placements = { [key]: [PLACED] };

    expect(placementMapSchema.safeParse({ manifestId: 'm', placements }).success).toBe(false);
  });
});
