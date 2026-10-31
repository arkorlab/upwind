import { afterEach, describe, expect, it, vi } from 'vitest';

import { admitPublication } from '../src/cache/publication-response.ts';
import { publicationRequirementSchema } from '../src/cache/publication-schema.ts';
import {
  publicationDeadline,
  publicationExpired,
  type PublicationRequirement,
} from '../src/cache/publication.ts';
import {
  RESOURCE_SNAPSHOT_PREFIX,
  resourceSnapshotOf,
  resourceSnapshotTag,
} from '../src/cache/resource-snapshot.ts';
import {
  installNextCacheRegistry,
  NEXT_CACHE_STORAGE_SYMBOL_KEY,
  type NextCacheStore,
  type NextStorage,
} from '../src/paas/next-cache-registry.ts';
import {
  observeResourceSnapshot,
  RESOURCE_SNAPSHOT_OBSERVER,
} from '../src/paas/resource-snapshot.ts';

const RESOURCE = 'a'.repeat(64);
const CANONICAL = 'resource:example';
const closed: (() => void)[] = [];

function cacheUnit() {
  let active: NextCacheStore | undefined = { type: 'cache', tags: [] };
  const unit = active;
  installNextCacheRegistry();
  const hook = (globalThis as unknown as Record<symbol, unknown>)[
    Symbol.for(NEXT_CACHE_STORAGE_SYMBOL_KEY)
  ] as (storage: NextStorage<NextCacheStore>) => void;
  hook({ getStore: () => active });
  closed.push(() => {
    active = undefined;
  });
  return unit;
}

describe('original resource snapshot witnesses', () => {
  afterEach(() => {
    for (const close of closed.splice(0)) close();
    Reflect.deleteProperty(globalThis, RESOURCE_SNAPSHOT_OBSERVER);
  });

  it.each([0, 1, Number.MAX_SAFE_INTEGER])(
    'round trips a canonical resource version %s',
    (version) => {
      const tag = resourceSnapshotTag({ resourceId: RESOURCE, version });

      expect(tag).toBe(`${RESOURCE_SNAPSHOT_PREFIX}${RESOURCE}:${String(version)}`);
      expect(resourceSnapshotOf(tag)).toStrictEqual({ resourceId: RESOURCE, version });
      expect(resourceSnapshotOf(CANONICAL)).toBeUndefined();
    },
  );

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'refuses unsafe source version %s',
    (version) => {
      expect(() => resourceSnapshotTag({ resourceId: RESOURCE, version })).toThrow(
        'Invalid resource snapshot witness.',
      );
    },
  );

  it.each(['', 'A'.repeat(64), 'a'.repeat(63), `${RESOURCE}:extra`])(
    'refuses a noncanonical identity %s',
    (resourceId) => {
      expect(() => resourceSnapshotTag({ resourceId, version: 1 })).toThrow(
        'Invalid resource snapshot witness.',
      );
    },
  );

  it.each([
    `${RESOURCE_SNAPSHOT_PREFIX}${RESOURCE}:01`,
    `${RESOURCE_SNAPSHOT_PREFIX}${RESOURCE}:-1`,
    `${RESOURCE_SNAPSHOT_PREFIX}${RESOURCE}:9007199254740992`,
    `${RESOURCE_SNAPSHOT_PREFIX}${RESOURCE}:1:extra`,
    `upwind:resource-snapshot:v2:${RESOURCE}:1`,
    RESOURCE_SNAPSHOT_PREFIX,
  ])('fails closed for reserved malformed tags %s', (tag) => {
    expect(() => resourceSnapshotOf(tag)).toThrow('Invalid resource snapshot witness.');
  });

  it('tags actual Next cache units and synchronously reports both original proofs before values', () => {
    const unit = cacheUnit();
    const observer = vi.fn();
    Reflect.set(globalThis, RESOURCE_SNAPSHOT_OBSERVER, observer);
    const before = resourceSnapshotTag({ resourceId: RESOURCE, version: 2 });
    const after = resourceSnapshotTag({ resourceId: RESOURCE, version: 3 });
    observeResourceSnapshot({ resourceId: RESOURCE, version: 2, tag: CANONICAL });
    observeResourceSnapshot({ resourceId: RESOURCE, version: 3, tag: CANONICAL });

    expect(unit.tags).toContain(before);
    expect(unit.tags).toContain(after);
    expect(observer).toHaveBeenNthCalledWith(1, [CANONICAL, before]);
    expect(observer).toHaveBeenNthCalledWith(2, [CANONICAL, after]);
  });

  it('does not notify a host or tag caches for invalid input', () => {
    const unit = cacheUnit();
    const observer = vi.fn();
    Reflect.set(globalThis, RESOURCE_SNAPSHOT_OBSERVER, observer);

    expect(() => {
      observeResourceSnapshot({ resourceId: RESOURCE, version: -1, tag: CANONICAL });
    }).toThrow('Invalid resource snapshot witness.');
    expect(() => {
      observeResourceSnapshot({ resourceId: RESOURCE, version: 1, tag: '' });
    }).toThrow('Invalid resource snapshot tag.');
    expect(unit.tags).toStrictEqual([]);
    expect(observer).not.toHaveBeenCalled();
  });

  it('requires every v3 capability while retaining v1 and v2 admission', () => {
    const sources = { identities: [RESOURCE], routes: ['/'] };
    const requirement = { version: 3, valueObservers: true, resourceSnapshots: true, ...sources };

    expect(publicationRequirementSchema.safeParse(requirement).success).toBe(true);
    expect(publicationRequirementSchema.safeParse({ version: 3, ...sources }).success).toBe(false);
    expect(
      publicationRequirementSchema.safeParse({ ...requirement, resourceSnapshots: false }).success,
    ).toBe(false);
    expect(
      publicationRequirementSchema.safeParse({ ...requirement, unexpectedCapability: true })
        .success,
    ).toBe(false);
    expect(publicationRequirementSchema.safeParse({ version: 1, ...sources }).success).toBe(true);
    expect(
      publicationRequirementSchema.safeParse({ version: 2, valueObservers: true, ...sources })
        .success,
    ).toBe(true);
  });

  it.each([
    { name: 'missing', tags: [], status: 503 },
    { name: 'malformed', tags: ['upwind:resource-snapshot:v1:broken'], status: 503 },
    {
      name: 'valid',
      tags: [resourceSnapshotTag({ resourceId: RESOURCE, version: 1 })],
      status: 200,
    },
  ])('requires a $name witness on protected v3 cached responses', ({ tags, status }) => {
    const required: PublicationRequirement = {
      version: 3,
      valueObservers: true,
      resourceSnapshots: true,
      identities: [RESOURCE],
      routes: ['/'],
    };
    const response = admitPublication(
      new Response('held'),
      [`upwind:publication:v1:${RESOURCE}:100`, ...tags],
      1,
      required,
    );

    expect(response.status).toBe(status);
  });

  it('preserves independent build and earlier readers without a snapshot requirement', () => {
    const tags = [`upwind:publication:v1:${RESOURCE}:100`];
    const earlier: PublicationRequirement = {
      version: 2,
      valueObservers: true,
      identities: [RESOURCE],
      routes: ['/'],
    };

    expect(admitPublication(new Response('independent'), tags, 1).status).toBe(200);
    expect(admitPublication(new Response('earlier'), tags, 1, earlier).status).toBe(200);
  });

  it('makes an unwitnessed v3 stored output locally expired without rejecting an unbound fresh observation', () => {
    const tags = [`upwind:publication:v1:${RESOURCE}:100`];
    const required: PublicationRequirement = {
      version: 3,
      valueObservers: true,
      resourceSnapshots: true,
      identities: [RESOURCE],
      routes: ['/'],
    };

    expect(publicationDeadline(tags, required)).toBe(0);
    expect(publicationExpired(tags, 1, required)).toBe(true);
    expect(publicationDeadline(tags)).toBe(100);
    expect(publicationExpired(tags, 1)).toBe(false);
    expect(
      publicationDeadline(
        [...tags, resourceSnapshotTag({ resourceId: RESOURCE, version: 1 })],
        required,
      ),
    ).toBe(100);
  });
});
