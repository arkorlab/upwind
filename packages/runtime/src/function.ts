// Evaluated before anything of Next.js: the scheduler its prerenders run on, and the hooks it
// reads off the global at its first request, must be there by then, whichever module asks first.
import './environment.ts';
import './cache/install.ts';
// The WebAssembly the deployment carries, published under the names its code reads it from. Its
// only export is that side effect, and it has to happen before either bundle below is evaluated,
// which is what naming it above them says: modules are evaluated in the order they are named. A
// deployment that reached no WebAssembly has no such module, and this import is then empty.
import 'arkor:wasm';
import app from 'arkor:app';
// A namespace import: a host module that exports no blob reader — one written before there was one
// to export, or one that keeps no build outputs — leaves a Function that runs rather than one that
// fails to link. The adapter's own stub exports it as `undefined` for the same reason.
import * as cacheHost from 'arkor:cache-host';
import edge from 'arkor:edge';

import type { AppModule, EdgeModule } from './app-module.ts';
import { type BundleBlobReader, bundleBlobReader, type BundleBlobsExport } from './bundle-blobs.ts';
import { nowMs } from './cache/clock.ts';
import { configureCacheHandlers } from './cache/handlers.ts';
import { type CacheRuntime, createCacheRuntime } from './cache/runtime.ts';
import { functionEntry } from './function-entry.ts';
import { handleRequest } from './handle.ts';
import { resourceWarmOf } from './resource-warm-props.ts';
import { warmResourceRoute } from './resource-warm.ts';

/**
 * Entry of a deployment's Function. The adapter bundles this file, with `arkor:app` resolved to the
 * generated `app.cjs` that holds the application's own code, and uploads both as one user Function.
 * `arkor:edge` is the same for the entrypoints built for Next.js's edge runtime — a module of
 * the Function when the build produced any, and an empty table when it did not.
 */

/** One runtime and one blob reader per isolate: the bindings never change underneath a deployment. */
const shared: {
  runtime: CacheRuntime | undefined;
  blobs: BundleBlobReader | undefined;
  configured: boolean;
} = {
  runtime: undefined,
  blobs: undefined,
  configured: false,
};

function hostFor(env: unknown): {
  readonly runtime: CacheRuntime | undefined;
  readonly blobs: BundleBlobReader | undefined;
} {
  if (!shared.configured) {
    const bindings =
      typeof env === 'object' && env !== null ? (env as Record<string, unknown>) : undefined;
    shared.runtime = createCacheRuntime({
      env: bindings,
      // What the isolate remembers ages by the clock the request acts at.
      now: nowMs,
    });
    // Asked for independently of the cache: a deployment given no cache still has a bundle, and a
    // build that left blobs out of its Function needs them read whether or not anything is cached.
    // Asserted at the boundary, as `createCacheHost` is: the ambient declaration resolves for
    // `tsc` and not for the type-aware lint's own program.
    // Calling it is the wrapper's job, which is where a host that throws on being asked is kept
    // from failing every request this isolate goes on to serve.
    const create = cacheHost.createBundleBlobReader as BundleBlobsExport;
    shared.blobs = bundleBlobReader(create, { env: bindings });
    shared.configured = true;
    configureCacheHandlers(shared.runtime);
  }
  return shared;
}

const entry = functionEntry({
  configure: hostFor,
  async answer({ request, waitUntil, props, invalidated }, { blobs, runtime }) {
    const warm = resourceWarmOf(props);
    if (warm !== undefined) {
      if (__ARKOR_FUNCTION_KIND__ === 'middleware') {
        return Response.json({ v: 1, kind: 'unsupported' });
      }
      const result = await warmResourceRoute({
        props: warm,
        tables: { app: app as AppModule, edge: edge as EdgeModule },
        request,
        runtime,
        waitUntil,
      });
      return Response.json(result);
    }
    return handleRequest({
      app: app as AppModule,
      edge: edge as EdgeModule,
      request,
      cache: runtime,
      blobs,
      clock: runtime?.clockOf(request),
      waitUntil,
      invalidated,
    });
  },
});

// eslint-disable-next-line import-x/no-default-export
export default entry;
