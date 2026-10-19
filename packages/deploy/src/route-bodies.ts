import {
  type DeploymentBundle,
  edgeServableRouteBodies,
  functionOfPrerender,
  placedRoutes,
  PRIMARY_FUNCTION,
} from '@stayingupwind/core/bundle';
import { deriveEntry } from '@stayingupwind/core/cache';
import type { RouteBodyEntry } from '@stayingupwind/core/manifest';

/**
 * Complete Node route bodies whose generations the host seeded. Only the identity travels in the
 * manifest: the authority's current record owns the bytes, headers and lifetime, so a missing or
 * expired record cannot resurrect the build's old body.
 */
export async function routeBodiesOf(
  bundle: DeploymentBundle,
  scopeId: string,
  enabled = true,
): Promise<RouteBodyEntry[]> {
  if (!enabled) return [];
  const placed = placedRoutes(bundle.entrypoints);
  const bodies: RouteBodyEntry[] = [];
  for (const prerender of edgeServableRouteBodies(bundle)) {
    const { entryId } = await deriveEntry(scopeId, {
      kind: 'app-route',
      route: prerender.route,
      pathname: prerender.pathname,
    });
    const fn = functionOfPrerender(placed, prerender);
    bodies.push({
      pathname: prerender.pathname,
      route: prerender.route,
      entryId,
      ...(prerender.bypassFor !== undefined && { bypassFor: prerender.bypassFor }),
      ...(fn !== PRIMARY_FUNCTION && { function: fn }),
    });
  }
  return bodies;
}
