import { resourceSnapshotTag, type PublicationRequirement } from '@stayingupwind/core/cache';
import { describe, expect, it, vi } from 'vitest';

import { requestContextFor } from '../src/cache/context.ts';
import { reusePublication } from '../src/cache/publication.ts';

const NOW = 1_800_000_000_000;
const ID = 'a'.repeat(64);
const NEXT = 'b'.repeat(64);
const TAG = `upwind:publication:v1:${ID}:${String(NOW + 60_000)}`;
const WITNESS = resourceSnapshotTag({ resourceId: ID, version: 1 });
const REQUIRED: PublicationRequirement = {
  version: 3,
  valueObservers: true,
  resourceSnapshots: true,
  identities: [ID],
  routes: ['/'],
};

describe('publication cache dependency admission', () => {
  it.each([
    { tags: [TAG, 'upwind:resource-snapshot:v1:broken', WITNESS] },
    { tags: [TAG, WITNESS, 'upwind:resource-snapshot:v1:broken'] },
  ])('rejects every malformed stored witness as a local miss ($tags)', ({ tags }) => {
    expect(reusePublication(tags, NOW, REQUIRED)).toBe(false);
  });

  it('checks allowed identities without requiring every route source from one cached child', async () => {
    const required: PublicationRequirement = { ...REQUIRED, identities: [ID, NEXT] };
    const request = requestContextFor({
      tables: { app: { entries: {} }, edge: { entries: {} } },
      runtime: undefined,
      request: new Request('https://example.test/'),
      startedAt: NOW,
      waitUntil: vi.fn(),
      clock: NOW,
    });
    request.publicationRequirement = required;

    await request.run(() => {
      expect(reusePublication([TAG, WITNESS], NOW, required)).toBe(true);
      expect(request.publication).toStrictEqual(new Set([TAG]));

      return Promise.resolve();
    });
  });

  it('allows neutral and partial nested dependencies while the response proves all sources', () => {
    const required: PublicationRequirement = { ...REQUIRED, identities: [ID, NEXT] };

    expect(reusePublication([], NOW, required)).toBe(true);
    expect(reusePublication([TAG, WITNESS], NOW, required)).toBe(true);
  });
});
