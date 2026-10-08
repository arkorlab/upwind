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
 * How much of a failure's own words the body carries; a message, not a stack. Characters, which is
 * what the loop below counts — a bound in bytes would have to encode the message to know it had
 * been reached, and nothing here needs one that exact.
 */
const FAILURE_MESSAGE_CHARACTERS = 200;
/**
 * Under this a code point is a C0 control character, and `DEL` through the C1 range are the rest of
 * them. The two separators stand outside that: `U+2028` and `U+2029` are not control characters at
 * all, but a reader that honours either ends a line on it, which is the one thing kept out here —
 * a message is not to put a second line in a log that only wrote one. `U+0085` is the same story
 * from inside C1, and `trim` reaches none of them anywhere but the ends.
 */
const CONTROL_FLOOR = 0x20;
const DELETE_FLOOR = 0x7f;
const CONTROL_CEILING = 0x9f;
const LINE_SEPARATOR = '\u{2028}';
const PARAGRAPH_SEPARATOR = '\u{2029}';

function isControlOrSeparator(character: string): boolean {
  const point = character.codePointAt(0) ?? 0;
  return (
    point < CONTROL_FLOOR ||
    (point >= DELETE_FLOOR && point <= CONTROL_CEILING) ||
    character === LINE_SEPARATOR ||
    character === PARAGRAPH_SEPARATOR
  );
}

/**
 * What a failure says about itself, and nothing at all when it will not say.
 *
 * Three ways a thrown value declines to be read, all of them inside the one guard. `String` throws
 * on a value that reaches no primitive, and `Object.create(null)` is thrown as readily as anything
 * else. A `message` is a property like any other, so a getter there may throw too. And it may hold
 * any value at all rather than a string — a number is a string's shape to the type system here and
 * nothing the walk below can iterate — which is why it is converted rather than returned.
 *
 * Any of the three would leave this catch rejecting instead of answering, which is the whole of
 * what the Function has to do at that point.
 */
function failureMessage(error: unknown): string {
  try {
    return String(error instanceof Error ? error.message : error);
  } catch {
    return '';
  }
}

/**
 * What the Function answers with when it fails before Next.js does.
 *
 * The message, not only `Internal Server Error`. This catch is the one place that knows why such a
 * request failed — Next.js's `onRequestError` is for errors Next.js itself sees, and this one comes
 * from around it — and the `console.error` beside it reaches whoever can read a Function's console,
 * which on a platform that runs Functions in a dispatch namespace is nobody.
 *
 * Found the hard way: a deployment answered 500 on every one of its two hundred routes, and the
 * body said `Internal Server Error` and nothing else. Two days went on candidates that the first
 * line of this message would have settled.
 *
 * The message alone, bounded, and no stack: a stack names the application's own files and this body
 * travels to whatever asked. It is the kind of thing an error page says about itself.
 */
function failureBody(error: unknown): string {
  const message = failureMessage(error);
  // Control characters out, one character at a time: a log line is easier to read without them.
  // Not by pattern — a regular expression over these ranges is the kind the linter asks about every
  // time — and not over `[...message]`, which walks and allocates the whole message, however long,
  // to then throw all but the first two hundred away. `for…of` walks code points and stops at the
  // bound, so a message cut at one cannot end in half a surrogate pair, which a body encodes as
  // `U+FFFD` and reads as damage rather than as a sentence that ran out.
  let said = '';
  let taken = 0;
  for (const character of message) {
    if (taken >= FAILURE_MESSAGE_CHARACTERS) break;
    said += isControlOrSeparator(character) ? ' ' : character;
    taken += 1;
  }
  const trimmed = said.trim();
  return trimmed === '' ? 'Internal Server Error' : `Internal Server Error: ${trimmed}`;
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
      () => {
        const warm = resourceWarmOf(props);
        if (warm !== undefined) {
          return warmResourceRoute({
            props: warm,
            tables: { app: app as AppModule, edge: edge as EdgeModule },
            request,
            runtime,
            waitUntil,
          }).then((result) => Response.json(result));
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
    // The Function's own log: nothing else sees a request that failed before Next.js answered.
    // eslint-disable-next-line no-console
    console.error('next-runtime: request failed', error);
    const failure = new Response(failureBody(error), {
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
