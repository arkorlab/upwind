import { keyedByParameters, queryDependent } from './query.ts';
import type { Prerender } from './schema.ts';
import { placeholderSegments, standsForClass } from './spelling.ts';

/** A reusable terminal shell whose unresolved parameters stay dynamic when it is regenerated. */
export function sharedShellPathname(prerender: Prerender): string | undefined {
  return prerender.body !== undefined &&
    prerender.postponed !== undefined &&
    prerender.renderingMode === 'PARTIALLY_STATIC' &&
    prerender.routeType !== 'route' &&
    (prerender.response === undefined || prerender.response === 'initial') &&
    (prerender.compute === undefined || prerender.compute === 'resuming') &&
    prerender.partialFallback !== true &&
    standsForClass(prerender) &&
    placeholderSegments(prerender.pathname, prerender.route).includes(true) &&
    !queryDependent(prerender, prerender.route, prerender.pathname)
    ? prerender.pathname
    : undefined;
}

/**
 * The entry a shell Next.js classifies as the most specific of its class (`routeType: 'shell'`)
 * keeps for every member, where the build keys the shell by parameters it leaves open: the shell's
 * own pathname, `/page-params/[id]`. `undefined` for any other prerender.
 *
 * `next start` keeps that shell as one entry, under its own pathname, and answers each member's
 * document from it: regenerated as the shell, its open parameters deferred, behind the answer once
 * it is stale and in front of it once it has expired (`fallbackRevalidate`, `fallbackExpire`;
 * `build/templates/app-page-runtime.ts`, `server/response-cache/index.ts`). The keys the build
 * writes the shell with — every route key, where it postponed nothing (`build-complete.ts`) — say
 * nothing of what varies. Read as `queryDependent` reads keys, as ones its pathname leaves unnamed,
 * they had no generation of the shell read or made: the build's body answered every member for the
 * deployment's life, whatever was kept of the shell since. A key that names none of the route's
 * parameters still varies the entry, as it does any other.
 */
export function terminalShellPathname(prerender: Prerender): string | undefined {
  return prerender.routeType === 'shell' &&
    prerender.body !== undefined &&
    prerender.renderingMode === 'PARTIALLY_STATIC' &&
    placeholderSegments(prerender.pathname, prerender.route).includes(true) &&
    queryDependent(prerender, prerender.route, prerender.pathname) &&
    keyedByParameters(prerender)
    ? prerender.pathname
    : undefined;
}
