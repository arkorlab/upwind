import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The request context Vercel's runtime exposes to libraries through
 * `globalThis[Symbol.for('@vercel/request-context')]`, provided here so those libraries find it.
 *
 * `track()` from `@vercel/analytics/server` is the one this exists for: called without a request
 * or headers of its own — as it is in an application that ran on Vercel — it reads the visitor's
 * headers and the page URL from this context and posts the event through `waitUntil`, so the
 * response is not held for it. Without the context it logs "No session context found" and drops
 * the event; an application that never touched its code should not have to.
 *
 * One store per request, scoped by `AsyncLocalStorage`: a Worker isolate serves many requests at
 * once, and a global set per request would hand one visitor's headers to another's `track()`.
 */

export interface VercelRequestContext {
  readonly headers: Record<string, string>;
  /** The URL the visitor asked for, on the host they used. */
  readonly url: string;
  readonly waitUntil: (promise: Promise<unknown>) => void;
}

const REQUEST_CONTEXT_SYMBOL = Symbol.for('@vercel/request-context');
const storage = new AsyncLocalStorage<VercelRequestContext>();

/** The public host the request arrived on: the edge forwards it, the dispatched URL does not carry it. */
export function publicUrl(request: Request): string {
  const forwardedHost = request.headers.get('x-forwarded-host');
  if (forwardedHost === null) {
    return request.url;
  }
  const url = new URL(request.url);
  url.host = forwardedHost;
  url.protocol = request.headers.get('x-forwarded-proto') === 'http' ? 'http:' : 'https:';
  return url.href;
}

/** Plain headers as Node sees them, several `cookie` lines joined as one. */
export function plainHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of headers) {
    out[name] = name === 'cookie' && out[name] !== undefined ? `${out[name]}; ${value}` : value;
  }
  return out;
}

/** Run `work` with this request as the context libraries will find. */
export function withRequestContext<T>(
  context: VercelRequestContext,
  work: () => Promise<T>,
): Promise<T> {
  return storage.run(context, work);
}

/** Installed once per isolate: `get()` answers with whichever request is being handled. */
export function installRequestContext(): void {
  if (Reflect.has(globalThis, REQUEST_CONTEXT_SYMBOL)) {
    return;
  }
  Reflect.set(globalThis, REQUEST_CONTEXT_SYMBOL, {
    get: (): VercelRequestContext | undefined => storage.getStore(),
  });
}
