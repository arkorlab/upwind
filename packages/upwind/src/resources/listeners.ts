/**
 * What starting the local runtime does to this process, and how to undo it.
 *
 * Miniflare's exit hook is a good citizen of a process it owns: it listens for the signals that end
 * one, and for the `message` a parent sends to ask, so that it can kill the runtime before going.
 * Neither is its decision to make here, and the `message` one is actively dangerous — so this module
 * holds the ground while the runtime starts and hands it back afterwards.
 *
 * It is separate from `local.ts` because the order matters more than anything else here does, and
 * because none of it is about storage.
 */

/** A listener, by identity alone: what it is called with is not this module's business. */
type ProcessListener = (...args: unknown[]) => void;

/**
 * `process` as the event emitter it is.
 *
 * Its typings describe these in terms of signals, and the event that matters most here is `message`,
 * which is not one.
 */
const processEvents = process as unknown as {
  listeners: (event: string) => ProcessListener[];
  removeListener: (event: string, listener: ProcessListener) => void;
  emit: (event: string, ...args: unknown[]) => boolean;
};

/**
 * The IPC channel's own event, and the runtime's listener for it that is never this process's to keep.
 *
 * A channel is *started* by the first `message` listener attached to it, and from then on every
 * message the parent sends is delivered to whoever is listening — so a listener added before the
 * process's own receives the parent's first instructions and drops them. In `next build`'s render
 * worker that is fatal and silent: the worker is asked to initialise and to render, hears neither,
 * and waits for work that already came, while the build waits for a worker that will never answer.
 * It is why a build hangs rather than failing, and it took a while to find.
 */
const MESSAGE = 'message';

/**
 * The signals the runtime answers that a process may want back — and only the ones it answers
 * itself.
 *
 * The runtime ends the process from inside each of `SIGINT`, `SIGTERM` and `SIGHUP`, after killing
 * the runtime. `upwind dev` wants the first two back: it closes its port, lets Next.js shut down, and
 * leaves with the 0 that a script which stopped it on purpose reads. `SIGHUP` it does not answer, so
 * `SIGHUP` is not taken — a terminal closing on a dev server would otherwise end it with no listener
 * at all, which runs no exit hook and leaves a runtime process behind.
 *
 * A build's render worker wants none of them back: the pool ends a worker with `SIGTERM`
 * (`jest-worker`, half a second after asking nicely), and the runtime's handler for it is the only
 * thing that kills the runtime then.
 */
const RUNTIME_SIGNALS: readonly string[] = ['SIGINT', 'SIGTERM'];

export interface ListenerGuard {
  /** Hand back what was held, and take back what starting the runtime attached. */
  readonly restore: () => void;
}

function listenersOf(event: string): ProcessListener[] {
  return processEvents.listeners(event);
}

/**
 * Hold anything the parent sends while the runtime is starting, and hand it on afterwards.
 *
 * Installed before anything else, so that this is the listener the channel starts for and the
 * runtime's is never the only one. What arrives in the meantime is kept rather than answered — this
 * process has no idea yet what its messages mean — and given back on the next turn of the loop, by
 * when the code that does know is listening. Nothing is lost and nothing is answered twice.
 */
function holdMessages(): () => void {
  // Only a child has a channel, and only a channel has this problem.
  if (process.send === undefined) {
    return () => {
      // Nothing was held.
    };
  }
  const held: unknown[][] = [];
  const hold = (...args: unknown[]): void => {
    held.push(args);
  };
  process.on(MESSAGE, hold);
  return () => {
    processEvents.removeListener(MESSAGE, hold);
    if (held.length === 0) {
      return;
    }
    // On the next turn: this runs while the module that owns this process is still being loaded, and
    // its own listener is attached by the end of that.
    setImmediate(() => {
      for (const args of held) {
        processEvents.emit(MESSAGE, ...args);
      }
    });
  };
}

/**
 * Take back what starting the runtime attached to this process.
 *
 * Only listeners that appeared while it was starting are removed, and by identity, so nothing else
 * listening for those events is touched.
 *
 * Its `exit` hook is left exactly as it is, and is load-bearing: that one kills the runtime process
 * outright on any exit, which is what reaps it when this process leaves without being asked to —
 * `upwind dev` restarting itself on a config change, or Next.js's error overlay restarting it from
 * inside, neither of which is a shutdown anything here ever hears about.
 */
function takeBack(before: ReadonlyMap<string, ReadonlySet<ProcessListener>>): void {
  for (const [event, had] of before) {
    for (const listener of listenersOf(event)) {
      if (!had.has(listener)) {
        processEvents.removeListener(event, listener);
      }
    }
  }
}

/**
 * Hold the ground before the runtime is started; `restore` gives it back.
 *
 * `answersSignals` is whether this process ends itself, and so wants the runtime's signal handlers
 * taken back too. The dev server does; a process something else ends does not.
 */
export function guardListeners(options: { readonly answersSignals: boolean }): ListenerGuard {
  // Held first, so that this listener is one of the ones taken as given below and `handOn` is what
  // removes it — rather than `takeBack` mistaking it for the runtime's.
  const handOn = holdMessages();
  const events = options.answersSignals ? [MESSAGE, ...RUNTIME_SIGNALS] : [MESSAGE];
  const before = new Map(events.map((event) => [event, new Set(listenersOf(event))]));
  return {
    restore: () => {
      takeBack(before);
      handOn();
    },
  };
}
