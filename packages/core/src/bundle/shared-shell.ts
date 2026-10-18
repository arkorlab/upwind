import { queryDependent } from './query.ts';
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
