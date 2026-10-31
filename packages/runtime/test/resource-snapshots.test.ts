import { resourceSnapshotTag } from '@stayingupwind/core/cache';
import { observeResourceSnapshot, observePublicationTags } from '@stayingupwind/core/paas';
import { describe, expect, it, vi } from 'vitest';

import type { CapturedRender } from '../src/cache/capture.ts';
import { publicationContext, publicationRun, requestContextFor } from '../src/cache/context.ts';
import { generationTagValues, withGenerationPublication } from '../src/cache/generation-tags.ts';
import { reusePublication } from '../src/cache/publication.ts';
import { livePublicationState } from '../src/publication-state.ts';

const RESOURCE = 'b'.repeat(64);
const TAG = 'resource:inventory';
const OLD = resourceSnapshotTag({ resourceId: RESOURCE, version: 3 });
const NEW = resourceSnapshotTag({ resourceId: RESOURCE, version: 9 });
const OUTPUT: CapturedRender = {
  html: new Uint8Array(),
  postponed: undefined,
  rscData: undefined,
  data: undefined,
  segments: new Map(),
  headers: {},
  status: 200,
  cacheControl: { revalidate: 60, expire: 600 },
};

function context() {
  return requestContextFor({
    tables: { app: { entries: {} }, edge: { entries: {} } },
    runtime: undefined,
    request: new Request('https://fixture.test/items'),
    startedAt: 1000,
    clock: 1000,
    waitUntil: vi.fn(),
  });
}

describe('resource snapshot dependencies in route captures', () => {
  it('keeps a v3 live result pending until both its public identity and original resource snapshot are observed', () => {
    const id = 'a'.repeat(64);
    const required = {
      version: 3 as const,
      valueObservers: true as const,
      resourceSnapshots: true as const,
      identities: [id],
      routes: ['/items'],
    };
    const grant = `upwind:publication:v1:${id}:60000`;

    expect(livePublicationState(new Set([grant]), [], required, 1000)).toStrictEqual({
      valid: true,
      ready: false,
    });
    expect(livePublicationState(new Set([grant]), [TAG, OLD], required, 1000)).toStrictEqual({
      valid: true,
      ready: true,
    });
    expect(
      livePublicationState(
        new Set([grant]),
        [OLD, 'upwind:resource-snapshot:v2:bad'],
        required,
        1000,
      ),
    ).toStrictEqual({ valid: false, ready: false });
  });

  it('does not let a later resource receipt erase an earlier publication expiry refusal', async () => {
    const request = context();

    await expect(
      request.run(async () => {
        await Promise.resolve();
        observePublicationTags([`upwind:publication:v1:${'a'.repeat(64)}:999`]);
      }),
    ).rejects.toThrow('Publication unavailable');

    await expect(
      request.run(async () => {
        await Promise.resolve();
        observeResourceSnapshot({ resourceId: RESOURCE, version: 3, tag: TAG });
      }),
    ).rejects.toThrow('Publication unavailable');
  });

  it('misses an older granted cache entry without its original witness under a v3 host', () => {
    const required = {
      version: 3 as const,
      valueObservers: true as const,
      resourceSnapshots: true as const,
      identities: ['a'.repeat(64)],
      routes: ['/items'],
    };
    const grant = `upwind:publication:v1:${'a'.repeat(64)}:60000`;

    expect(reusePublication([grant], 1000, required)).toBe(false);
    expect(reusePublication(['static-stylesheet'], 1000, required)).toBe(true);
    expect(reusePublication([grant, TAG, OLD], 1000, required)).toBe(true);
  });

  it('captures the original database version without a cache-unit or another authority call', async () => {
    const request = context();
    await request.run(() => {
      observeResourceSnapshot({ resourceId: RESOURCE, version: 3, tag: TAG });
      const tags = generationTagValues(
        { kind: 'app-route', route: '/items', pathname: '/items' },
        OUTPUT,
        'entry',
      );

      expect(tags.has(TAG)).toBe(true);
      expect(tags.has(OLD)).toBe(true);
      expect(withGenerationPublication(OUTPUT).headers['x-next-cache-tags']).toContain(OLD);

      return Promise.resolve();
    });
  });

  it('retains older cached child witnesses when a newer parent read occurs', async () => {
    const request = context();
    await request.run(() => {
      observeResourceSnapshot({ resourceId: RESOURCE, version: 9, tag: TAG });

      expect(reusePublication([TAG, OLD], 1000)).toBe(true);
      expect(publicationContext()?.resourceTags).toStrictEqual(new Set([NEW, OLD, TAG]));

      return Promise.resolve();
    });
  });

  it('isolates a fresh regeneration from its served predecessor while preserving the actual request', async () => {
    const request = context();
    await request.run(async () => {
      reusePublication([TAG, OLD], 1000);
      const regenerate = publicationRun(request.run);
      await regenerate(() => {
        observeResourceSnapshot({ resourceId: RESOURCE, version: 9, tag: TAG });

        expect(publicationContext()?.resourceTags).toStrictEqual(new Set([NEW, TAG]));

        return Promise.resolve();
      });

      expect(publicationContext()?.resourceTags).toStrictEqual(new Set([OLD, TAG]));
    });
  });
});
