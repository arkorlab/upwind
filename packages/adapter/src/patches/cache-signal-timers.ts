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
 * a server that is one `clearImmediate` among many. In a Worker a timer belongs to the request
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
 */

const NAME = 'cache-signal-timers';
/**
 * Two copies reach a Worker: the source file, which Next.js's own server code requires, and the
 * one bundled into each compiled server runtime. Both are loaded, so both are rewritten.
 */
const TARGET =
  /\/next\/dist\/(?:server\/app-render\/cache-signal\.js|compiled\/next-server\/[\w-]+\.runtime\.prod\.js)$/u;
/** The field the signal keeps its cancellation on; no other file this target matches has one. */
const MARKER = 'pendingTimeoutCleanup';

/**
 * Where the signal arms its task, in the two shapes it reaches a build in: a call of the named
 * helper in the source file Next.js ships, and that helper inlined as one comma expression where
 * a minifier has been through it. Each is the one assignment of `pendingTimeoutCleanup` that is
 * not `null`, and both are replaced by the same call.
 */
const SCHEDULE_SHAPES: readonly RegExp[] = [
  /this\.pendingTimeoutCleanup = scheduleImmediateAndTimeoutWithCleanup\(this\.invokeListenersIfNoPendingReads\)/gu,
  /this\.pendingTimeoutCleanup=\([\w$]+=this\.invokeListenersIfNoPendingReads,[\s\S]{0,200}?,\(\)=>[\w$]+\(\)\)/gu,
];
const SCHEDULED =
  'this.pendingTimeoutCleanup = __arkorSchedule(this.invokeListenersIfNoPendingReads)';

/**
 * The same immediate-then-timeout Next.js schedules, with the cancellation moved off the timer.
 *
 * The generation is kept against the callback rather than against the signal because the callback
 * is the one thing both shapes hand over: it is the bound arrow the signal made for itself in its
 * constructor, so it identifies that signal and no other.
 */
const HELPER = [
  '',
  'const __arkorGenerations = new WeakMap();',
  'function __arkorSchedule(cb) {',
  '  const generation = (__arkorGenerations.get(cb) ?? 0) + 1;',
  '  __arkorGenerations.set(cb, generation);',
  '  let clearPending;',
  '  const immediate = setImmediate(() => {',
  '    const timeout = setTimeout(() => {',
  '      if (__arkorGenerations.get(cb) === generation) {',
  '        cb();',
  '      }',
  '    }, 0);',
  '    clearPending = clearTimeout.bind(null, timeout);',
  '  });',
  '  clearPending = clearImmediate.bind(null, immediate);',
  '  return () => {',
  '    __arkorGenerations.set(cb, (__arkorGenerations.get(cb) ?? 0) + 1);',
  '    try {',
  '      clearPending();',
  '    } catch {',
  '      // A timer belongs to the request that scheduled it, and a Worker refuses to let another',
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
  nextVersions: ['16.3.5', '16.3.6'],
  apply(source, file) {
    const rewrite = new Rewrite(NAME, file, source);
    const shape = SCHEDULE_SHAPES.find((candidate) => occurrencesOf(source, candidate) > 0);
    if (shape === undefined) {
      throw rewrite.fail("expected the cache signal's scheduling 1 time(s), found 0");
    }
    const result = rewrite
      .replace(shape, SCHEDULED, 1, "the cache signal's scheduling")
      .append(HELPER);
    return {
      contents: result.contents,
      edits: result.edits,
      notes: ['cancelling no longer depends on clearing another request’s timer'],
    };
  },
};
