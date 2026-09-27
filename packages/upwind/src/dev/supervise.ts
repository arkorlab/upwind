import { fork } from 'node:child_process';
import { once } from 'node:events';
import os from 'node:os';

import { RESTART_EXIT_CODE } from './restart.ts';
import { WORKER_ENV, WORKER_PORT_ENV } from './worker-env.ts';

/**
 * The parent of a run: it starts the server, and starts it again when it asks to be restarted.
 *
 * `next dev` is two processes for this reason — a restart means a new process, because what has to be
 * thrown away is everything the old one loaded. The same is true here, so `upwind dev` forks itself:
 * the child is the same binary with `UPWIND_DEV_WORKER` set, and it does the serving.
 *
 * Nothing but the restart and the port is interpreted. The child's arguments are the ones this process
 * was given, unedited; its output is the terminal's; its exit code is this process's; and a signal is
 * passed down and waited for — a supervisor that summarised its child would be one more thing between a
 * developer and their own server.
 */

/** How long a child has to end on its own after a signal, before it is killed outright. */
const EXIT_GRACE_MS = 2000;
/** What a shell reports for a process a signal ended: 128 plus the signal's number. */
const SIGNAL_EXIT_BASE = 128;

interface Outcome {
  /** The child's own exit code, or nothing when a signal ended it before it could choose one. */
  readonly code: number | null;
  /** The signal that ended it, when one did. */
  readonly signal: NodeJS.Signals | null;
  /** Whether this process passed a signal down: then the child's end was asked for, not its own. */
  readonly asked: boolean;
  /** The port the child bound, once it had one. */
  readonly port: number | undefined;
}

/** The port a child reports, and nothing else: a message of any other shape is not this. */
function portOf(message: unknown): number | undefined {
  if (typeof message === 'object' && message !== null && 'port' in message) {
    const { port } = message;
    return typeof port === 'number' ? port : undefined;
  }
  return undefined;
}

/** The environment a child is given: this one's, plus what only a child is told. */
function childEnv(port: number | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, [WORKER_ENV]: '1' };
  if (port === undefined) {
    // Nothing is known yet, and an inherited value would be some other run's port.
    Reflect.deleteProperty(env, WORKER_PORT_ENV);
    return env;
  }
  env[WORKER_PORT_ENV] = String(port);
  return env;
}

/** One child, from fork to exit. */
async function runChild(
  entry: string,
  args: readonly string[],
  port: number | undefined,
): Promise<Outcome> {
  let asked = false;
  let bound: number | undefined;
  const child = fork(entry, [...args], { env: childEnv(port), stdio: 'inherit' });
  child.on('message', (message: unknown) => {
    bound = portOf(message) ?? bound;
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
    const [code, signal] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null];
    return { code, signal, asked, port: bound };
  } finally {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
  }
}

/**
 * What this process ends with, for a child that ended on a signal rather than on a code of its own.
 *
 * A stop this process asked for is a clean one: the child closes the port and leaves with 0, and even
 * one that had to be killed did what it was told — `next dev` reports 0 for the same interruption
 * (`handleSessionStop`), and a script that stops this server on purpose is reading for that. A signal
 * from anywhere else ended a server nobody here asked to stop, and is reported the way a shell reports
 * one, so that "killed" and "exited 1" are not the same answer.
 */
function signalExitCode(signal: NodeJS.Signals | null, asked: boolean): number {
  if (asked) {
    return 0;
  }
  const number = signal === null ? undefined : os.constants.signals[signal];
  return number === undefined ? 1 : SIGNAL_EXIT_BASE + number;
}

export async function supervise(entry: string, args: readonly string[]): Promise<void> {
  let port: number | undefined;
  for (;;) {
    // A restarted child is told which port to take, through the environment — see `worker-env.ts` for
    // why the arguments are left exactly as the developer wrote them.
    const outcome = await runChild(entry, args, port);
    // The latest binding, not the first: a child that found the retained port taken moved up and said
    // so, and the one after it has to be told where the run actually is.
    port = outcome.port ?? port;
    if (!outcome.asked && outcome.code === RESTART_EXIT_CODE) {
      continue;
    }
    process.exitCode = outcome.code ?? signalExitCode(outcome.signal, outcome.asked);
    return;
  }
}
