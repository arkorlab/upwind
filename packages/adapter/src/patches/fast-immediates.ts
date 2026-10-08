import { type Patch, Rewrite } from './types.ts';

/**
 * Next.js runs a prerender as a sequence of tasks, and has the immediates one of them schedules —
 * React's `scheduleWork` among them — run before the next. Under Node.js it captures them ("fast
 * immediates", `server/node-environment-extensions/fast-set-immediate.external.ts`) and runs them
 * once the task's microtasks are done: a `process.nextTick` queued from a microtask, which Node.js
 * runs once the microtask queue is empty. workerd's `process.nextTick` is a microtask of its own,
 * queued behind the ones already there and ahead of what they go on to queue, so what was captured
 * ran two microtasks into the task, in the middle of the chains it was to wait for.
 *
 * What showed it was a prerender's server rendering. React rendered the document before its client
 * had read the payload the server components had already written in full, and reached a component
 * that reads the time while the viewport was still on its way. Reading the time ends a prerender
 * where it stands, and a viewport left unresolved fails the static generation: a payload request for
 * a path no page answers was answered 500 where `next start`, given the same build, answers the
 * not-found (`app-dir/global-not-found/cache-components`, whose not-found renders the year).
 *
 * The runtime's scheduler gives a task boundary that meaning already (`packages/runtime/src/
 * tasks.ts`, with the `task-timers` patch): the next task of a prerender runs once every immediate
 * scheduled before it, those they scheduled included, has run. So where that scheduler is installed
 * a task captures nothing: an immediate is workerd's own, it runs once the microtask queue is empty,
 * and the next task waits for it. Where nothing installs it (`next build` itself, under Node.js),
 * Next.js captures them as before.
 */

const NAME = 'fast-immediates';
/** Next.js's CommonJS build, for the reason `load-manifest.ts` gives of its own target. */
const TARGET =
  /\/next\/dist\/server\/node-environment-extensions\/fast-set-immediate\.external\.js$/u;
/** Where every task of a prerender starts capturing, before it does anything else. */
const TASK_START = /(?<head>function DANGEROUSLY_runPendingImmediatesAfterCurrentTask\(\) \{)/gu;
/** The same, returning at once where the runtime's scheduler (`task-timers`) is installed. */
const UNLESS_SCHEDULED =
  '$<head>\n    if (globalThis[Symbol.for("arkor.task-timer")] !== undefined) {\n        return;\n    }';

export const fastImmediatesPatch: Patch = {
  name: NAME,
  target: TARGET,
  // One file of Next.js's own: the compiled server runtimes require it rather than carry a copy.
  reaches: ['module'],
  apply(source, file) {
    const result = new Rewrite(NAME, file, source).expand(
      TASK_START,
      UNLESS_SCHEDULED,
      1,
      'the start of a task that captures immediates',
    );
    return {
      contents: result.contents,
      edits: result.edits,
      notes: ['a task captures no immediates where the runtime schedules tasks'],
    };
  },
};
