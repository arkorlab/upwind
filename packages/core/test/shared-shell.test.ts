import { describe, expect, it } from 'vitest';

import { sharedShellPathname, terminalShellPathname } from '../src/bundle/index.ts';
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

/** A client page's shell that reads `id` in the browser, as Next.js 16.4.2 builds it. */
const terminal: Prerender = {
  id: 'terminal',
  route: '/page-params/[id]',
  pathname: '/page-params/[id]',
  parentOutputId: 'page',
  groupId: 1,
  routeType: 'shell',
  response: 'initial',
  compute: 'static',
  renderingMode: 'PARTIALLY_STATIC',
  allowQuery: ['nxtPid'],
  body: { sha256: 'a'.repeat(64), byteLength: 10, contentType: 'text/html' },
};

describe('a terminal shell keyed by the parameters it leaves open', () => {
  it.each<Partial<Prerender>>([
    {},
    { allowQuery: ['id'] },
    { response: 'complete' },
    {
      route: '/prefix/[one]/[two]',
      pathname: '/prefix/b/[two]',
      allowQuery: ['nxtPone', 'nxtPtwo'],
    },
    { route: '/docs/[...slug]', pathname: '/docs/[...slug]', allowQuery: ['nxtPslug'] },
  ])('names the one entry every member is answered from: %j', (overrides) => {
    const prerender = { ...terminal, ...overrides };

    expect(terminalShellPathname(prerender)).toBe(prerender.pathname);
  });

  it.each<Partial<Prerender>>([
    { routeType: 'fallback' },
    { routeType: 'page' },
    { body: undefined },
    { renderingMode: 'STATIC' },
    { allowQuery: undefined },
    { allowQuery: [] },
    { allowQuery: ['nxtPid', 'preview'] },
    { pathname: '/page-params/1' },
  ])('names none for anything else: %j', (overrides) => {
    expect(terminalShellPathname({ ...terminal, ...overrides })).toBeUndefined();
  });
});
