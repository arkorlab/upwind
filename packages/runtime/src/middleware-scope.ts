import { AsyncLocalStorage } from 'node:async_hooks';

import type { WebHandler } from './app-module.ts';

/**
 * The middleware runs where no page of the edge runtime has put its build manifest.
 *
 * Next.js's adapter tells a middleware from a page rendered on the edge runtime by the build
 * manifest such a page sets on the global object (`isEdgeRendering`, in `server/web/adapter.ts`,
 * which its authors mean to replace with an explicit marker), and treats a request differently for
 * a page: it leaves the client router's headers on it, and says nothing of a rewrite to a data
 * request's router. On Next.js's own server and on Vercel the middleware has a global object to
 * itself. In this Worker it shares one with every page on the edge runtime, and once one of them
 * was loaded the middleware was taken for such a page for the rest of the isolate: it saw `RSC`
 * on a client navigation, and a Pages Router navigation to a path it rewrote to the App Router
 * ended on a 404 (`app-dir/app`: "should strip internal query parameters from requests to
 * middleware", "should support rewrites on client-side navigation from pages to app").
 *
 * So the manifest is held here, and read as unset from inside a middleware's invocation alone.
 */

const BUILD_MANIFEST = '__BUILD_MANIFEST';

const invocations = new AsyncLocalStorage<true>();
const held: { value: unknown; installed: boolean } = { value: undefined, installed: false };

/** Put the accessor in place, once, keeping whatever a page set before it. */
function install(): void {
  if (held.installed) {
    return;
  }
  held.installed = true;
  held.value = Reflect.get(globalThis, BUILD_MANIFEST);
  Object.defineProperty(globalThis, BUILD_MANIFEST, {
    configurable: true,
    get: (): unknown => (invocations.getStore() === true ? undefined : held.value),
    set(value: unknown): void {
      held.value = value;
    },
  });
}

/** `handler`, the middleware's, invoked where a page's build manifest is not set. */
export function asMiddleware(handler: WebHandler): WebHandler {
  install();
  return (request, ctx) => invocations.run(true, () => handler(request, ctx));
}
