import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks';

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
 * One store per request, scoped by `AsyncLocalStorage`: a Function isolate serves many requests at
 * once, and a global set per request would hand one visitor's headers to another's `track()`.
 *
 * The store also keeps the async context each request entered the Function in (`requestEntry`),
 * for what has to run within the request but outside whatever the application has entered by then
 * (`random-safe-context.ts`).
 */

export interface VercelRequestContext {
  readonly headers: Record<string, string>;
  /** The URL the visitor asked for, on the host they used. */
  readonly url: string;
  readonly waitUntil: (promise: Promise<unknown>) => void;
}

/** What `AsyncLocalStorage.snapshot()` hands back: runs a function in the context it was taken in. */
type ContextSnapshot = ReturnType<typeof AsyncLocalStorage.snapshot>;

interface RequestScope {
  readonly context: VercelRequestContext;
  /**
   * The async context the request entered the Function in, before anything of the application
   * ran (`requestEntry`). Kept for every request and asked for by few, so in the cheaper of the
   * two forms to keep: measured on workerd, 0.7 µs to construct against 2.2 µs for a snapshot.
   */
  entry: AsyncResource | undefined;
  /**
   * The same context as a snapshot, made the first time it is asked for. What asks may do so
   * hundreds of times in one render, and a snapshot is the cheaper to enter: 0.26 µs against the
   * resource's 0.55 µs.
   */
  snapshot: ContextSnapshot | undefined;
}

const REQUEST_CONTEXT_SYMBOL = Symbol.for('@vercel/request-context');
const ENTRY_RESOURCE = 'request-entry';
const storage = new AsyncLocalStorage<RequestScope>();

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
  const scope: RequestScope = { context, entry: undefined, snapshot: undefined };
  return storage.run(scope, () => {
    scope.entry = new AsyncResource(ENTRY_RESOURCE);
    return work();
  });
}

/**
 * The async context the request being served entered the Function in: within the request, so
 * workerd lets it be entered for as long as the request lasts, and outside every store the
 * application entered since — Next.js's render and prerender stores among them. `undefined` outside
 * a request.
 */
export function requestEntry(): ContextSnapshot | undefined {
  const scope = storage.getStore();
  if (scope?.entry === undefined) {
    return undefined;
  }
  scope.snapshot ??= scope.entry.runInAsyncScope(() => AsyncLocalStorage.snapshot());
  return scope.snapshot;
}

/** Installed once per isolate: `get()` answers with whichever request is being handled. */
export function installRequestContext(): void {
  if (Reflect.has(globalThis, REQUEST_CONTEXT_SYMBOL)) {
    return;
  }
  Reflect.set(globalThis, REQUEST_CONTEXT_SYMBOL, {
    get: (): VercelRequestContext | undefined => storage.getStore()?.context,
  });
}
