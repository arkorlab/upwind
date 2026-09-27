import { occurrencesOf, type Patch, Rewrite } from './types.ts';

/**
 * How long a prerender's last pass waits for a cached function's input before it gives up.
 *
 * A `"use cache"` function's key is its arguments, and a promise among them is keyed by what it
 * resolves to. The last pass of a prerender, which expects every cache filled by the pass before
 * it, waits for such a promise until its final stage and one tick more, and then gives up on it
 * (`createHangingInputAbortSignal`, `server/app-render/dynamic-rendering.ts`): "we might still be
 * waiting on some microtasks so we wait one tick before giving up". The tick is
 * `scheduleOnNextTick`, a `process.nextTick` queued from a microtask, which Node.js runs once the
 * microtask queue is empty. workerd's `process.nextTick` is a microtask of its own, queued behind
 * the ones already there and ahead of what they go on to queue, so the wait ended in the middle of
 * the chains it was waiting for.
 *
 * A page that hands a cached function promises made from `params` — `params.then(…)`,
 * `.catch(…)`, `.finally(…)` and `.finally().catch()`, each a few microtasks behind it — had one
 * of their keys read without the value (`app-dir/fallback-shells`, "params.then/catch/finally
 * passed to a cached function"). That key was not one the first pass filled, the pass reported
 * "Unexpected cache miss after cache warming phase during prerendering", and the member's static
 * generation failed with it: the request was answered 500 where `next start`, given the same build,
 * prerendered the page. Next.js's own logging (`NEXT_PRIVATE_DEBUG_CACHE`) showed that one key of
 * four without its value; the other three, and all of the first pass's, had it.
 *
 * The wait is given what Next.js gives it on its edge runtime, which has no `process.nextTick` to
 * count on: a timer of no delay, which runs once the microtask queue is empty. Only a prerender's
 * last pass reaches it, and only an input that has not resolved by then waits on it.
 */

const NAME = 'hanging-input-abort';
/**
 * Next.js's own files, and the server output of any `distDir` Turbopack compiled the module into.
 * The edge graph's, under `server/edge/`, is bundled apart, and waits on a timer already.
 */
const TARGET =
  // eslint-disable-next-line require-unicode-regexp -- a bundler filter: a Go regular expression
  /(?:\/next\/dist\/(?:compiled\/next-server\/[\w-]+\.runtime\.prod|(?:esm\/)?server\/app-render\/dynamic-rendering)|\/server\/(?:chunks|app|pages)\/.+)\.js$/;
/** What the function reads of a prerender, both of them Next.js's own: not a file of anyone else's. */
const INPUT_READY = '.inputReady().then(';
const MARKS = [INPUT_READY, '.waitForStage('];
/** The two waits of the last pass, in each copy of the function. */
const WAITS_PER_COPY = 2;
/**
 * `scheduleOnNextTick(() => controller.abort())`, once after the final stage and once without one,
 * as it reads in the source, called through the module (`(0, _scheduler.scheduleOnNextTick)(…)`) and
 * after a minifier alike.
 */
const TICK_ABORT =
  /(?:\(0,\s*[\w$]+\.)?scheduleOnNextTick\)?\(\(\)\s*=>\s*(?<controller>[\w$]+)\.abort\(\)\)/gu;
const TIMER_ABORT = 'setTimeout(()=>$<controller>.abort(),0)';
const LEFTOVERS = [/scheduleOnNextTick\)?\(\(\)\s*=>\s*[\w$]+\.abort\(\)\)/u];

export const hangingInputAbortPatch: Patch = {
  name: NAME,
  target: TARGET,
  // Turbopack puts the module in whichever chunk its graph put it; there is no name to find it by.
  marker: (source) => MARKS.every((mark) => source.includes(mark)),
  // The function's own file, the ESM copy beside it, and the chunk a build copied it into. Not the
  // compiled runtimes: `TARGET` admits them, and the waits this rewrites are not in them.
  reaches: ['module', 'esm-module', 'build-output'],
  apply(source, file) {
    // Two to each copy of the function, and a chunk may hold more than one: Turbopack puts the
    // one it compiled for each layer that imports it wherever the graph put that layer.
    const waits = WAITS_PER_COPY * occurrencesOf(source, INPUT_READY);
    const result = new Rewrite(NAME, file, source)
      .expand(TICK_ABORT, TIMER_ABORT, waits, "the last pass's wait for a cached function's input")
      .forbid(LEFTOVERS, 'a wait that ends in the middle of the microtasks it waits for');
    return { contents: result.contents, edits: result.edits, notes: [] };
  },
};
