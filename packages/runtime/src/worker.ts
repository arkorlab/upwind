// Evaluated before anything of Next.js: the scheduler its prerenders run on, and the hooks it
// reads off the global at its first request, must be there by then, whichever module asks first.
import './environment.ts';
import './cache/install.ts';
// The WebAssembly the deployment carries, published under the names its code reads it from. Its
// only export is that side effect, and it has to happen before either bundle below is evaluated,
// which is what naming it above them says: modules are evaluated in the order they are named. A
// deployment that reached no WebAssembly has no such module, and this import is then empty.
import 'ppr-cdn:wasm';
import { publishWorkerEnv } from '@upwind/core/paas';
import app from 'ppr-cdn:app';
import edge from 'ppr-cdn:edge';

import type { AppModule, EdgeModule } from './app-module.ts';
import { nowMs } from './cache/clock.ts';
import { configureCacheHandlers } from './cache/handlers.ts';
import { type CacheRuntime, createCacheRuntime } from './cache/runtime.ts';
import { handleRequest } from './handle.ts';
import {
  installRequestContext,
  plainHeaders,
  publicUrl,
  withRequestContext,
} from './request-context.ts';

/**
 * Entry of a deployment's Worker. The adapter bundles this file, with `ppr-cdn:app` resolved to the
 * generated `app.cjs` that holds the application's own code, and uploads both as one user Worker.
 * `ppr-cdn:edge` is the same for the entrypoints built for Next.js's edge runtime — a module of
 * the Worker when the build produced any, and an empty table when it did not.
 */
const HTTP_INTERNAL_ERROR = 500;

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

/** One runtime per isolate: the bindings never change underneath a deployment. */
const shared: { runtime: CacheRuntime | undefined; configured: boolean } = {
  runtime: undefined,
  configured: false,
};

function cacheRuntimeFor(env: unknown): CacheRuntime | undefined {
  if (!shared.configured) {
    shared.runtime = createCacheRuntime({
      env: typeof env === 'object' && env !== null ? (env as Record<string, unknown>) : undefined,
      // What the isolate remembers ages by the clock the request acts at.
      now: nowMs,
    });
    shared.configured = true;
    configureCacheHandlers(shared.runtime);
  }
  return shared.runtime;
}

const worker = {
  async fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> {
    installRequestContext();
    const waitUntil = (promise: Promise<unknown>): void => {
      ctx.waitUntil(promise);
    };
    try {
      // Before anything of the application runs: a service binding is an object, so it reaches
      // neither `process.env` nor any other place Next.js server code can look. The dashboard's
      // control-plane and database clients read theirs back out of here.
      publishWorkerEnv(env);
      const runtime = cacheRuntimeFor(env);
      return await withRequestContext(
        { headers: plainHeaders(request.headers), url: publicUrl(request), waitUntil },
        () => {
          return handleRequest({
            app: app as AppModule,
            edge: edge as EdgeModule,
            request,
            cache: runtime,
            // The clock a test configuration hands the request; the host decides whether one may.
            clock: runtime?.clockOf(request),
            waitUntil,
          });
        },
      );
    } catch (error) {
      // The Worker's own log: nothing else sees a request that failed before Next.js answered.
      // eslint-disable-next-line no-console
      console.error('next-runtime: request failed', error);
      return new Response('Internal Server Error', { status: HTTP_INTERNAL_ERROR });
    }
  },
};

// The Worker entry: what workerd looks for, and the one default export the runtime has.
// eslint-disable-next-line import-x/no-default-export
export default worker;
