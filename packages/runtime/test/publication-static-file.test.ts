import type { StaticFile } from '@stayingupwind/core/bundle';
import type { PublicationRequirement } from '@stayingupwind/core/cache';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CacheRuntime } from '../src/cache/runtime.ts';
import { handleRequest } from '../src/handle.ts';
import { getStore, type Store } from '../src/store.ts';

vi.mock(import('../src/store.ts'), async (original) => {
  const module = await original();
  return { ...module, getStore: vi.fn() };
});
vi.mock(import('../src/node-bridge.ts'), () => {
  return {
    invokeNodeHandler: () => {
      throw new Error('A shipped static file must not render.');
    },
  };
});

const ID = 'a'.repeat(64);
const BODY = 'independent shipped file';

function fixture(route: string, version: 1 | 3, independent: boolean, immutable: boolean) {
  const identities = {
    identities: [ID],
    routes: [route],
    ...(independent && { independentBuild: [route] }),
  };
  const publication: PublicationRequirement =
    version === 3
      ? { ...identities, version: 3, valueObservers: true, resourceSnapshots: true }
      : { ...identities, version: 1 };
  const file: StaticFile = {
    pathname: route,
    immutable,
    blob: { sha256: 'b'.repeat(64), byteLength: BODY.length, contentType: 'text/plain' },
  };
  const stored = {
    manifest: {
      buildId: 'build',
      config: { basePath: '' },
      routing: {
        beforeMiddleware: [],
        middlewareMatchers: [],
        beforeFiles: [],
        afterFiles: [],
        dynamicRoutes: [],
        onMatch: [],
        fallback: [],
        shouldNormalizeNextData: false,
      },
      entrypoints: [],
    },
    pathnames: [route],
    slashSpellings: new Map(),
    dynamicRoutes: [],
    staticFiles: new Map([[route, file]]),
    shellsByRoute: new Map(),
    prerendersById: new Map(),
    prerendersByPathname: new Map(),
    tryReadBlob: vi.fn<Store['tryReadBlob']>(),
  } as unknown as Store;
  const read = vi.fn(() => Promise.resolve(new TextEncoder().encode(BODY)));
  vi.mocked(getStore).mockReturnValue(stored);
  const cache = { host: { publication } } as unknown as CacheRuntime;
  return {
    read,
    render: (method: string) => {
      return handleRequest({
        request: new Request(`https://static.test${route}`, { method }),
        app: { entries: {} },
        edge: { entries: {} },
        cache,
        blobs: read,
        waitUntil: vi.fn(),
      });
    },
  };
}

describe('publication admission of directly selected shipped files', () => {
  beforeEach(() => vi.stubGlobal('__ARKOR_FUNCTION_KIND__', 'app'));

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it.each([1, 3] as const)(
    'retains direct custom-404 independent proof (version=%s)',
    async (version) => {
      const test = fixture('/404', version, true, false);

      const response = await test.render('GET');

      expect(response.status).toBe(404);
      await expect(response.text()).resolves.toBe(BODY);
      expect(response.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
      expect(test.read).toHaveBeenCalledTimes(1);
    },
  );

  it('retains the independent immutable-file policy for the actual selected bytes', async () => {
    const test = fixture('/shipped.txt', 1, true, true);

    const response = await test.render('GET');

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(BODY);
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(test.read).toHaveBeenCalledTimes(1);
  });

  it('retains independent HEAD proof without fetching a blob', async () => {
    const test = fixture('/404', 1, true, false);

    const response = await test.render('HEAD');

    expect(response.status).toBe(404);
    expect(response.body).toBeNull();
    expect(test.read).not.toHaveBeenCalled();
  });

  it('refuses an ungranted protected static file without independent proof', async () => {
    const test = fixture('/shipped.txt', 1, false, true);

    const response = await test.render('GET');

    expect(response.status).toBe(503);
    await expect(response.text()).resolves.toBe('Publication unavailable');
    expect(test.read).not.toHaveBeenCalled();
  });
});
