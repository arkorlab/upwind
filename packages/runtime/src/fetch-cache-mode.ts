/**
 * The `cache` modes a Function's `fetch` takes, and what becomes of the others.
 *
 * workerd takes `no-store` and `no-cache` and nothing else: any other mode throws `TypeError:
 * Unsupported cache mode: …` (Cloudflare's Functions documentation, runtime APIs, Fetch). Next.js
 * reads `cache` to decide what its data cache does with a `fetch` — `force-cache`, `default` —
 * and then hands the same `init` to the `fetch` underneath it, which here is workerd's. It drops
 * the field itself on one path of the edge runtime ("Cloudflare Workers will throw an error",
 * `server/lib/patch-fetch.ts`), and not on the others. Outside a request's work store and in draft
 * mode it returns early with `init` untouched, and most paths to the origin copy `init` as it came,
 * so a `fetch` with `force-cache` reached workerd with the mode still on it and the render failed.
 *
 * The mode is refused before any `fetch` too. Under its own patched `fetch` Next.js puts one that
 * deduplicates a render's requests (`createDedupeFetch`, `server/lib/dedupe-fetch.ts`), and that
 * keys what it dedupes by building `new Request(resource, init)`, which workerd refuses on the same
 * grounds; so does a page that builds a `Request` with a mode of its own.
 *
 * So the `fetch` Next.js wraps, and the `Request` it and the application construct, take a mode
 * workerd does not know off the request rather than hand it on. Nothing is lost by it: the mode has
 * done its work by then, in Next.js's data cache above, and Node.js's own `fetch` keeps no HTTP
 * cache for any mode to ask of. The two modes workerd knows go through as they are, and what is
 * constructed is workerd's own `Request`, to `instanceof` and to a subclass alike.
 */

const SUPPORTED_CACHE_MODES: ReadonlySet<string> = new Set(['no-cache', 'no-store']);
/** Set on the `fetch` installed here, so an isolate that evaluates this twice wraps it once. */
const WRAPPED = Symbol.for('arkor.fetch-cache-mode');

type Fetch = typeof globalThis.fetch;
type RequestConstructor = typeof globalThis.Request;

/** `init` as workerd will take it: without a `cache` mode it does not support. */
export function withSupportedCacheMode(init: RequestInit | undefined): RequestInit | undefined {
  const mode = init?.cache;
  if (init === undefined || mode === undefined || SUPPORTED_CACHE_MODES.has(mode)) {
    return init;
  }
  const supported: RequestInit = { ...init };
  Reflect.deleteProperty(supported, 'cache');
  return supported;
}

/** `fetch`, taking a mode it does not support off every request before it is made. */
export function withSupportedCacheModes(fetch: Fetch): Fetch {
  const wrapped: Fetch = (input, init) => fetch(input, withSupportedCacheMode(init));
  Reflect.set(wrapped, WRAPPED, true);
  return wrapped;
}

/**
 * `Request`, constructing workerd's own without a mode it does not support. The mode asked for
 * stays readable on it, as Node.js's `Request` keeps it: Next.js decides what its data cache does
 * with a request it is handed by the `cache` it reads off that request as well as off `init`
 * (`patch-fetch.ts`), and an application's `new Request(url, { cache: 'force-cache' })` would
 * otherwise reach it as asking for nothing. workerd reads its own state, which never held it.
 */
export function requestWithSupportedCacheModes(Request: RequestConstructor): RequestConstructor {
  return new Proxy(Request, {
    construct(native, args: unknown[], constructedAs): Request {
      const [input, init] = args as [RequestInfo | URL, RequestInit | undefined];
      const supported = withSupportedCacheMode(init);
      const request = Reflect.construct(native, [input, supported], constructedAs) as Request;
      if (supported !== init && init?.cache !== undefined) {
        Reflect.defineProperty(request, 'cache', { value: init.cache, configurable: true });
      }
      return request;
    },
  });
}

/**
 * Put in place before any of Next.js is evaluated (`environment.ts`), so it wraps these. The two
 * go in together, so the mark on `fetch` says whether both are there.
 */
export function installFetchCacheModes(): void {
  if (Reflect.get(globalThis.fetch, WRAPPED) === true) {
    return;
  }
  Reflect.set(globalThis, 'Request', requestWithSupportedCacheModes(Request));
  Reflect.set(globalThis, 'fetch', withSupportedCacheModes(globalThis.fetch));
}
