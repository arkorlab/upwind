import { isDeadlineError, withDeadline } from '@stayingupwind/core/util';

import type { AppModule, EdgeModule, NodeHandler, WebHandler } from './app-module.ts';
import { admitting } from './cache/fetch-patch.ts';
import { asMiddleware } from './middleware-scope.ts';

/**
 * The entrypoints a deployment carries, and how each is invoked.
 *
 * The two runtimes Next.js builds for take different things: a Node.js entrypoint the request and
 * response of a `node:http` server, an edge one a Web `Request`. Which one a route is on is what
 * the build said, and no route is on both — so the two tables are looked up in turn, and what
 * comes back says how to call what it found.
 *
 * Each table is a Next.js module graph of its own, and a graph has to be let in to the global
 * `fetch` for the length of an invocation before anything it renders can cache one
 * (`cache/fetch-patch.ts`). Every handler a request reaches comes from here, so every handler
 * handed out is wrapped in its graph's turn.
 *
 * Looking one up is asynchronous, because what a thunk hands back may be a promise. `require` of
 * an entrypoint whose source has a top-level await — a `middleware.ts` that awaits a
 * configuration read, a page that instantiates WebAssembly — returns a promise of the module
 * rather than the module, and the `.handler` read off that is `undefined`: the request reaches
 * `handler is not a function` and answers 500, every time, for as long as the entrypoint is
 * deployed. The bundle's own module registry evaluates each entrypoint once, so from the second
 * request on this awaits a value that is already there.
 *
 * Once for the isolate, that is, and not once per request: an evaluation one request began is the
 * one every request that asks for the module before it settles waits on. On workerd what a
 * top-level await waits on — a timer, a fetch — belongs to the request that began the evaluation,
 * and a request that is over — answered, or cancelled when its client went away — takes all of
 * its work with it but what its `waitUntil` holds. Measured on workerd: a request awaiting a
 * promise whose timer belonged to a request answered before the timer fired waited until its own
 * client gave up, and was answered at once when the first request's `waitUntil` held the promise.
 * So a `middleware.ts` that awaits a timer at its top level, first asked for by a `GET` whose
 * client left before the timer fired, is left unevaluated for the rest of the isolate, and every
 * request routed through it waits with no end. The request that begins an evaluation therefore
 * holds it with its own `waitUntil`, and one that joins it waits no longer than an evaluation is
 * sure to be held for (`evaluated`).
 */

/** Where a deployment's entrypoints live: the Function's two generated modules. */
export interface EntryTables {
  readonly app: AppModule;
  readonly edge: EdgeModule;
  /**
   * The `waitUntil` of the request the entrypoints are looked up for, where it has one: what a
   * lookup begins evaluating is held there, so that it outlives that request (`evaluated`).
   */
  readonly waitUntil?: ((promise: Promise<unknown>) => void) | undefined;
}

export type Entry =
  | { readonly kind: 'node'; readonly handler: NodeHandler }
  | { readonly kind: 'edge'; readonly handler: WebHandler };

/** What a thunk of either table hands back: its module, or a promise of it (`AppModule`). */
type Thunk<M> = () => M | Promise<M>;

type WaitUntil = (promise: Promise<unknown>) => void;

/** An evaluation under way: one request began it, and every request asking meanwhile waits on it. */
interface Evaluating {
  readonly kind: 'evaluating';
  /** What the thunk handed back, which settles as the module's top-level await does. */
  readonly module: Promise<unknown>;
  /** When it began, on the isolate's own clock. */
  readonly began: number;
}

/** A module whose top-level await has run to its end: what every later lookup is handed at once. */
interface Evaluated {
  readonly kind: 'evaluated';
  readonly module: unknown;
}

/**
 * What became of each thunk's module, by thunk: a generated thunk is immutable, and the same one is
 * reached by concurrent requests. A module its thunk hands over as it is — one that awaits nothing
 * at its top level — is never kept here, and its thunk is called at every lookup, as it always was.
 */
const EVALUATIONS = new WeakMap<Thunk<unknown>, Evaluating | Evaluated>();

/**
 * The evaluations given up on (`EVALUATION_WAIT_MS`) that have not settled since. A bundle's module
 * registry evaluates a module once, so a thunk asked again after its evaluation was given up on may
 * hand back the very promise that was: there is then nothing fresh to wait for, and the request
 * that asked fails at once rather than waiting out the same evaluation again.
 */
const ABANDONED = new WeakSet<Promise<unknown>>();

/**
 * How long after an evaluation began a request that joined it goes on waiting for it.
 *
 * Thirty seconds: what a Worker gives the work its request's `waitUntil` holds once the request is
 * over, which is the lifetime `cache/current.ts` gives a shared read for the same reason. The
 * request that began the evaluation holds it there, and that request was not over before the
 * evaluation began — so for thirty seconds from its start the evaluation runs whatever becomes of
 * that request, and none that settles within them is given up on. Past them it may have been
 * cancelled with that request, or may still be running for a client that is still waiting, and
 * nothing in another request can tell which. The request that began it is not bounded here: it
 * waits on its own timers and its own I/O, as it would under Node.js, within the limits a Worker
 * sets on any request.
 */
const EVALUATION_WAIT_MS = 30_000;
const MS_PER_SECOND = 1000;

/** Whether the deployment has an entrypoint for `id`, without loading it. */
export function hasEntry(tables: EntryTables, id: string): boolean {
  return tables.edge.entries[id] !== undefined || tables.app.entries[id] !== undefined;
}

/** What a request that waited out an evaluation, or found one given up on, fails with. */
function givenUp(id: string, cause?: unknown): Error {
  return new Error(
    `next-runtime: the module of ${id} was still evaluating ${EVALUATION_WAIT_MS / MS_PER_SECOND} s after a request began it, and is given up on`,
    { cause },
  );
}

/**
 * Keep what an evaluation settled as: its module, handed to every later lookup at once — even when
 * the evaluation had been given up on, and no other has begun since — or, when it failed, nothing,
 * so that the next lookup calls the thunk again, as an eager lookup always has. Never rejects: a
 * failure is reported by whoever awaited the module, and this is what `waitUntil` holds.
 */
async function settle(load: Thunk<unknown>, evaluation: Evaluating): Promise<void> {
  try {
    const module = await evaluation.module;
    const current = EVALUATIONS.get(load);
    if (current === undefined || current === evaluation) {
      EVALUATIONS.set(load, { kind: 'evaluated', module });
    }
  } catch {
    if (EVALUATIONS.get(load) === evaluation) {
      EVALUATIONS.delete(load);
    }
  } finally {
    ABANDONED.delete(evaluation.module);
  }
}

/**
 * An evaluation this request begins: held with its `waitUntil`, since it is every later request's
 * as much as this one's, and awaited by this request as it always was.
 */
function begun<M>(
  load: Thunk<M>,
  module: Promise<M>,
  waitUntil: WaitUntil | undefined,
): Promise<M> {
  const evaluation: Evaluating = { kind: 'evaluating', module, began: performance.now() };
  EVALUATIONS.set(load, evaluation);
  // Before anything awaits the module, so that what is kept of it is in place for them.
  const settled = settle(load, evaluation);
  waitUntil?.(settled);
  return module;
}

/**
 * An evaluation another request began, waited on for what is left of `EVALUATION_WAIT_MS` since it
 * began. Given up on past that, which leaves the thunk to be called afresh by whoever asks next.
 */
async function joined<M>(load: Thunk<M>, evaluation: Evaluating, id: string): Promise<M> {
  const left = evaluation.began + EVALUATION_WAIT_MS - performance.now();
  try {
    // What is kept for `load` is what `load` handed back.
    return (await withDeadline(evaluation.module, left, `the evaluation of ${id}`)) as M;
  } catch (error) {
    if (!isDeadlineError(error)) {
      throw error;
    }
    if (EVALUATIONS.get(load) === evaluation) {
      EVALUATIONS.delete(load);
    }
    ABANDONED.add(evaluation.module);
    throw givenUp(id, error);
  }
}

/**
 * The module `load` hands back, evaluated: begun by this request when no other has begun it, joined
 * when one has, and handed over as it is once one has settled with it — which is all a warm lookup
 * does: nothing is held, waited on or timed for it. Everything up to the first wait is done as this
 * is called, the hold among it, so an evaluation is held before the request that began it has done
 * anything else.
 */
async function evaluated<M>(
  load: Thunk<M>,
  id: string,
  waitUntil: WaitUntil | undefined,
): Promise<M> {
  const known = EVALUATIONS.get(load);
  if (known?.kind === 'evaluated') {
    // What is kept for `load` is what `load` handed back.
    return known.module as M;
  }
  if (known !== undefined) {
    return await joined(load, known, id);
  }
  const module = load();
  if (!(module instanceof Promise)) {
    return module;
  }
  if (ABANDONED.has(module)) {
    throw givenUp(id);
  }
  return await begun(load, module, waitUntil);
}

/** The entrypoint for `id`, loaded: its module is evaluated here, on the first request for it. */
export async function entryFor(tables: EntryTables, id: string): Promise<Entry | undefined> {
  const edge = tables.edge.entries[id];
  if (edge !== undefined) {
    const module = await evaluated(edge, id, tables.waitUntil);
    return { kind: 'edge', handler: admitting('edge', module.handler) };
  }
  const handler = await nodeHandlerOf(tables, id);
  return handler === undefined ? undefined : { kind: 'node', handler };
}

interface DeferredNode {
  handler: NodeHandler | undefined;
  readonly invoke: NodeHandler;
}

/** A generated loader is immutable, and the same loader may be reached by concurrent requests. */
const DEFERRED_NODES = new WeakMap<AppModule['entries'][string], DeferredNode>();

function deferredNode(load: AppModule['entries'][string], id: string): NodeHandler {
  let state = DEFERRED_NODES.get(load);
  if (state === undefined) {
    const deferred: DeferredNode = {
      handler: undefined,
      async invoke(request, response, context) {
        // Let the caller assemble a shell before starting the module. This microtask does not
        // promise that synchronous initialization happens after bytes leave the Worker.
        await Promise.resolve();
        // Held with the `waitUntil` of the render that begins it. A failed load is retried as an
        // eager lookup would retry it; only successful modules stay.
        const module = await evaluated(load, id, context.waitUntil);
        deferred.handler = module.handler as NodeHandler;
        return admitting('app', deferred.handler)(request, response, context);
      },
    };
    DEFERRED_NODES.set(load, deferred);
    state = deferred;
  }
  // Once loaded, return the original handler: warm renders keep no deferred invocation wrapper.
  return state.handler === undefined ? state.invoke : admitting('app', state.handler);
}

/**
 * A page whose Node.js module is loaded only if its handler is invoked. Reading a static output,
 * a cached generation, or a shell's HEAD needs the route's identity, but none of its renderer.
 * Middleware, writes, explicit resumes and edge-runtime entries keep their eager lookup.
 */
export async function deferredEntryFor(
  tables: EntryTables,
  id: string,
): Promise<Entry | undefined> {
  if (tables.edge.entries[id] !== undefined) {
    return entryFor(tables, id);
  }
  const load = tables.app.entries[id];
  return load === undefined ? undefined : { kind: 'node', handler: deferredNode(load, id) };
}

/**
 * The Node.js handler for `id`, which alone can resume a shell or render an entry for the cache;
 * `undefined` for a route the deployment does not have, and for one on the edge runtime — whose
 * module is then left unevaluated.
 */
export async function nodeHandlerOf(
  tables: EntryTables,
  id: string,
): Promise<NodeHandler | undefined> {
  if (tables.edge.entries[id] !== undefined) {
    return undefined;
  }
  const load = tables.app.entries[id];
  if (load === undefined) {
    return undefined;
  }
  return admitting('app', (await evaluated(load, id, tables.waitUntil)).handler as NodeHandler);
}

/**
 * The middleware, whichever runtime it was built for: `proxy.ts` and the deprecated
 * `middleware.ts` come from one Next.js template and export the same Web handler.
 */
export async function middlewareHandler(
  tables: EntryTables,
  id: string,
): Promise<WebHandler | undefined> {
  const entry = await entryFor(tables, id);
  return entry === undefined ? undefined : asMiddleware(entry.handler as WebHandler);
}
