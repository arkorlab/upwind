// Evaluated before anything of Next.js: the scheduler its prerenders run on, and the hooks it
// reads off the global at its first request, must be there by then, whichever module asks first.
import './environment.ts';
import './cache/install.ts';
// The WebAssembly the deployment carries, published under the names its code reads it from. Its
// only export is that side effect, and it has to happen before either bundle below is evaluated,
// which is what naming it above them says: modules are evaluated in the order they are named. A
// deployment that reached no WebAssembly has no such module, and this import is then empty.
import 'arkor:wasm';
import { publishFunctionEnv } from '@stayingupwind/core/paas';
import app from 'arkor:app';
// A namespace import: a host module that exports no blob reader — one written before there was one
// to export, or one that keeps no build outputs — leaves a Function that runs rather than one that
// fails to link. The adapter's own stub exports it as `undefined` for the same reason.
import * as cacheHost from 'arkor:cache-host';
import edge from 'arkor:edge';

import type { AppModule, EdgeModule } from './app-module.ts';
import { type BundleBlobReader, bundleBlobReader, type BundleBlobsExport } from './bundle-blobs.ts';
import { nowMs } from './cache/clock.ts';
import { InvalidatedTags } from './cache/context.ts';
import { configureCacheHandlers } from './cache/handlers.ts';
import { type CacheRuntime, createCacheRuntime } from './cache/runtime.ts';
import { handleRequest } from './handle.ts';
import { changesSomething } from './node-bridge.ts';
import {
  installRequestContext,
  plainHeaders,
  publicUrl,
  withRequestContext,
} from './request-context.ts';
import { resourceWarmOf, warmResourceRoute } from './resource-warm.ts';
import { withInvalidatedTags } from './serve.ts';

/**
 * Entry of a deployment's Function. The adapter bundles this file, with `arkor:app` resolved to the
 * generated `app.cjs` that holds the application's own code, and uploads both as one user Function.
 * `arkor:edge` is the same for the entrypoints built for Next.js's edge runtime — a module of
 * the Function when the build produced any, and an empty table when it did not.
 */
const HTTP_INTERNAL_ERROR = 500;

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  readonly props?: unknown;
}

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

/**
 * What the Function answers with when it fails before Next.js does: that it failed, and a reference
 * to the failure, which the line it is logged under carries too (`answered`).
 *
 * Not the failure's own words. A message says whatever the code that threw put in it — a query, a
 * path on disk, a value it was handed, the name of something it could not read — and this body
 * travels to whatever asked, which may be anyone. Next.js answers its own failures in production
 * without one, and a Node.js handler's failure here is answered so already (`invokeNodeHandler`);
 * this catch is for the rest: a middleware's, an edge-runtime handler's, a module that threw as it
 * was evaluated.
 *
 * Where the message is still wanted, and it was — a deployment once answered 500 on every one of
 * its two hundred routes, and two days went on candidates the first line of its message would have
 * settled — it is in the log beside the error itself, and the reference in the body finds it there.
 */
function failureBody(reference: string): string {
  return `Internal Server Error (${reference})`;
}

/**
 * The request answered, and never a rejection: a failure before Next.js answered is logged here and
 * answered with a 500. Here rather than around the caller's `await`, because for a request that is
 * held (below) this is the work that survives a client that went away, and a failure in it is still
 * one to see in the log.
 */
async function answered(
  request: Request,
  env: unknown,
  waitUntil: (promise: Promise<unknown>) => void,
  props?: unknown,
): Promise<Response> {
  // Kept here as well as in the request's context: a failure answered below says them too.
  const invalidated = new InvalidatedTags();
  try {
    // Before anything of the application runs: a service binding is an object, so it reaches
    // neither `process.env` nor any other place Next.js server code can look. An application reads
    // its service bindings back out of here, for the clients it makes of them.
    publishFunctionEnv(env);
    const { blobs, runtime } = hostFor(env);
    return await withRequestContext(
      { headers: plainHeaders(request.headers), url: publicUrl(request), waitUntil },
      async () => {
        const warm = resourceWarmOf(props);
        if (warm !== undefined) {
          // Middleware carries no cache host, so it cannot regenerate a page. Keep its existing
          // answer here, where the build can leave the page-regeneration graph out of this Worker.
          if (__ARKOR_FUNCTION_KIND__ === 'middleware') {
            return Response.json({ v: 1, kind: 'unsupported' });
          }
          const result = await warmResourceRoute({
            props: warm,
            tables: { app: app as AppModule, edge: edge as EdgeModule, waitUntil },
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
          // The clock a test configuration hands the request; the host decides whether one may.
          clock: runtime?.clockOf(request),
          waitUntil,
          invalidated,
        });
      },
    );
  } catch (error) {
    // The Function's own log, under the reference the answer carries: nothing else sees a request
    // that failed before Next.js answered, and the answer says nothing of why (`failureBody`).
    const reference = crypto.randomUUID();
    // eslint-disable-next-line no-console
    console.error(`next-runtime: request failed (${reference})`, error);
    const failure = new Response(failureBody(reference), {
      status: HTTP_INTERNAL_ERROR,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
    // What the request invalidated before it failed is invalidated all the same.
    return withInvalidatedTags(failure, invalidated);
  }
}

const entry = {
  fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> {
    installRequestContext();
    const waitUntil = (promise: Promise<unknown>): void => {
      ctx.waitUntil(promise);
    };
    const answer = answered(request, env, waitUntil, ctx.props);
    // A request that may change something is seen through, whether or not anyone is still waiting
    // for it. workerd cancels a request's work when its client goes away — at the next thing the
    // work waits on — and keeps only what `waitUntil` holds: measured, a write a handler made 300 ms
    // in never happened when its client went away at 50 ms, and did with the work held. So a Server
    // Action whose page reloaded or closed under it stopped between one write and the next, where
    // Next.js on Node.js runs it to its end whatever became of the client. This holds the request to
    // its answer; a Node.js handler that goes on after its headers is held to its own end where it
    // runs (`invokeNodeHandler`).
    if (changesSomething(request.method) || resourceWarmOf(ctx.props) !== undefined) {
      ctx.waitUntil(answer);
    }
    return answer;
  },
};

// The Function entry: what workerd looks for, and the one default export the runtime has.
// eslint-disable-next-line import-x/no-default-export
export default entry;
