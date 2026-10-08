import { occurrencesOf, type Patch, Rewrite } from './types.ts';

/**
 * The timer Next.js's module-loading `CacheSignal` keeps between requests.
 *
 * Under `cacheComponents`, every dynamic `import()` an application makes is tracked — always
 * globally, as `trackDynamicImport` says in so many words, because the promise may be cached in
 * user code and awaited again later. The signal it is tracked on is one per isolate, and when its
 * count falls to zero it schedules a task to tell its listeners:
 *
 * ```js
 * this.pendingTimeoutCleanup = scheduleImmediateAndTimeoutWithCleanup(
 *   this.invokeListenersIfNoPendingReads,
 * );
 * ```
 *
 * The next read cancels it — `beginRead` calls `pendingTimeoutCleanup()` and then forgets it. On
 * a server that is one `clearImmediate` among many. In a Function a timer belongs to the request
 * that scheduled it, and clearing it from another request's handler is refused: "Cannot perform
 * I/O on behalf of a different request". So the second request in an isolate to make a dynamic
 * import fails, with a stack that names nothing the application wrote.
 *
 * Swallowing that refusal is not enough, and measuring said so: workerd refuses the same way for
 * a request that is still running, whose timer then goes on to fire — after `beginRead` has
 * dropped the handle — and can wake the listeners a round of the event loop before the timer
 * scheduled in its place meant to. So the cancellation is made to hold whether or not the clear
 * is allowed: each scheduling takes a generation off the callback, the callback runs only while
 * its generation is current, and cancelling moves the generation on. Clearing the timer is then
 * only an optimization, and one that may fail.
 *
 * What it takes to reach, and what it costs, both measured on `fixtures/next-minimal` (see
 * `test/fixture.test.ts`, "renders a page after a route handler loaded a module on demand"):
 *
 * - The module has to be an async one — top-level await, for Turbopack — because
 *   `trackPendingImport` tracks a promise and nothing else. A library that instantiates
 *   WebAssembly or opens something at module scope is one; most modules are not. The same import
 *   of an ordinary module was answered every time with the patch taken out.
 * - A route handler's import reaches it; a component's, while a page renders, did not — sixteen
 *   requests to such a page were all answered with the patch taken out. Whether the handler
 *   awaits the import or leaves it pending in the response body makes no difference: both reach
 *   it. `next/og` is a route handler, which is why the platform met this there.
 * - Then the isolate is spoiled, not merely the next request: with the patch taken out, the
 *   fixture answers one request and fails every render after it, whatever the route.
 *
 * Why a page's render is spared is not something the fixture can show, so nothing here claims to
 * know it.
 *
 * So this is not about WebAssembly. `next/og` is where the platform met it, and it is reachable
 * by any route handler that loads an async module on demand.
 *
 * 16.4 hands a signal a second argument, the render's `ImmediateTracker`, and waits for it to be
 * idle rather than for one immediate before arming the timeout; the module-loading signal is built
 * with none (`new CacheSignal(null)`) and schedules as before. Its helper keeps a `cancelled` flag
 * now, but only to stop a timeout being armed: the timeout already armed does not look at it, and
 * the clears are still made from whichever request cancels. So the rewrite stays.
 *
 * What it does not do is wait through the tracker's `onIdle`. That binds the listener to the
 * subscriber's async context, and a Function refuses to call a bound function from any request
 * but the one that made it ("Cannot call this AsyncLocalStorage bound function outside of the
 * request in which it was created") — which the tracker does as soon as an immediate scheduled
 * in another request, by a continuation that kept this render's context, wakes it. That is what
 * suites run against a real application showed, and what follows from it is in the tracker's own
 * code: the refusal is thrown inside it, so neither the listener it refused nor any after it
 * runs, and the signal they were to wake never fires. So the helper keeps its own wait — an
 * immediate, then the timeout — and asks the tracker only whether immediates are still pending
 * when the timeout fires, waiting again while they are.
 *
 * For as long as the tracker is working through them, as 16.4 waits: a render may keep immediates
 * pending for as long as it runs, and telling the listeners before it is done would let it finish
 * before work it has yet to start. What is not waited on for ever is an immediate of a request
 * that has ended, which never runs, and which the tracker would report pending for good. The two
 * are told apart by the tracker's own sentinel — the immediate it checks for idleness behind, a
 * new one each time a check finds more queued, and the same one for as long as nothing ahead of
 * it runs. Rounds are counted only while it stands still, and after `__arkorMaxWaits` of those the
 * listeners are told regardless, which is where a release before 16.4 told them after one round.
 * A tracker with no sentinel to read has every round counted.
 */

const NAME = 'cache-signal-timers';
/**
 * Two copies reach a Function: the source file, which Next.js's own server code requires, and the
 * one bundled into each compiled server runtime. Both are loaded, so both are rewritten.
 */
const TARGET =
  /\/next\/dist\/(?:server\/app-render\/cache-signal\.js|compiled\/next-server\/[\w-]+\.runtime\.prod\.js)$/u;
/** The field the signal keeps its cancellation on; no other file this target matches has one. */
const MARKER = 'pendingTimeoutCleanup';

/** One way the signal arms its task, and the call it is replaced by. */
interface ScheduleShape {
  readonly pattern: RegExp;
  readonly scheduled: string;
}

const SCHEDULED =
  'this.pendingTimeoutCleanup = __arkorSchedule(this.invokeListenersIfNoPendingReads)';
const SCHEDULED_WITH_TRACKER =
  'this.pendingTimeoutCleanup = __arkorSchedule(this.invokeListenersIfNoPendingReads, this.immediateTracker)';

/**
 * Where the signal arms its task, in the shapes it reaches a build in: a call of the named helper
 * in the source file Next.js ships, and that helper inlined where a minifier has been through it —
 * as one comma expression before 16.4, and as a function called on the spot from 16.4, which
 * passes the tracker too. Each is the one assignment of `pendingTimeoutCleanup` that is not
 * `null`, and each is replaced by the same call with the arguments its version passes.
 */
const SCHEDULE_SHAPES: readonly ScheduleShape[] = [
  {
    pattern:
      /this\.pendingTimeoutCleanup = scheduleImmediateAndTimeoutWithCleanup\(this\.invokeListenersIfNoPendingReads\)/gu,
    scheduled: SCHEDULED,
  },
  {
    pattern:
      /this\.pendingTimeoutCleanup=\([\w$]+=this\.invokeListenersIfNoPendingReads,[\s\S]{0,200}?,\(\)=>[\w$]+\(\)\)/gu,
    scheduled: SCHEDULED,
  },
  {
    pattern:
      /this\.pendingTimeoutCleanup = scheduleImmediateAndTimeoutWithCleanup\(this\.invokeListenersIfNoPendingReads, this\.immediateTracker\)/gu,
    scheduled: SCHEDULED_WITH_TRACKER,
  },
  {
    pattern:
      /this\.pendingTimeoutCleanup=function\([\w$]+,[\w$]+\)\{[\s\S]{0,600}?\}\(this\.invokeListenersIfNoPendingReads,this\.immediateTracker\)/gu,
    scheduled: SCHEDULED_WITH_TRACKER,
  },
];

/**
 * The same waits Next.js schedules, with the cancellation moved off the timer.
 *
 * The immediate-then-timeout every version arms, and with a tracker (16.4) the same again for as
 * long as the tracker still reports immediates pending when the timeout fires — up to
 * `__arkorMaxWaits` rounds in which its sentinel has not moved. The tracker is only ever asked,
 * never subscribed to: see above.
 *
 * The generation is kept against the callback rather than against the signal because the callback
 * is the one thing every shape hands over: it is the bound arrow the signal made for itself in its
 * constructor, so it identifies that signal and no other.
 */
const HELPER = [
  '',
  'const __arkorGenerations = new WeakMap();',
  'const __arkorMaxWaits = 100;',
  'function __arkorSchedule(cb, tracker) {',
  '  const generation = (__arkorGenerations.get(cb) ?? 0) + 1;',
  '  __arkorGenerations.set(cb, generation);',
  '  const nothing = () => {};',
  '  let clearPending = nothing;',
  '  let waits = 0;',
  '  let standing;',
  '  const fire = () => {',
  '    clearPending = nothing;',
  '    if (__arkorGenerations.get(cb) !== generation) {',
  '      return;',
  '    }',
  '    if (tracker != null && tracker.hasPendingImmediates()) {',
  '      // A round counts while the sentinel stands still: one the tracker has moved on is working.',
  '      const sentinel = tracker.sentinel;',
  '      waits = sentinel === undefined || sentinel === standing ? waits + 1 : 0;',
  '      standing = sentinel;',
  '      if (waits < __arkorMaxWaits) {',
  '        wait();',
  '        return;',
  '      }',
  '    }',
  '    cb();',
  '  };',
  '  function arm() {',
  '    if (__arkorGenerations.get(cb) === generation) {',
  '      clearPending = clearTimeout.bind(null, setTimeout(fire, 0));',
  '    }',
  '  }',
  '  function wait() {',
  '    clearPending = clearImmediate.bind(null, setImmediate(arm));',
  '  }',
  '  wait();',
  '  return () => {',
  '    __arkorGenerations.set(cb, (__arkorGenerations.get(cb) ?? 0) + 1);',
  '    try {',
  '      clearPending();',
  '    } catch {',
  '      // A timer belongs to the request that scheduled it, and a Function refuses to let another',
  '      // request clear it. The generation above has already cancelled it, so a timer that goes',
  '      // on to fire finds itself out of date and does nothing.',
  '    }',
  '  };',
  '}',
  '',
].join('\n');

export const cacheSignalTimersPatch: Patch = {
  name: NAME,
  target: TARGET,
  marker: (source) => source.includes(MARKER),
  // Both copies `TARGET` names, because a Function loads both.
  reaches: ['module', 'server-runtime'],
  apply(source, file) {
    const rewrite = new Rewrite(NAME, file, source);
    const shape = SCHEDULE_SHAPES.find((candidate) => occurrencesOf(source, candidate.pattern) > 0);
    if (shape === undefined) {
      throw rewrite.fail("expected the cache signal's scheduling 1 time(s), found 0");
    }
    const result = rewrite
      .replace(shape.pattern, shape.scheduled, 1, "the cache signal's scheduling")
      .append(HELPER);
    return {
      contents: result.contents,
      edits: result.edits,
      notes: ['cancelling no longer depends on clearing another request’s timer'],
    };
  },
};
