import { UPWIND_DEV_ADDRESS_ENV, UPWIND_INTERNAL_PREFIX } from '@stayingupwind/core/paas';
import type { NextAdapter } from 'next';

/**
 * `/__upwind`, reserved inside a development server's own routing table.
 *
 * `upwind dev` is the front door: it holds the port, answers this prefix itself, and hands
 * everything else to Next.js. So in the ordinary case *nothing* here ever fires — the request has
 * already been answered before Next.js is asked. What it is for is the paths back in: a request the
 * application's own middleware rewrites to `/__upwind/…`, or one Next.js makes of itself, arrives at
 * the router rather than at the front door, and without a reservation a page the project happens to
 * have written under that prefix would answer it. A rule in `beforeFiles` comes before the
 * filesystem, so the prefix belongs to upwind wherever a request reaches the router from.
 *
 * Read from the environment rather than configured, because the address is not something a project
 * writes: `upwind dev` knows the port it settled on and sets it in the process that loads
 * `next.config`. A dev server with no upwind in front of it has no such variable, and then nothing
 * here touches the project's routing at all — a rewrite to a port nothing listens on would be worse
 * than no reservation.
 */

type NextConfig = Parameters<NonNullable<NextAdapter['modifyConfig']>>[0];
/** `next.config`'s `rewrites`, and the shapes Next.js lets it answer with. */
type RewritesFn = NonNullable<NextConfig['rewrites']>;
type Rewrites = Awaited<ReturnType<RewritesFn>>;
type RewriteRule = Extract<Rewrites, readonly unknown[]>[number];
type RewriteLists = Exclude<Rewrites, readonly unknown[]>;

/** The three lists a project may name; anything else makes the value `afterFiles` (`loadRewrites`). */
const LIST_NAMES: ReadonlySet<string> = new Set(['afterFiles', 'beforeFiles', 'fallback']);

/**
 * Is this the object form — `{ beforeFiles, afterFiles, fallback }` — as Next.js decides it?
 *
 * The same test `loadRewrites` makes, down to `{}` counting as the object form: an object naming a
 * key that is none of the three is read by Next.js as a list of rules and refused with a message
 * about it, and this must not disagree about which shape it was looking at.
 */
function isRewriteLists(declared: Rewrites): declared is RewriteLists {
  return !Array.isArray(declared) && Object.keys(declared).every((key) => LIST_NAMES.has(key));
}

/**
 * The address as a rewrite destination can carry it: an origin, with no path of its own.
 *
 * `upwind dev` writes this variable itself, so the normal case needs no repair. A hand-set one might
 * carry a trailing slash, which `URL.origin` drops, or be no address at all — and that is refused
 * here, where the message can name the variable, rather than at Next.js's route validation, which
 * would report a rewrite the project never wrote.
 */
function originOf(address: string): string {
  let url;
  try {
    url = new URL(address);
  } catch {
    throw new Error(
      `@stayingupwind/adapter: ${UPWIND_DEV_ADDRESS_ENV} is not a URL: ${JSON.stringify(address)}`,
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(
      `@stayingupwind/adapter: ${UPWIND_DEV_ADDRESS_ENV} has to be an http(s) address: ${JSON.stringify(address)}`,
    );
  }
  return url.origin;
}

/** The prefix itself, and everything under it. Both, because one rule cannot say both. */
function reservation(origin: string): RewriteRule[] {
  const destination = `${origin}${UPWIND_INTERNAL_PREFIX}`;
  return [
    // `basePath: false`: the front door answers `/__upwind` at the root, whatever the application's
    // own base path is, so the reservation has to name the same path the front door does.
    { source: UPWIND_INTERNAL_PREFIX, destination, basePath: false },
    {
      source: `${UPWIND_INTERNAL_PREFIX}/:path*`,
      destination: `${destination}/:path*`,
      basePath: false,
    },
  ];
}

/**
 * The project's `rewrites`, with the reservation ahead of whatever it declared — or the project's
 * own, untouched, when no `upwind dev` is in front of this server.
 */
export function reserveUpwindPrefix(rewrites: RewritesFn | undefined): RewritesFn | undefined {
  const address = process.env[UPWIND_DEV_ADDRESS_ENV];
  if (address === undefined || address === '') {
    return rewrites;
  }
  // Read now rather than when the rewrites are resolved, so an address that cannot be one fails while
  // the config is being loaded — which is where a message about the environment belongs.
  const origin = originOf(address);
  return async (): Promise<Rewrites> => {
    const declared = await rewrites?.();
    const rules = reservation(origin);
    if (declared === undefined) {
      return { beforeFiles: rules, afterFiles: [], fallback: [] };
    }
    if (Array.isArray(declared)) {
      // An array is `afterFiles` to Next.js, and stays one here.
      return { beforeFiles: rules, afterFiles: declared, fallback: [] };
    }
    if (!isRewriteLists(declared)) {
      // Next.js will refuse this shape and name the key that made it do so. Handing it back as it
      // came keeps that message about the project's own declaration.
      return declared;
    }
    return { ...declared, beforeFiles: [...rules, ...(declared.beforeFiles ?? [])] };
  };
}
