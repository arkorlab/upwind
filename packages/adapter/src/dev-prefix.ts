import {
  isUpwindInternalPath,
  UPWIND_DEV_ADDRESS_ENV,
  UPWIND_INTERNAL_PREFIX,
} from '@stayingupwind/core/paas';
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
  // A path, a query or a fragment is something `URL.origin` would drop without a word, and the
  // reservation would then send `/__upwind` somewhere other than what the variable said. Refused
  // rather than trimmed: whoever wrote it meant something this cannot do.
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error(
      `@stayingupwind/adapter: ${UPWIND_DEV_ADDRESS_ENV} has to be an origin and nothing more, so no path, query or fragment: ${JSON.stringify(address)}`,
    );
  }
  // An IPv6 literal is not something a rewrite destination can carry: Next.js compiles one with
  // path-to-regexp, which reads the colons as parameter names, and what that breaks is the route
  // resolution of every request rather than this line. `upwind dev` never writes one — a hand-set
  // value can, and is told here instead.
  if (url.hostname.includes(':')) {
    throw new Error(
      `@stayingupwind/adapter: ${UPWIND_DEV_ADDRESS_ENV} cannot be an IPv6 address, because Next.js cannot compile one into a rewrite: ${JSON.stringify(address)}`,
    );
  }
  return url.origin;
}

/**
 * A rule of the project's own, with a destination that names this prefix pointed at the front door.
 *
 * This is what closes the one hole a reservation cannot: a rule that *produces* the prefix, whose
 * result Next.js resolves without re-entering any rewrite phase, and which a dynamic route of the
 * project's would then claim. Rules come from the config, dynamic routes come from the build, and
 * nothing can be put in front of the latter — so the destination is changed where it is written
 * instead, which is also where the project said what it meant: send this to `/__upwind`.
 *
 * Two destinations are left alone. One that names a host is already somebody else's to answer, and not
 * Next.js's routing to intercept. And under a `basePath`, an internal destination is resolved beneath
 * it unless the rule says `basePath: false` — `/__upwind/report` in a project based at `/docs` means
 * `/docs/__upwind/report`, which is the application's own path and says nothing about this prefix.
 */
function pointAtFrontDoor(rule: RewriteRule, origin: string, basePath: string): RewriteRule {
  const { destination } = rule;
  if (!destination.startsWith('/')) {
    return rule;
  }
  if (basePath !== '' && rule.basePath !== false) {
    return rule;
  }
  // The path alone decides; a query or a fragment travels with it untouched.
  const cut = destination.search(/[?#]/u);
  const [pathname, rest] =
    cut === -1 ? [destination, ''] : [destination.slice(0, cut), destination.slice(cut)];
  if (!isUpwindInternalPath(pathname)) {
    return rule;
  }
  return { ...rule, destination: `${origin}${pathname}${rest}` };
}

/** The prefix itself, and everything under it. Both, because one rule cannot say both. */
function reservation(origin: string): RewriteRule[] {
  const destination = `${origin}${UPWIND_INTERNAL_PREFIX}`;
  // `basePath: false` and `locale: false` for one reason between them: the front door answers this
  // prefix at the root and nowhere else, whatever the application's base path is and whatever locales
  // it has, so the reservation has to name exactly the paths the front door claims. Without
  // `locale: false`, Next.js would expand the source across every locale of an `i18n` project and the
  // reservation would take `/fr/__upwind` — a path that is the application's.
  const scope = { basePath: false, locale: false } as const;
  return [
    { source: UPWIND_INTERNAL_PREFIX, destination, ...scope },
    { source: `${UPWIND_INTERNAL_PREFIX}/:path*`, destination: `${destination}/:path*`, ...scope },
  ];
}

/**
 * The project's `rewrites`, with the reservation ahead of whatever it declared — or the project's
 * own, untouched, when no `upwind dev` is in front of this server.
 */
export function reserveUpwindPrefix(
  rewrites: RewritesFn | undefined,
  basePath: string | undefined,
): RewritesFn | undefined {
  const address = process.env[UPWIND_DEV_ADDRESS_ENV];
  if (address === undefined || address === '') {
    return rewrites;
  }
  // Read now rather than when the rewrites are resolved, so an address that cannot be one fails while
  // the config is being loaded — which is where a message about the environment belongs.
  const origin = originOf(address);
  return async (): Promise<Rewrites> => {
    const declared = await rewrites?.();
    // A list of its own per phase, rules included: three keys holding one array — or one rule object —
    // would be three places a single edit downstream could turn up in.
    if (declared === undefined) {
      return {
        beforeFiles: reservation(origin),
        afterFiles: reservation(origin),
        fallback: reservation(origin),
      };
    }
    const own = (rules: RewriteRule[] | undefined): RewriteRule[] =>
      (rules ?? []).map((rule) => pointAtFrontDoor(rule, origin, basePath ?? ''));
    if (Array.isArray(declared)) {
      // An array is `afterFiles` to Next.js, and stays one here.
      return {
        beforeFiles: reservation(origin),
        afterFiles: [...reservation(origin), ...own(declared)],
        fallback: reservation(origin),
      };
    }
    if (!isRewriteLists(declared)) {
      // Next.js will refuse this shape and name the key that made it do so. Handing it back as it
      // came keeps that message about the project's own declaration.
      return declared;
    }
    // Two things at once. The reservation goes at the head of all three phases, so the prefix is taken
    // wherever a request carrying it enters Next.js's routing. And every rule of the project's own that
    // *sends* something to the prefix is pointed at the front door instead (`pointAtFrontDoor`), since
    // Next.js re-enters no phase for a path it has just rewritten and a dynamic route of the project's
    // would otherwise claim it.
    //
    // One case is left, and is named here rather than papered over: an escaped spelling —
    // `/%5F%5Fupwind` — produced inside Next.js. A rewrite's `source` is matched against the raw
    // pathname, and the spellings of an escape are unbounded, so no set of rules covers them. The front
    // door decodes, so nothing a *client* sends reaches the application under this prefix; what remains
    // is a project rewriting to its own escaped form of it, which is the project's to mean.
    return {
      ...declared,
      beforeFiles: [...reservation(origin), ...own(declared.beforeFiles)],
      afterFiles: [...reservation(origin), ...own(declared.afterFiles)],
      fallback: [...reservation(origin), ...own(declared.fallback)],
    };
  };
}
