import { writeSync } from 'node:fs';

/**
 * The exit code that means "start me again", and the one way to ask for it.
 *
 * Not ours to choose: it is `RESTART_EXIT_CODE` in `next/dist/server/lib/utils.ts`, and Next.js's own
 * dev tooling leaves with it from inside this process — the error overlay's restart button does
 * exactly that (`next-devtools/server/restart-dev-server-middleware.ts`). Under `next dev` the parent
 * process is what catches it and starts the server again; here `supervise.ts` is.
 */
export const RESTART_EXIT_CODE = 77;

/** Say why, then leave with the code the supervisor is watching for. */
export function restart(reason: string): never {
  // Written to the descriptor rather than logged: `process.exit` takes the process down with whatever
  // `console.log` had queued, and a dev server's output is often a pipe or a file. The reason a server
  // restarted is worth the one synchronous write, and losing that write is not worth the restart.
  try {
    writeSync(1, `upwind: ${reason}; restarting...\n`);
  } catch {
    // Nothing to say about not being able to say something.
  }
  process.exit(RESTART_EXIT_CODE);
}
