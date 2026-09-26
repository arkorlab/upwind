/**
 * What one `upwind dev` run knows about itself.
 *
 * Read live by the endpoints under `/__upwind`, which answer before Next.js is ready and have to say
 * so, and written by the run as each fact becomes known: the port once it is bound, the adapter once
 * it is resolved, Next.js's version once its copy is found, and `readyTick` once `prepare()` returns.
 * One mutable object rather than a snapshot, because a snapshot taken at startup would answer
 * "starting" for the rest of the session.
 *
 * Two clocks, because they answer different questions. `startedAt` is a wall-clock moment, and is
 * reported as one. Every *duration* comes from `performance.now()`, which only moves forwards: a
 * machine whose clock is corrected mid-run — a laptop waking up, a VM syncing its time — would
 * otherwise report a server that became ready before it started.
 */
export interface DevSession {
  /** The application's directory: what `next dev [dir]` would have been given. */
  readonly projectDir: string;
  /** When the run began, as a moment in time, for the report to name it. */
  readonly startedAt: number;
  /** When the run began, on the monotonic clock every duration here is measured against. */
  readonly startedTick: number;
  /** This CLI's version, or nothing if its own manifest could not be read. */
  readonly upwindVersion: string | undefined;
  /** The version of the project's own Next.js, which is the one being run. */
  nextVersion: string | undefined;
  /**
   * The adapter module named for this run through the environment, or nothing when none was found.
   * A `next.config` that sets `adapterPath` itself wins over it, by Next.js's own precedence.
   */
  adapterPath: string | undefined;
  /** Where a browser reaches this server (`http://localhost:3000`); set once the port is bound. */
  address: string | undefined;
  /** The tick `prepare()` returned on. Undefined while Next.js is still starting. */
  readyTick: number | undefined;
}

export function createSession(options: {
  readonly projectDir: string;
  readonly upwindVersion: string | undefined;
}): DevSession {
  return {
    projectDir: options.projectDir,
    startedAt: Date.now(),
    startedTick: performance.now(),
    upwindVersion: options.upwindVersion,
    nextVersion: undefined,
    adapterPath: undefined,
    address: undefined,
    readyTick: undefined,
  };
}

/** How long the run has been up, in whole milliseconds. */
export function uptimeMs(session: DevSession): number {
  return Math.round(performance.now() - session.startedTick);
}

/** How long Next.js took to become ready, or nothing while it still has not. */
export function readyInMs(session: DevSession): number | undefined {
  return session.readyTick === undefined
    ? undefined
    : Math.round(session.readyTick - session.startedTick);
}
