import { type Patch, Rewrite } from './types.ts';

/**
 * The compiled page runtime (`app-page*.runtime.prod.js`, which every App Router entrypoint
 * requires) runs a prerender as a sequence of tasks: `setTimeout(…, 0)` timers whose
 * `_idleStart` it aligns so that Node.js fires them in one timers phase, with React's
 * `setImmediate` work drained between them by Next.js's own patch of `setImmediate` and
 * `process.nextTick`. workerd has neither timer phases nor a `nextTick` queue of its own: the
 * timers fire before the immediates scheduled between them, the render is aborted before React
 * has emitted anything, and a static render never completes — it hangs when what it produced
 * is decoded.
 *
 * The timers of such a group are handed to the runtime's scheduler instead
 * (`Symbol.for('arkor.task-timer')`, `packages/runtime/src/tasks.ts`), which runs each
 * once the immediates scheduled before it — those they scheduled included — have run. Where
 * the runtime installs none (`next build` itself, under Node.js), `setTimeout` stays.
 *
 * Next.js's warning that it "cannot guarantee that Cache Components will run as expected" is
 * its check that nothing ran between two timers of a group, which is exactly what the scheduler
 * makes happen; it is silenced.
 */

const NAME = 'task-timers';
// eslint-disable-next-line require-unicode-regexp -- a bundler filter: a Go regular expression
const TARGET = /next-server\/app-page(?:-turbo)?(?:-experimental)?\.runtime\.prod\.js$/;
/** The one `setTimeout` of a timer group, right after the guard against scheduling into a spent one. */
const GROUP_TIMER =
  /Cannot schedule more timers into a group that already executed"[^;]*;let \w+=setTimeout\(/gu;
const NATIVE_TIMER = 'setTimeout(';
const HOOKED_TIMER = '(globalThis[Symbol.for("arkor.task-timer")]??setTimeout)(';
const WARNING =
  'console.warn("Next.js cannot guarantee that Cache Components will run as expected due to the current runtime\'s implementation of `setTimeout()`.\\nPlease report a github issue here: https://github.com/vercel/next.js/issues/new/")';
const LEFTOVERS = [
  /Cannot schedule more timers into a group that already executed"[^;]*;let \w+=setTimeout\(/u,
  'cannot guarantee that Cache Components will run as expected',
];

export const taskTimersPatch: Patch = {
  name: NAME,
  target: TARGET,
  apply(source, file) {
    const result = new Rewrite(NAME, file, source)
      .replace(
        GROUP_TIMER,
        (match) => `${match.slice(0, -NATIVE_TIMER.length)}${HOOKED_TIMER}`,
        1,
        'the timer of a task group',
      )
      .replace(WARNING, 'void 0', 1, 'the warning about setTimeout')
      .forbid(LEFTOVERS, 'a native task timer');
    return { contents: result.contents, edits: result.edits, notes: [] };
  },
};
