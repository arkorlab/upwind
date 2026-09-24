/**
 * The task boundaries Next.js's prerenders count on, on a runtime without Node.js's event loop.
 *
 * With `cacheComponents`, a prerender is a sequence of tasks — `setTimeout(…, 0)` timers Next.js
 * aligns so that Node.js fires them in one timers phase — between which React's `setImmediate`
 * work is drained by Next.js's patch of `setImmediate` and `process.nextTick`. workerd runs
 * timers and immediates in one queue, in the order they were scheduled, and its `nextTick` is
 * a microtask: the drain finds nothing, the next timer fires before React has done anything,
 * and the render is aborted empty. The adapter hands the timers of such a group to this
 * scheduler (`task-timers` patch), which runs each once every immediate scheduled before it —
 * those they scheduled included — has run: what a task boundary means under Node.js.
 *
 * Installed before any of Next.js is evaluated, since Next.js takes `setImmediate` as it finds
 * it then: the one counted here.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export const TASK_TIMER = Symbol.for('arkor.task-timer');

type Callback = (...args: unknown[]) => void;

/** What the group is handed back: it reads and writes `_idleStart` as it would on a Node.js timer. */
interface TaskTimer {
  _idleStart: number;
}

interface Task extends TaskTimer {
  readonly callback: Callback;
  readonly args: readonly unknown[];
  due: boolean;
  cleared: boolean;
}

type ImmediateHandle = ReturnType<typeof setImmediate>;
type TimeoutHandle = Parameters<typeof clearTimeout>[0];

export interface TaskScheduler {
  readonly taskTimer: (callback: Callback, delayMs: number, ...args: unknown[]) => TaskTimer;
  /** The immediates scheduled and not yet run. */
  readonly pendingImmediates: () => number;
}

/** The platform's own timer functions, called as plain functions: workerd refuses any other receiver. */
const native = {
  setImmediate: globalThis.setImmediate,
  clearImmediate: globalThis.clearImmediate,
  clearTimeout: globalThis.clearTimeout,
};

class TaskScope {
  readonly #pending = new Set<ImmediateHandle>();
  readonly #queue: Task[] = [];
  #pumpHandle: ImmediateHandle | undefined;

  readonly taskTimer = (callback: Callback, delayMs: number, ...args: unknown[]): TaskTimer => {
    const task: Task = { callback, args, due: false, cleared: false, _idleStart: 0 };
    this.#queue.push(task);
    setTimeout(() => {
      task.due = true;
      // Whatever is at the head, not only this task: the head may have come due while a pump was
      // armed by a request that has since ended, and then nothing else is coming to move it.
      // `#pump` decides for itself whether anything may run.
      this.#pump();
    }, delayMs);
    return task;
  };

  readonly pendingImmediates = (): number => this.#pending.size;

  readonly setImmediate = (callback: Callback, ...args: unknown[]): ImmediateHandle => {
    const { setImmediate } = native;
    const handle: ImmediateHandle = setImmediate(
      (...inner: unknown[]) => {
        if (this.#pending.delete(handle)) {
          callback(...inner);
        }
      },
      ...args,
    );
    this.#pending.add(handle);
    return handle;
  };

  readonly clearImmediate = (handle: ImmediateHandle): void => {
    this.#pending.delete(handle);
  };

  readonly clearTask = (handle: Task): void => {
    handle.cleared = true;
  };

  /**
   * Arm the pump, replacing whatever was armed before.
   *
   * A boolean would be enough if every immediate ran, and one does not: workerd cancels the
   * immediates of a request that has finished, and a cancelled one never runs its callback. A
   * marker only that callback clears therefore stays set for good once its request is over, and
   * on the scope requests share (`#scope`) that leaves the queue with nothing to pump it — a
   * later task waits on no timer and no I/O, which workerd ends as a Worker that "had hung and
   * would never generate a response". Arming by handle instead lets the next request arm its own,
   * and the two other halves of that liveness are here too: what was outstanding when a pump was
   * armed is dropped once that pump has run, since workerd runs immediates in the order they were
   * scheduled and one still outstanding then is one that was cancelled; and a task coming due
   * pumps whatever is at the head rather than only itself, since the head may be a task nothing
   * else will move.
   */
  #schedulePump(): void {
    const { setImmediate } = native;
    // Everything outstanding now is scheduled before this pump, and workerd runs immediates in
    // the order they were scheduled: each of these runs before the pump does, or never will.
    const armedOver = [...this.#pending];
    // The one armed before is left alone rather than cleared: its native handle belongs to the
    // request that scheduled it, and touching another request's I/O is itself an error. Its
    // callback, if it ever runs, finds it is no longer the armed one and does nothing.
    const handle: ImmediateHandle = setImmediate(() => {
      if (this.#pumpHandle !== handle) {
        return;
      }
      this.#pumpHandle = undefined;
      for (const outstanding of armedOver) {
        // Still outstanding, having been scheduled before a pump that has now run: its callback
        // was cancelled with the request that scheduled it and is not coming. Counting it would
        // hold every later task behind a turn that already happened.
        this.#pending.delete(outstanding);
      }
      this.#pump();
    });
    this.#pumpHandle = handle;
  }

  /** Run the first task, once it is due and nothing scheduled before it is still to run. */
  #pump(): void {
    while (this.#queue[0]?.cleared === true) {
      this.#queue.shift();
    }
    const next = this.#queue[0];
    if (next?.due !== true) {
      return;
    }
    if (this.#pending.size > 0) {
      this.#schedulePump();
      return;
    }
    this.#queue.shift();
    try {
      next.callback(...next.args);
    } finally {
      if (this.#queue.length > 0) {
        this.#schedulePump();
      }
    }
  }
}

/** Queues belong to the render that owns their native timers and I/O context. */
class Scheduler implements TaskScheduler {
  readonly #storage = new AsyncLocalStorage<TaskScope>();
  readonly #fallback = new TaskScope();
  readonly #immediates = new WeakMap<ImmediateHandle, TaskScope>();
  readonly #tasks = new WeakMap<TaskTimer, TaskScope>();

  readonly taskTimer = (callback: Callback, delayMs: number, ...args: unknown[]): TaskTimer => {
    const scope = this.#scope();
    const task = scope.taskTimer(callback, delayMs, ...args);
    this.#tasks.set(task, scope);
    return task;
  };

  readonly pendingImmediates = (): number => this.#scope().pendingImmediates();

  constructor() {
    const { clearImmediate, clearTimeout } = native;
    Reflect.set(globalThis, 'setImmediate', (callback: Callback, ...args: unknown[]) => {
      const scope = this.#scope();
      const handle = scope.setImmediate(callback, ...args);
      this.#immediates.set(handle, scope);
      return handle;
    });
    Reflect.set(globalThis, 'clearImmediate', (handle: ImmediateHandle) => {
      const scope = this.#immediates.get(handle);
      if (scope !== undefined) {
        // Next.js's shared import signal can cancel an immediate from another request. workerd
        // owns its native handle in that request's I/O context; only its callback may touch it.
        // Removing it here makes that callback a no-op without crossing the context boundary.
        scope.clearImmediate(handle);
        return;
      }
      clearImmediate(handle);
    });
    Reflect.set(globalThis, 'clearTimeout', (handle: TimeoutHandle | Task) => {
      const scope = typeof handle === 'object' ? this.#tasks.get(handle as Task) : undefined;
      if (scope !== undefined) {
        scope.clearTask(handle as Task);
        return;
      }
      clearTimeout(handle as TimeoutHandle);
    });
  }

  #scope(): TaskScope {
    return this.#storage.getStore() ?? this.#fallback;
  }

  run<T>(work: () => Promise<T>): Promise<T> {
    return this.#storage.run(new TaskScope(), work);
  }
}

const shared: { scheduler: Scheduler | undefined } = { scheduler: undefined };

/** Keep a render's tasks out of other concurrent requests' native I/O contexts. */
export function runWithTaskScheduler<T>(work: () => Promise<T>): Promise<T> {
  return scheduler().run(work);
}

function scheduler(): Scheduler {
  if (shared.scheduler === undefined) {
    const installed = new Scheduler();
    Reflect.set(globalThis, TASK_TIMER, installed.taskTimer);
    shared.scheduler = installed;
  }
  return shared.scheduler;
}

/** Put the scheduler in place, once per isolate, and hand it out. */
export function installTaskScheduler(): TaskScheduler {
  return scheduler();
}
