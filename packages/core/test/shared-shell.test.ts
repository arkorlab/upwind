import { describe, expect, it } from 'vitest';

import { sharedShellPathname } from '../src/bundle/index.ts';
import type { Prerender } from '../src/bundle/schema.ts';
import { deriveEntry, MAX_TAG_LENGTH, sharedShellTagOf } from '../src/cache/index.ts';

const shell: Prerender = {
  id: 'shared',
  route: '/prefix/[one]/[two]',
  pathname: '/prefix/b/[two]',
  parentOutputId: 'page',
  groupId: 1,
  routeType: 'shell',
  response: 'initial',
  compute: 'resuming',
  renderingMode: 'PARTIALLY_STATIC',
  body: { sha256: 'a'.repeat(64), byteLength: 10, contentType: 'text/html' },
  postponed: { sha256: 'b'.repeat(64), byteLength: 5, contentType: 'application/json' },
};

describe('a shared resumable terminal shell', () => {
  it('names the class without resolving the parameter resumed for each visitor', () => {
    expect(sharedShellPathname(shell)).toBe('/prefix/b/[two]');
    expect(sharedShellPathname({ ...shell, allowQuery: ['nxtPone'] })).toBe('/prefix/b/[two]');
  });

  it.each<Partial<Prerender>>([
    { body: undefined },
    { postponed: undefined },
    { renderingMode: 'STATIC' },
    { routeType: 'route' },
    { response: 'complete' },
    { compute: 'blocking' },
    { partialFallback: true },
    { allowQuery: ['nxtPtwo'] },
    { allowQuery: ['search'] },
    { pathname: '/prefix/b/value' },
    { pathname: '/prefix/b/[literal]', routeType: undefined },
    { routeType: 'page', parentFallbackMode: false },
  ])('keeps incompatible or concrete output on its existing path: %j', (overrides) => {
    expect(sharedShellPathname({ ...shell, ...overrides })).toBeUndefined();
  });

  it('keeps the invalidation tag bounded and isolated by deployment, source route and class', async () => {
    const descriptor = { kind: 'app-page' as const, route: shell.route, pathname: shell.pathname };
    const entries = await Promise.all([
      deriveEntry('first', descriptor),
      deriveEntry('second', descriptor),
      deriveEntry('first', { ...descriptor, route: '/prefix/[other]/[two]' }),
      deriveEntry('first', { ...descriptor, pathname: '/prefix/c/[two]' }),
      deriveEntry('first', { ...descriptor, pathname: `/prefix/${'b'.repeat(500)}/[two]` }),
    ]);
    const tags = entries.map(({ entryId }) => sharedShellTagOf(entryId));

    expect(new Set(tags).size).toBe(entries.length);
    expect(tags.every((tag) => tag.length <= MAX_TAG_LENGTH)).toBe(true);
    expect(tags.every((tag) => tag.startsWith('_N_T_upwind:shared-shell:ent_'))).toBe(true);
  });
});
