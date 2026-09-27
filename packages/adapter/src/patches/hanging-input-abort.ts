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
/**
 * The pair of waits the last pass gives up on, matched together.
 *
 * The scheduler is read off the code rather than named, because the name does not always survive.
 * Reached as a property of a module namespace it does — a minifier may rename the namespace but not
 * the export (`(0,g.scheduleOnNextTick)(…)`, and `(0, _scheduler.scheduleOnNextTick)(…)` in the
 * source) — and reached as a local binding it does not (`t(…)`, which is what a 16.2 chunk holds).
 * What is the same in every shape is the pair: a wait for the runtime stage whose `then` schedules
 * the abort, and the same call again where there was no stage to wait for.
 *
 * Both in one match, and the second held to the first by back-reference, so the scope this rewrites
 * is the pair itself. A minifier picks names per scope and reuses them freely, so `t(()=>b.abort())`
 * somewhere else in the same chunk is a thing that happens, and neither end of the pair may be one
 * of those: the first is anchored to the `waitForStage` this function's own wait follows, and the
 * second to the branch taken when there was no stage — an `else`, or the `:` a chunk writes it as.
 * An unrelated call between them is stepped over rather than taken, and what does separate them is
 * kept as it was.
 *
 * An arrow is written `()=>` by every compiler that produces these files, minified or not, so the
 * scheduler is either a name or a parenthesized expression and needs no more than that said of it.
 */
const BOTH_ABORTS =
  /(?<head>\.waitForStage\([^;]*?\)\.then\(\(\)=>)(?<tick>[\w$]+|\([^)]{1,60}\))\(\(\)=>(?<controller>[\w$]+)\.abort\(\)\)(?<between>[\s\S]{0,200}?(?:else[\s{]*|:))\k<tick>\(\(\)=>\k<controller>\.abort\(\)\)/gu;
/** The same two, on a timer that runs once the microtask queue is empty. */
const TIMER_ABORTS =
  '$<head>setTimeout(()=>$<controller>.abort(),0)$<between>setTimeout(()=>$<controller>.abort(),0)';

export const hangingInputAbortPatch: Patch = {
  name: NAME,
  target: TARGET,
  // Turbopack puts the module in whichever chunk its graph put it; there is no name to find it by.
  marker: (source) => MARKS.every((mark) => source.includes(mark)),
  // The function's own file, the ESM copy beside it, and the chunk a build copied it into. Not the
  // compiled runtimes: `TARGET` admits them, and the waits this rewrites are not in them.
  reaches: ['module', 'esm-module', 'build-output'],
  apply(source, file) {
    // One copy of the function to each `inputReady`, and a chunk may hold more than one: Turbopack
    // puts the one it compiled for each layer that imports it wherever the graph put that layer.
    // Each copy holds the pair once, so the two counts have to agree — and where they do not,
    // something about the shape has moved and no rewrite below would mean anything.
    const copies = occurrencesOf(source, INPUT_READY);
    const result = new Rewrite(NAME, file, source).expand(
      BOTH_ABORTS,
      TIMER_ABORTS,
      copies,
      "the last pass's wait for a cached function's input",
    );
    return {
      contents: result.contents,
      edits: result.edits,
      notes: [`${String(copies)} copy/copies of the wait`],
    };
  },
};
