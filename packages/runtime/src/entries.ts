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

/** An evaluation one request began, which every request asking while it is pending waits on. */
interface Evaluation {
  readonly kind: 'evaluation';
  /** What the thunk handed back, which settles as the module's top-level await does. */
  readonly module: Promise<unknown>;
  /** When it began, on the isolate's own clock. */
  readonly began: number;
  /**
   * Where it stands: `pending`, and waited on by every request that asks; `given-up` past
   * `EVALUATION_WAIT_MS` with nothing settled; `settled`, either way. Past `pending` the next
   * request calls the thunk afresh — and one handed back the very promise given up on fails at
   * once, since a bundle's module registry evaluates a module once and has nothing fresh to give.
   */
  state: 'pending' | 'given-up' | 'settled';
}

/** A module whose top-level await has run to its end: what every later lookup is handed at once. */
interface Evaluated {
  readonly kind: 'evaluated';
  readonly module: unknown;
}

/**
 * The latest evaluation of each thunk's module, or the module one settled with, by thunk: a
 * generated thunk is immutable, and the same one is reached by concurrent requests. An evaluation
 * stays here once it fails or is given up on, joined by no one, until another begins — so that one
 * which settles with a module after all is kept only while no later evaluation has begun, whose
 * outcome stands otherwise (`settle`). A module its thunk hands over as it is — one that awaits
 * nothing at its top level — is never kept here, and its thunk is called at every lookup, as it
 * always was.
 */
const EVALUATIONS = new WeakMap<Thunk<unknown>, Evaluation | Evaluated>();

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

/** What the timer of a request waiting on an evaluation settles with: nothing a module can be. */
const WAITED_OUT = Symbol('waited out');

/** Whether the deployment has an entrypoint for `id`, without loading it. */
export function hasEntry(tables: EntryTables, id: string): boolean {
  return tables.edge.entries[id] !== undefined || tables.app.entries[id] !== undefined;
}

/** What a request that waited out an evaluation, or found one given up on, fails with. */
function givenUp(id: string): Error {
  return new Error(
    `next-runtime: the module of ${id} was still evaluating ${EVALUATION_WAIT_MS / MS_PER_SECOND} s after a request began it, and is given up on`,
  );
}

/**
 * Keep what an evaluation settled as. Its module, handed to every later lookup at once, while it is
 * still its thunk's latest evaluation — one given up on that settles after all among them — and
 * not once another has begun: a later evaluation's outcome stands, its failure included, which the
 * next lookup retries rather than being handed a module the thunk has handed over again since. A
 * failure leaves the evaluation for no one to join, so that the next lookup calls the thunk again,
 * as an eager lookup always has. Never rejects: a failure is reported by whoever awaited the
 * module, and this is what `waitUntil` holds.
 */
async function settle(load: Thunk<unknown>, evaluation: Evaluation): Promise<void> {
  try {
    const module = await evaluation.module;
    if (EVALUATIONS.get(load) === evaluation) {
      EVALUATIONS.set(load, { kind: 'evaluated', module });
    }
  } catch {
    // Nothing to keep: the failure is the evaluation's, for whoever awaited it to report.
  } finally {
    evaluation.state = 'settled';
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
  const evaluation: Evaluation = {
    kind: 'evaluation',
    module,
    began: performance.now(),
    state: 'pending',
  };
  EVALUATIONS.set(load, evaluation);
  // Before anything awaits the module, so that what is kept of it is in place for them.
  const settled = settle(load, evaluation);
  try {
    waitUntil?.(settled);
  } catch {
    // A host that will not hold it — a `waitUntil` past the end of the invocation it belongs to —
    // leaves it this request's alone: no later request joins what nothing holds, but begins its
    // own, and this one awaits its module as an eager lookup does, with nothing of it kept.
    if (EVALUATIONS.get(load) === evaluation) {
      EVALUATIONS.delete(load);
    }
  }
  return module;
}

/**
 * An evaluation another request began, waited on for what is left of `EVALUATION_WAIT_MS` since it
 * began. Given up on past that, which leaves the thunk to be called afresh by whoever asks next.
 *
 * Only this request's own timer says the wait is out. An evaluation that fails fails as itself for
 * every request waiting on it, whatever it fails with — a module's own top-level read, bounded by a
 * deadline of its own, may fail with the very error a deadline here would — and is no more given up
 * on than it is for the request that began it.
 */
async function joined<M>(evaluation: Evaluation, id: string): Promise<M> {
  const left = evaluation.began + EVALUATION_WAIT_MS - performance.now();
  const waited = Promise.withResolvers<typeof WAITED_OUT>();
  const timer = setTimeout(
    () => {
      waited.resolve(WAITED_OUT);
    },
    Math.max(left, 0),
  );
  try {
    const outcome = await Promise.race([evaluation.module, waited.promise]);
    if (outcome !== WAITED_OUT) {
      // What is kept for a thunk is what that thunk handed back.
      return outcome as M;
    }
  } finally {
    clearTimeout(timer);
  }
  // Given up on only while nothing has settled it, which may have come about since the timer fired.
  if (evaluation.state === 'pending') {
    evaluation.state = 'given-up';
  }
  throw givenUp(id);
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
  if (known?.state === 'pending') {
    return await joined(known, id);
  }
  const module = load();
  if (!(module instanceof Promise)) {
    // What its thunk hands over as it is stands for it from now on (`standsFor`), over an
    // evaluation given up on or failed before, whose module, should it settle after all, is then
    // kept for no one (`settle`).
    EVALUATIONS.delete(load);
    return module;
  }
  if (known?.state === 'given-up' && known.module === module) {
    throw givenUp(id);
  }
  return await begun(load, module, waitUntil);
}

/**
 * Whether `module` is what a later lookup of `load` is handed: the module its latest evaluation
 * settled with, or one its thunk hands over as it is, which no evaluation keeps. Not a module that
 * an evaluation given up on settles with once a later one has begun, though the request that
 * awaited it is handed it all the same (`settle`).
 */
function standsFor(load: Thunk<unknown>, module: unknown): boolean {
  const kept = EVALUATIONS.get(load);
  return kept === undefined || (kept.kind === 'evaluated' && kept.module === module);
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

/**
 * The handler of a page whose Node.js module is loaded only once it is invoked (`deferredEntryFor`):
 * the module evaluated on its first invocation, and held past the request that begins it
 * (`evaluated`); once it has loaded, the module's own handler, of the evaluation that stands for
 * its thunk (`standsFor`).
 */
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
        const handler = module.handler as NodeHandler;
        // Kept for later renders only while it is what a lookup is handed: the module of an
        // evaluation a later one superseded serves the render that awaited it, and no other.
        if (standsFor(load, module)) {
          deferred.handler = handler;
        }
        return admitting('app', handler)(request, response, context);
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
