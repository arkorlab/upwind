/**
 * The one path under upwind's prefix that belongs to the application.
 *
 * `/__upwind` is upwind's (`dev.ts`): the front door answers it, the adapter reserves it inside
 * Next.js's routing, and nothing a project writes can be reached through it. This is the exception,
 * and it is deliberate — authentication is the project's, and it is served by a route the project
 * builds, but the path it is served at is upwind's to choose so that a project starting out has one
 * less thing to name.
 *
 * So the prefix has two halves now, and both sides of the seam import from here: the front door
 * hands this subtree to Next.js instead of answering it, and the adapter's reservation leaves the
 * same subtree out. If either drifted, a request would arrive at the half that does not serve it —
 * or, worse, at both: the reservation sends `/__upwind/…` to the front door, and a front door that
 * handed it back to Next.js would be a loop with a request in it.
 */

/**
 * Where an application's authentication is served, unless it says otherwise.
 *
 * Under upwind's prefix rather than at `/api/auth`, so that it cannot collide with a route the
 * project has or will write, and so that the handler can be put there without asking. A project
 * that sets a base path of its own takes the mounting back (`@stayingupwind/auth`), and then
 * nothing here applies to it: the paths it chose are the application's own.
 */
export const UPWIND_AUTH_BASE_PATH = '/__upwind/auth';

/**
 * The signing key upwind generated for a project that named none, as the application reads it off
 * the environment.
 *
 * A name of its own, and not `AUTH_SECRET`, for one reason: what decides whether a project is
 * configured at all is whether the *developer* set `BETTER_AUTH_SECRET` or `AUTH_SECRET`
 * (`@stayingupwind/auth`). A generated value written to either of those names would answer that
 * question with its own existence — upwind would provide a secret, see a secret, and conclude the
 * project was configured. So the generated one is kept apart and read last.
 *
 * `upwind dev` and `upwind build` write it; it is kept under `.upwind/`, beside the project's local
 * storage, because it is the same kind of thing — this machine's own, rebuilt by deleting it, and
 * never a deployment's. A deployment sets `AUTH_SECRET` and this is not read at all.
 */
export const UPWIND_AUTH_SECRET_ENV = 'UPWIND_AUTH_SECRET';

/**
 * Is `pathname` the authentication base path, or a path under it?
 *
 * `/__upwind/authorize` is neither — the same rule as `isUpwindInternalPath`, for the same reason:
 * a prefix match alone would take a path from whichever side does not own it.
 *
 * The path as written, and no normalising. An escaped spelling of this subtree — `/__upwind/%61uth`
 * — is not this subtree, and the reason is on the other side of the seam: the adapter excludes this
 * path from its reservation through a rewrite pattern, and a rewrite's `source` is matched raw. It
 * can name `auth`; it cannot name every encoding of `auth`. A caller that normalised here while the
 * reservation did not would send the request round between the two. `upwind dev` says the same thing
 * from its end (`serve.ts`).
 */
export function isUpwindAuthPath(pathname: string): boolean {
  return pathname === UPWIND_AUTH_BASE_PATH || pathname.startsWith(`${UPWIND_AUTH_BASE_PATH}/`);
}
