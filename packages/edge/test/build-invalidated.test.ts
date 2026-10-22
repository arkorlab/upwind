import type { RouteCache } from '@stayingupwind/core/manifest';
import { describe, expect, it } from 'vitest';

import { buildWasInvalidated } from '../src/cache/build-invalidated.ts';
import { InvalidationMemory } from '../src/memory/invalidations.ts';

const NOW = 1_800_000_000_000;
const SCOPE = 'scope';
const CACHE: RouteCache = {
  entryId: 'entry',
  kind: 'app-page',
  delivery: 'complete',
  buildTags: [
    { kind: 'next-explicit', value: 'test-update-tag' },
    { kind: 'next-implicit', value: '_N_T_/update-tag-test' },
  ],
};

function memoryAt(now: () => number = () => NOW) {
  return { invalidations: new InvalidationMemory(now) };
}

describe('build fallback after a known immediate invalidation', () => {
  it.each(['test-update-tag', '_N_T_/update-tag-test'])(
    'rejects the immutable build when its exact tag %s was invalidated at a positive revision',
    (tag) => {
      const memory = memoryAt();

      expect(buildWasInvalidated(memory, SCOPE, CACHE)).toBe(false);

      memory.invalidations.takeResponse(SCOPE, [tag], 7);

      expect(buildWasInvalidated(memory, SCOPE, CACHE)).toBe(true);
    },
  );

  it('accepts a matching immediate bound learned from the authority without an Action receipt', () => {
    const memory = memoryAt();
    memory.invalidations.takeEach(SCOPE, {
      atOnce: [{ tag: 'test-update-tag', revision: 7 }],
      windowed: [],
    });

    expect(buildWasInvalidated(memory, SCOPE, CACHE)).toBe(true);
  });

  it('keeps unrelated, differently cased and other-scope invalidations off the route', () => {
    const memory = memoryAt();
    memory.invalidations.takeResponse(SCOPE, ['other-tag', 'TEST-UPDATE-TAG'], 7);
    memory.invalidations.takeResponse('other-scope', ['test-update-tag'], 8);

    expect(buildWasInvalidated(memory, SCOPE, CACHE)).toBe(false);
  });

  it.each([undefined, 0])('does not infer an immediate expiration from revision %s', (revision) => {
    const memory = memoryAt();
    memory.invalidations.takeResponse(SCOPE, ['test-update-tag'], revision);

    expect(buildWasInvalidated(memory, SCOPE, CACHE)).toBe(false);
  });

  it('keeps a max-profile invalidation in the background', () => {
    const memory = memoryAt();
    memory.invalidations.takeEach(SCOPE, {
      atOnce: [],
      windowed: [{ tag: 'test-update-tag', revision: 7 }],
    });

    expect(buildWasInvalidated(memory, SCOPE, CACHE)).toBe(false);
  });

  it('does not treat a folded windowed floor as proof of an immediate tag match', () => {
    const memory = memoryAt();
    memory.invalidations.takeEach(SCOPE, {
      atOnce: [],
      windowed: Array.from({ length: 65 }, (_, index) => ({ tag: `tag-${index}`, revision: 7 })),
    });

    expect(memory.invalidations.of(SCOPE)?.every).toBe(7);
    expect(buildWasInvalidated(memory, SCOPE, CACHE)).toBe(false);
  });

  it('does not guess unknown legacy build membership or turn an empty membership into a match', () => {
    const memory = memoryAt();
    memory.invalidations.takeResponse(SCOPE, ['test-update-tag'], 7);
    const legacy: RouteCache = {
      entryId: CACHE.entryId,
      kind: CACHE.kind,
      delivery: CACHE.delivery,
    };

    expect(buildWasInvalidated(memory, SCOPE, undefined)).toBe(false);
    expect(buildWasInvalidated(memory, SCOPE, legacy)).toBe(false);
    expect(buildWasInvalidated(memory, SCOPE, { ...CACHE, buildTags: [] })).toBe(false);
  });

  it.each(['platform-delivery', 'next-implicit'] as const)(
    'rejects a tag kind %s that cannot name this explicit application tag',
    (kind) => {
      const memory = memoryAt();
      memory.invalidations.takeResponse(SCOPE, ['test-update-tag'], 7);

      expect(
        buildWasInvalidated(memory, SCOPE, {
          ...CACHE,
          buildTags: [{ kind, value: 'test-update-tag' }],
        }),
      ).toBe(false);
    },
  );

  it('honors transferred provisional bounds without leaking another deployment', () => {
    const memory = memoryAt();
    memory.invalidations.takeResponse('deployment', ['test-update-tag'], 7);

    expect(buildWasInvalidated(memory, SCOPE, CACHE)).toBe(false);

    memory.invalidations.move('deployment', SCOPE);

    expect(buildWasInvalidated(memory, SCOPE, CACHE)).toBe(true);
    expect(buildWasInvalidated(memory, 'other-scope', CACHE)).toBe(false);
  });

  it('does not renew the invalidation lifetime when the build is read', () => {
    let now = NOW;
    const memory = memoryAt(() => now);
    memory.invalidations.takeResponse(SCOPE, ['test-update-tag'], 7);
    now += 30 * 60_000;

    expect(buildWasInvalidated(memory, SCOPE, CACHE)).toBe(true);

    now = NOW + 60 * 60_000;

    expect(buildWasInvalidated(memory, SCOPE, CACHE)).toBe(false);
  });
});
