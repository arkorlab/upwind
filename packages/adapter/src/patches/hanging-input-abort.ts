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
 * The pair of waits the last pass gives up on, and how the scheduler that carries them is found.
 *
 * It is read off the code rather than named, because the name does not always survive. Reached as a
 * property of a module namespace it does — a minifier may rename the namespace but not the export
 * (`(0,g.scheduleOnNextTick)(…)`, and `(0, _scheduler.scheduleOnNextTick)(…)` in the source) — and
 * reached as a local binding it does not (`t(…)`, which is what a 16.2 chunk holds). What is the
 * same in every shape is the pair: a wait for the runtime stage whose `then` schedules the abort,
 * and the same call again where there was no stage to wait for.
 *
 * So the first is matched to learn what the second is spelled as, and both are replaced together.
 * A chunk may hold more than one copy of the function, each minified to names of its own, so each
 * copy is found and rewritten against its own pair.
 */
const STAGED_ABORT =
  /\.waitForStage\([^;]*?\)\.then\(\(\)\s*=>\s*(?<tick>\(0,\s*[\w$]+\.[\w$]+\)|[\w$]+)\(\(\)\s*=>\s*(?<controller>[\w$]+)\.abort\(\)\)/gu;

/** A literal, as a pattern that matches only itself. */
function literally(text: string): string {
  return text.replaceAll(/[$()*+.?[\\\]^{|}]/gu, String.raw`\$&`);
}

/**
 * `<tick>(() => <controller>.abort())`, whatever those two are spelled as in this copy. Built
 * rather than written, since both names come from the file being rewritten; `literally` is what
 * keeps them from being read as a pattern.
 */
function abortsWith(tick: string, controller: string): RegExp {
  const opens = String.raw`\(\(\)\s*=>\s*`;
  const aborts = String.raw`\.abort\(\)\)`;
  // eslint-disable-next-line security/detect-non-literal-regexp -- built from two identifiers this build's own output spelled, each escaped
  return new RegExp(`${literally(tick)}${opens}${literally(controller)}${aborts}`, 'gu');
}

export const hangingInputAbortPatch: Patch = {
  name: NAME,
  target: TARGET,
  // Turbopack puts the module in whichever chunk its graph put it; there is no name to find it by.
  marker: (source) => MARKS.every((mark) => source.includes(mark)),
  apply(source, file) {
    // One copy of the function to each `inputReady`, and a chunk may hold more than one: Turbopack
    // puts the one it compiled for each layer that imports it wherever the graph put that layer.
    // Each copy has one staged abort, so the two counts have to agree — and where they do not,
    // something about the shape has moved and no count below would mean anything.
    const copies = occurrencesOf(source, INPUT_READY);
    const found = [...source.matchAll(STAGED_ABORT)].flatMap((match) => {
      const tick = match.groups?.['tick'];
      const controller = match.groups?.['controller'];
      return tick === undefined || controller === undefined ? [] : [{ tick, controller }];
    });
    const rewrite = new Rewrite(NAME, file, source);
    if (found.length !== copies) {
      throw rewrite.fail(
        `expected the last pass's wait for a cached function's input in ${String(copies)} copy/copies, found ${String(found.length)}`,
      );
    }
    // Grouped rather than taken one at a time, because two copies in one chunk can be minified to
    // the same names — a minifier picks per scope, and these scopes hold the same code. Their two
    // sites each are then one pattern matching four, and the count has to say four.
    const perPair = new Map<string, { tick: string; controller: string; sites: number }>();
    for (const { tick, controller } of found) {
      const key = `${tick} ${controller}`;
      const seen = perPair.get(key);
      perPair.set(key, { tick, controller, sites: (seen?.sites ?? 0) + WAITS_PER_COPY });
    }
    // The counts are the whole guard: every site of every pair is replaced, and a pattern that
    // found a different number of them fails here rather than leaving one behind. A leftover check
    // could not add to that — after a minifier there is no name left to look for.
    let rewritten = rewrite;
    for (const { tick, controller, sites } of perPair.values()) {
      rewritten = rewritten.replace(
        abortsWith(tick, controller),
        `setTimeout(()=>${controller}.abort(),0)`,
        sites,
        "the last pass's wait for a cached function's input",
      );
    }
    return {
      contents: rewritten.contents,
      edits: rewritten.edits,
      notes: [`${String(copies)} copy/copies of the wait`],
    };
  },
};
