/**
 * The path `upwind dev` answers itself, and how the adapter learns where that server is.
 *
 * A deployment has an edge in front of it, and the platform's own paths are the edge's to serve.
 * Under `next dev` there is no edge, so `upwind dev` is the front door: it listens on the port the
 * developer asked for, answers this prefix itself, and hands everything else to Next.js. Both sides
 * of that arrangement import the names from here — the CLI that listens, and the adapter that
 * reserves the same prefix inside Next.js's own routing table — so neither can drift from the other.
 */

/** The prefix `upwind dev` answers: the path itself, and everything under it. */
export const UPWIND_INTERNAL_PREFIX = '/__upwind';

/**
 * Where `upwind dev` is listening, as the adapter reads it off the environment
 * (`http://127.0.0.1:3000`).
 *
 * The CLI sets it in the process that loads `next.config`, which is the process the dev server runs
 * in. Absent means no upwind front door stands in front of this dev server — a plain `next dev` —
 * and the adapter then leaves the project's routing alone: a rewrite to a port nothing listens on
 * would be worse than no reservation at all.
 */
export const UPWIND_DEV_ADDRESS_ENV = 'UPWIND_DEV_ADDRESS';

/**
 * That this build has a project's local storage in it, as the adapter reads it off the environment.
 *
 * `upwind build` sets it, and what the adapter does about it is render the pages in one process
 * (`experimental.cpus`). A directory of local storage belongs to one runtime at a time, and a build
 * that rendered in six processes would be six runtimes over one directory — so the only build that
 * can read storage while it prerenders is a build that renders in one place.
 *
 * Absent — a plain `next build`, or an `upwind build` in a project that has no way to read storage —
 * and the adapter leaves the project's own worker count exactly as it is.
 */
export const UPWIND_LOCAL_RESOURCES_ENV = 'UPWIND_LOCAL_RESOURCES';

/**
 * Is `pathname` the internal prefix, or a path under it?
 *
 * `/__upwindfoo` is neither. A prefix match alone would take a path the application may own, and
 * the front door would answer for a page the developer wrote.
 */
export function isUpwindInternalPath(pathname: string): boolean {
  return pathname === UPWIND_INTERNAL_PREFIX || pathname.startsWith(`${UPWIND_INTERNAL_PREFIX}/`);
}

/** Downloaded host registrations used by local development and builds. */
export const UPWIND_DURABLE_OBJECTS_ENV = 'UPWIND_DURABLE_OBJECTS';
