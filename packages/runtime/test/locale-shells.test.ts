import { packPrerenders } from '@stayingupwind/core/bundle';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { findShell, getStore } from '../src/store.ts';

// The time each test had where this suite ran before.
vi.setConfig({ testTimeout: 60_000 });

/**
 * The shells of a page of an application with `i18n`, found for the route of one of its locales.
 *
 * The router resolves a page to its locale's entrypoint (`/en/fallback-true-blog/[slug]`), and the
 * build names each of the page's prerenders after the page itself, with the locale in the
 * pathname. Looked up under the locale's route, no page of such an application was served from
 * its shell by the Worker: each was rendered whole, and a `fallback: true` member the build left
 * out came back rendered where Next.js answers with the fallback.
 */

const bundle = vi.hoisted(() => ({ files: new Map<string, Uint8Array>() }));

vi.mock(import('node:fs'), async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    readFileSync: ((path: string) => {
      const bytes = bundle.files.get(path);
      if (bytes === undefined) {
        throw new Error(`no such file ${path}`);
      }
      return Buffer.from(bytes);
    }) as typeof original.readFileSync,
  };
});

const ROUTE = '/fallback-true-blog/[slug]';
const BODY = { sha256: 'a'.repeat(64), byteLength: 1, contentType: 'text/html' };

/** A page, or — the route's template — the fallback that stands for its class, as Next.js 16.3 says. */
function prerender(pathname: string) {
  const routeType = pathname.endsWith('[slug]') ? 'fallback' : 'page';
  return { id: pathname, pathname, route: ROUTE, routeType, body: BODY };
}

describe('the shells of a page of an application with i18n', () => {
  beforeEach(() => {
    const prerenders = [
      '/en/fallback-true-blog/first',
      '/en/fallback-true-blog/[slug]',
      '/fr/fallback-true-blog/[slug]',
    ].map((pathname) => prerender(pathname));
    const manifest = {
      buildId: 'build',
      config: { basePath: '', i18n: { defaultLocale: 'en', locales: ['en', 'fr'] } },
      routing: { dynamicRoutes: [] },
      entrypoints: [],
      prerenders: packPrerenders(prerenders),
      staticFiles: [],
    };
    bundle.files.set('/bundle/runtime.json', new TextEncoder().encode(JSON.stringify(manifest)));
  });

  it('are found for the route of one of its locales', () => {
    const store = getStore();
    const found = (route: string, pathname: string) => findShell(store, route, pathname)?.id;

    expect(found('/en/fallback-true-blog/[slug]', '/en/fallback-true-blog/first')).toBe(
      '/en/fallback-true-blog/first',
    );
    expect(found('/en/fallback-true-blog/[slug]', '/en/fallback-true-blog/later')).toBe(
      '/en/fallback-true-blog/[slug]',
    );
    expect(found('/fr/fallback-true-blog/[slug]', '/fr/fallback-true-blog/later')).toBe(
      '/fr/fallback-true-blog/[slug]',
    );
    // A segment that names no locale is the route's own.
    expect(found('/de/fallback-true-blog/[slug]', '/de/fallback-true-blog/later')).toBeUndefined();
  });
});
