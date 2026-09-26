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
  console.log(`upwind: ${reason}; restarting...`);
  process.exit(RESTART_EXIT_CODE);
}
