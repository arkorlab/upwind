import { afterEach, describe, expect, it, vi } from 'vitest';

import { Gateway } from '../../cache/src/function/gateway.ts';
import { createCacheRuntime } from '../src/cache/runtime.ts';

/**
 * How a deployment's Worker reaches the two cache gateways: over the service binding the
 * deployment run attached, or out to the URL it was given instead — one or the other per
 * gateway, never both.
 *
 * `fetchImpl` is left unset throughout. It is the seam the rest of the suite injects through,
 * and it stands in for whichever transport was chosen; a test of the choice itself has to let
 * the choice be made.
 */

const TOKEN = 'test-scope-token';
const SCOPE = 'scope-test';

/** A service binding, as `env` holds one: an object with a `fetch`, and the calls it took. */
function fakeService(): { readonly fetch: (request: Request) => Promise<Response>; calls: URL[] } {
  const calls: URL[] = [];
  return {
    calls,
    fetch: (request: Request) => {
      calls.push(new URL(request.url));
      // 404 is the one answer `readRecord` reads without a schema: "no record for this entry".
      return Promise.resolve(new Response(null, { status: 404 }));
    },
  };
}

function runtimeFor(env: Record<string, unknown>) {
  const runtime = createCacheRuntime({
    env: { ARKOR_CACHE_TOKEN: TOKEN, NEXT_DEPLOYMENT_ID: SCOPE, ...env },
    now: () => Date.now(),
  });
  if (runtime === undefined) {
    throw new Error('the runtime was not configured');
  }
  return runtime;
}

describe('cache gateway transport', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('sends a read to the read binding and a write to the authority binding', async () => {
    const write = fakeService();
    const read = fakeService();
    const runtime = runtimeFor({ ARKOR_CACHE: write, ARKOR_CACHE_READ: read });

    await expect(runtime.host.readRecord('entry-1')).resolves.toBeUndefined();
    // Any call that is not a read will do; what is under test is which binding carried it. The
    // 404 has no body for the schema to read, so the call itself fails — after it was sent.
    await expect(runtime.host.heartbeat('attempt-1', 1)).rejects.toThrow(Error);

    // The read went to the unplaced gateway and the write to the placed one: two Workers, two
    // bindings, and neither call saw the other's.
    expect(read.calls.map((url) => url.origin)).toStrictEqual([
      'https://cache-read.upwind.internal',
    ]);
    expect(write.calls.map((url) => url.origin)).toStrictEqual(['https://cache.upwind.internal']);
    expect(read.calls[0]?.pathname).toContain(`/scopes/${SCOPE}/entries/entry-1/record`);
  });

  it('reads through the authority binding when there is no read gateway at all', async () => {
    const write = fakeService();
    const runtime = runtimeFor({ ARKOR_CACHE: write });

    await expect(runtime.host.readRecord('entry-1')).resolves.toBeUndefined();

    expect(write.calls.map((url) => url.origin)).toStrictEqual(['https://cache.upwind.internal']);
  });

  /**
   * The two gateways are configured apart, so every pairing of the two transports has to work —
   * and this is the one that is easy to get wrong. A read that fell back to the authority's
   * binding would arrive at the authority carrying the read gateway's URL, which every route
   * there matches on the path of: answered correctly, from wherever the authority runs, and far too late for the
   * 200 ms deadline a document read holds.
   */
  it('does not send a read over the authority binding when the read gateway is a URL', async () => {
    const write = fakeService();
    const outward: URL[] = [];
    // No `fetchImpl` here, deliberately: it stands in for the way out, and a bug that sent this
    // read over the authority's binding instead of out would be hidden by one. The global is
    // stubbed and the modules re-imported instead, because `native.ts` takes its copy of `fetch`
    // when it is evaluated — before Next.js can replace it, which is the whole point of it.
    vi.stubGlobal('fetch', (input: Request | string) => {
      outward.push(new URL(input instanceof Request ? input.url : input));
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    vi.resetModules();
    const fresh = await import('../src/cache/runtime.ts');

    const runtime = fresh.createCacheRuntime({
      env: {
        ARKOR_CACHE_TOKEN: TOKEN,
        NEXT_DEPLOYMENT_ID: SCOPE,
        ARKOR_CACHE: write,
        ARKOR_CACHE_READ_GATEWAY_URL: 'https://cache-read.example.workers.dev',
      },
      now: () => Date.now(),
    });

    await expect(runtime?.host.readRecord('entry-1')).resolves.toBeUndefined();

    expect(write.calls).toStrictEqual([]);
    expect(outward.map((url) => url.origin)).toStrictEqual([
      'https://cache-read.example.workers.dev',
    ]);
  });

  /**
   * A host that composes the client itself names each gateway's transport. One that names the read
   * gateway's URL and leaves its transport out would have every read carried to the authority over
   * the authority's own, and judged by the read gateway's deadline: refused, rather than guessed.
   */
  it('refuses a read gateway URL given without a transport of its own', () => {
    const write = fakeService();

    expect(() => {
      return new Gateway({
        naming: { copyCache: 'copies', copyKeyOrigin: 'https://copies.test' },
        gatewayUrl: 'https://cache.upwind.internal',
        readGatewayUrl: 'https://cache-read.example.test',
        scopeId: SCOPE,
        token: TOKEN,
        fetchImpl: (request) => write.fetch(request),
      });
    }).toThrow(/transport of its own/u);
  });

  it('prefers the binding over a URL, so a private gateway is never reached for by name', async () => {
    const write = fakeService();
    const runtime = runtimeFor({
      ARKOR_CACHE: write,
      // A deployment run sends one or the other; this is what a stale pairing would look like.
      ARKOR_CACHE_GATEWAY_URL: 'https://cache.example.workers.dev',
    });

    await expect(runtime.host.readRecord('entry-1')).resolves.toBeUndefined();

    expect(write.calls.map((url) => url.origin)).toStrictEqual(['https://cache.upwind.internal']);
  });

  it('builds requests on the URL when there is no binding', async () => {
    const calls: URL[] = [];
    const runtime = createCacheRuntime({
      env: {
        ARKOR_CACHE_TOKEN: TOKEN,
        NEXT_DEPLOYMENT_ID: SCOPE,
        ARKOR_CACHE_GATEWAY_URL: 'https://regional.test',
        ARKOR_CACHE_READ_GATEWAY_URL: 'https://local.test',
      },
      now: () => Date.now(),
      fetchImpl: (request) => {
        calls.push(new URL(request.url));
        return Promise.resolve(new Response(null, { status: 404 }));
      },
    });

    await runtime?.host.readRecord('entry-1');

    await expect(runtime?.host.heartbeat('attempt-1', 1)).rejects.toThrow(Error);

    expect(calls.map((url) => url.origin)).toStrictEqual([
      'https://local.test',
      'https://regional.test',
    ]);
  });

  it('is not configured at all when it is given neither a binding nor a URL', () => {
    expect(
      createCacheRuntime({
        env: { ARKOR_CACHE_TOKEN: TOKEN, NEXT_DEPLOYMENT_ID: SCOPE },
        now: () => Date.now(),
      }),
    ).toBeUndefined();
  });
});
