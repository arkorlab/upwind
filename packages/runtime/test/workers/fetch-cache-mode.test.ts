import { describe, expect, it } from 'vitest';

import {
  requestWithSupportedCacheModes,
  withSupportedCacheMode,
  withSupportedCacheModes,
} from '../../src/fetch-cache-mode.ts';

/**
 * A `fetch` with a cache mode workerd does not take, in workerd.
 *
 * Next.js decides what its data cache does with a `fetch` by its `cache` mode and then hands the
 * same request to the `fetch` underneath it. `force-cache` is what an App Router page asks for to
 * have a response kept, and `default` what it asks for to leave the decision to Next.js; on Node.js
 * both are only read. workerd throws on both, so a page that asked either failed to render.
 */

const URL = 'https://origin.test/data';

describe("workerd's own fetch", () => {
  it.each(['force-cache', 'default', 'reload', 'only-if-cached'] as const)(
    'refuses the %s mode, which is why the modes are taken off',
    (cache) => {
      expect(() => new Request(URL, { cache })).toThrow(`Unsupported cache mode: ${cache}`);
    },
  );

  it.each(['no-store', 'no-cache'] as const)('takes the %s mode', (cache) => {
    expect(() => new Request(URL, { cache })).not.toThrow();
  });
});

/** A `fetch` that answers every request, and keeps the `init` each came with. */
function recorded(): { fetch: typeof fetch; seen: (RequestInit | undefined)[] } {
  const seen: (RequestInit | undefined)[] = [];
  const fetchSpy: typeof fetch = (_input, init) => {
    seen.push(init);
    return Promise.resolve(new Response('ok'));
  };
  return { fetch: fetchSpy, seen };
}

describe('the fetch Next.js is given to wrap', () => {
  it('takes off a mode workerd would throw on, and keeps the rest of the request', async () => {
    const { fetch: underneath, seen } = recorded();
    const wrapped = withSupportedCacheModes(underneath);

    await wrapped(URL, { cache: 'force-cache', method: 'POST', headers: { a: '1' } });

    expect(seen).toStrictEqual([{ method: 'POST', headers: { a: '1' } }]);
  });

  it('keeps the two modes workerd knows, and a request that names none', () => {
    expect(withSupportedCacheMode({ cache: 'no-store' })).toStrictEqual({ cache: 'no-store' });
    expect(withSupportedCacheMode({ cache: 'no-cache' })).toStrictEqual({ cache: 'no-cache' });

    const plain = { method: 'GET' };

    expect(withSupportedCacheMode(plain)).toBe(plain);
    expect(withSupportedCacheMode(undefined)).toBeUndefined();
  });

  it('keeps what Next.js adds for itself beside the mode', async () => {
    const { fetch: underneath, seen } = recorded();
    const init = { cache: 'default', next: { revalidate: 60 } } as RequestInit;

    await withSupportedCacheModes(underneath)(URL, init);

    expect(seen).toStrictEqual([{ next: { revalidate: 60 } }]);
    expect(init.cache, "the caller's own request is left as it was").toBe('default');
  });
});

/**
 * Next.js refuses the mode before any `fetch` too: the fetch it deduplicates a render with keys
 * each request by constructing `new Request(resource, init)`, and a page may construct one of its
 * own. So the `Request` constructor takes the mode off as well, and what it builds is workerd's.
 */
describe('the Request Next.js and the application construct', () => {
  const CompatibleRequest = requestWithSupportedCacheModes(Request);

  it.each(['force-cache', 'default'] as const)(
    "builds the request a %s mode was asked for with, as workerd's own",
    (cache) => {
      const request = new CompatibleRequest(URL, { cache, method: 'POST', headers: { a: '1' } });

      expect(request).toBeInstanceOf(Request);
      expect(request).toBeInstanceOf(CompatibleRequest);
      expect([request.url, request.method, request.headers.get('a')]).toStrictEqual([
        URL,
        'POST',
        '1',
      ]);
    },
  );

  it('rebuilds a request from another with a mode, as `patch-fetch` does', () => {
    const request = new CompatibleRequest(new Request(URL, { method: 'PUT' }), {
      cache: 'force-cache',
    });

    expect([request.url, request.method]).toStrictEqual([URL, 'PUT']);
  });

  /**
   * Next.js reads the mode off a request it is handed as well as off `init`, and decides by it what
   * its data cache does; an application's request keeps the mode it was built with for that, while
   * what workerd holds, and copies, never had it.
   */
  it('keeps the mode it was asked for readable, and workerd never sees it', () => {
    const request = new CompatibleRequest(URL, { cache: 'force-cache' });
    const plain = new CompatibleRequest(URL, { cache: 'no-store' });

    expect(request.cache).toBe('force-cache');
    expect(plain.cache).toBe('no-store');
    expect(() => new Request(request)).not.toThrow();
  });

  it('is still what a subclass extends', () => {
    class Tagged extends CompatibleRequest {}

    const request = new Tagged(URL, { cache: 'force-cache' });

    expect(request).toBeInstanceOf(Tagged);
    expect(request).toBeInstanceOf(Request);
  });
});
