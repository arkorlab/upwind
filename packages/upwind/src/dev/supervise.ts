import { fork } from 'node:child_process';
import { once } from 'node:events';

import { RESTART_EXIT_CODE } from './restart.ts';

/**
 * The parent of a run: it starts the server, and starts it again when it asks to be restarted.
 *
 * `next dev` is two processes for this reason — a restart means a new process, because what has to be
 * thrown away is everything the old one loaded. The same is true here, so `upwind dev` forks itself:
 * the child is the same binary with `UPWIND_DEV_WORKER` set, and it does the serving.
 *
 * Nothing but the restart is interpreted. The child's output is the terminal's, its exit code is this
 * process's, and a signal is passed down and waited for — a supervisor that summarised its child
 * would be one more thing between a developer and their own server.
 */

/** Set on the child, and what tells the same binary which of the two it is. */
export const WORKER_ENV = 'UPWIND_DEV_WORKER';

/** How long a child has to end on its own after a signal, before it is killed outright. */
const EXIT_GRACE_MS = 2000;

interface Outcome {
  /** The child's own exit code, or nothing when a signal ended it before it could choose one. */
  readonly code: number | null;
  /** Whether this process passed a signal down: then the child's end was asked for, not its own. */
  readonly asked: boolean;
}

/** One child, from fork to exit. */
async function runChild(entry: string, args: readonly string[]): Promise<Outcome> {
  let asked = false;
  const child = fork(entry, [...args], {
    env: { ...process.env, [WORKER_ENV]: '1' },
    stdio: 'inherit',
  });
  const forward = (signal: NodeJS.Signals): void => {
    // A restart after this is not a restart; it is a server the developer asked to stop coming back
    // to life.
    asked = true;
    child.kill(signal);
    const overdue = setTimeout(() => {
      child.kill('SIGKILL');
    }, EXIT_GRACE_MS);
    // The wait for the child is what holds this process open; this timer must not.
    overdue.unref();
  };
  const onInterrupt = (): void => {
    forward('SIGINT');
  };
  const onTerminate = (): void => {
    forward('SIGTERM');
  };
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);
  try {
    // `events.once` rejects if the child emits `error` instead — a fork that never started is a
    // failure of this command, and is thrown from here.
    const [code] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null];
    return { code, asked };
  } finally {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
  }
}

export async function supervise(entry: string, args: readonly string[]): Promise<void> {
  for (;;) {
    const { code, asked } = await runChild(entry, args);
    if (!asked && code === RESTART_EXIT_CODE) {
      continue;
    }
    // The child's own code, whatever ended it. A stop that was asked for is a clean one — the child
    // closes the port and leaves with 0, and `next dev` reports the same 0 for the same interruption
    // (`handleSessionStop`), which is what a script that stops this server on purpose wants to read.
    // A child that ended on a signal chose no code, and closed nothing: that is a failure.
    process.exitCode = code ?? 1;
    return;
  }
}
