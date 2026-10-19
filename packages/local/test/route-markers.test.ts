import {
  buildProjectManifest,
  type ProjectManifest,
  type RouteEntry,
} from '@stayingupwind/core/manifest';
import { routeDebugValue } from '@stayingupwind/core/request';
import { describe, expect, it } from 'vitest';

import { EDGE_HEADER } from '../src/answers.ts';
import { landedRouteOf, namedRoutes, servedAs, servedOtherThan } from '../src/landings.ts';
import type { Reading } from '../src/reading.ts';
import { servedGeneration } from '../src/recorded.ts';

function routeAt(pathname: string): RouteEntry {
  return {
    pathname,
    status: 200,
    shell: {
      sha256: 'a'.repeat(64),
      byteLength: 0,
      contentType: 'text/html',
      encoding: 'identity',
    },
    headers: {},
    prerenderId: 'route',
  };
}

function holding(...routes: RouteEntry[]): ProjectManifest {
  return buildProjectManifest({
    projectId: 'site',
    runId: 'run',
    generatedAt: '2026-10-19T00:00:00.000Z',
    originHost: 'site.example',
    deployment: {
      assetSetHash: 'b'.repeat(64),
      observedAt: '2026-10-19T00:00:00.000Z',
    },
    app: { deploymentId: 'dpl_site', scriptName: 'app' },
    routes,
    staticFiles: {},
  });
}

function answering(account: string): Reading {
  return {
    status: 200,
    headers: { [EDGE_HEADER]: account },
    length: 0,
    sha256: 'a'.repeat(64),
    head: Buffer.alloc(0),
    tail: Buffer.alloc(0),
    marked: false,
    truncated: false,
  };
}

function recorded(marker: string): string {
  return `shell;strategy=edge;cont=none;mw=miss;route=${marker};cache=fresh;seq=2;member=1`;
}

describe('the route spelling the edge writes in its diagnostic account', () => {
  it.each([
    { pathname: '/docs/plain', marker: '/docs/plain' },
    { pathname: '/docs/a%3Bb', marker: '/docs/a%3Bb' },
    { pathname: '/docs/a;b', marker: '~%2Fdocs%2Fa%3Bb' },
    { pathname: '/docs/a b', marker: '~%2Fdocs%2Fa%20b' },
    { pathname: '/docs/日本', marker: '~%2Fdocs%2F%E6%97%A5%E6%9C%AC' },
    { pathname: String.raw`/docs/a\b;c`, marker: '~%2Fdocs%2Fa%5C%5Cb%3Bc' },
    { pathname: '/docs/\u{D800}', marker: '~%2Fdocs%2F%5Cud800' },
    {
      pathname: '/docs/a;cache=fresh;seq=9',
      marker: '~%2Fdocs%2Fa%3Bcache%3Dfresh%3Bseq%3D9',
    },
  ])('recognizes the route and generation for $pathname', (example) => {
    const route = routeAt(example.pathname);
    const manifest = holding(route);
    const account = recorded(example.marker);

    expect(routeDebugValue(example.pathname)).toBe(example.marker);
    expect(namedRoutes(account)).toContain(example.pathname);
    expect(landedRouteOf(manifest, account)).toBe(example.pathname);
    expect(servedOtherThan(manifest, account, example.pathname)).toBeUndefined();
    expect(servedAs(manifest, account, route)).toStrictEqual(route);
    expect(servedGeneration(answering(account), route)).toStrictEqual({
      seq: 2,
      member: true,
      whole: true,
    });
  });

  it('keeps an escaped semicolon distinct from a literal percent escape in a route name', () => {
    const semicolon = routeAt('/docs/a;b');
    const percent = routeAt('/docs/a%3Bb');
    const manifest = holding(semicolon, percent);
    const account = recorded('~%2Fdocs%2Fa%3Bb');

    expect(servedAs(manifest, account, percent)).toStrictEqual(semicolon);
    expect(servedOtherThan(manifest, account, percent.pathname)).toBe(semicolon.pathname);
    expect(servedGeneration(answering(account), percent)).toBeUndefined();
  });

  it.each(['~%2Fdocs%2Fplain', '~%ZZ', '~%22'])(
    'does not mistake a malformed or noncanonical account for a route: %s',
    (marker) => {
      const route = routeAt('/docs/plain');
      const manifest = holding(route);
      const account = recorded(marker);

      expect(landedRouteOf(manifest, account)).toBeUndefined();
      expect(servedAs(manifest, account, route)).toBeUndefined();
      expect(servedGeneration(answering(account), route)).toBeUndefined();
    },
  );
});
