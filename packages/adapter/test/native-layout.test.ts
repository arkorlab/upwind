import { describe, expect, it } from 'vitest';

import type { RouteCode } from '../src/collect.ts';
import { nativeRouteOwners } from '../src/native-layout.ts';
import type { NativeLoad } from '../src/native-loads.ts';

function route(id: string, kind: RouteCode['kind'] = 'app-route', file = id): RouteCode {
  return {
    id,
    kind,
    module: { id, filePath: file },
    edge: undefined,
    chunks: [],
    wasm: [],
    assets: {},
  };
}

function load(...owners: string[]): NativeLoad[] {
  return [
    { kind: 'direct', importer: '/project/loader.cjs', binary: '/project/addon.node', owners },
  ];
}

describe('native Function ownership', () => {
  it('keeps independent routes separate but preserves one shared built module', () => {
    const routes = [
      route('/native', 'app-route', 'shared.js'),
      route('/also-native', 'app-route', 'shared.js'),
      route('/worker'),
    ];

    expect([...nativeRouteOwners(routes, load('/native'), new Set())]).toEqual([
      '/native',
      '/also-native',
    ]);
  });

  it('keeps the whole Pages Router and its revalidation API together', () => {
    const routes = [
      route('/blog/[slug]', 'pages'),
      route('/', 'pages'),
      route('/api/revalidate', 'pages-api'),
      route('/app'),
    ];

    expect([...nativeRouteOwners(routes, load('/blog/[slug]'), new Set())]).toEqual([
      '/blog/[slug]',
      '/',
      '/api/revalidate',
    ]);
  });

  it.each(['instrumentation', '/_middleware', '/_not-found'])(
    'attributes a native shared %s to every affected Function',
    (shared) => {
      const routes = [route('/native'), route('/worker'), route('/_not-found')];

      expect([
        ...nativeRouteOwners(routes, load(shared), new Set(['/_middleware', '/_not-found'])),
      ]).toEqual(routes.map((entry) => entry.id));
    },
  );

  it('refuses a native load with an unrecognized owner', () => {
    expect(() => nativeRouteOwners([route('/worker')], load('unrecognized'), new Set())).toThrow(
      'unknown Function owner',
    );
  });
});
