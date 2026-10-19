import type { BuildProjectManifestInput } from './manifest.ts';
import { pageKeyOf } from './page-keys.ts';
import type { ProjectManifest, RouteBodyEntry, RouteEntry } from './schema.ts';

/** A separate table of complete responses, all bound to the manifest's cache authority. */
export function routeBodyFields(
  input: BuildProjectManifestInput,
  routes: Readonly<Record<string, RouteEntry>>,
): Pick<ProjectManifest, 'routeBodies' | 'exactPathnames'> {
  if (input.routeBodies === undefined || input.routeBodies.length === 0) {
    return {};
  }
  if (input.cache === undefined) {
    throw new Error('route bodies need the manifest cache authority');
  }
  const bodies: Record<string, RouteBodyEntry> = {};
  for (const entry of input.routeBodies) {
    if (Object.hasOwn(routes, entry.pathname) || Object.hasOwn(bodies, entry.pathname)) {
      throw new Error(`route body ${entry.pathname} is already named by a route`);
    }
    bodies[entry.pathname] = entry;
  }
  // Built once: every response lookup must use the same filesystem winner, including a page
  // with no hosted response. Constructing this union while classifying would delay every byte.
  const exactPathnames: Record<string, true> = Object.fromEntries(
    (input.exactPathnames ?? []).map((pathname) => [pathname, true as const]),
  );
  for (const pathname of Object.keys(routes)) {
    exactPathnames[pathname] = true;
  }
  for (const pathname of Object.keys(bodies)) {
    exactPathnames[pathname] = true;
  }
  return { routeBodies: bodies, exactPathnames };
}

/** An exact route body, under the same pathname spelling rules as a document route. */
export function findRouteBody(
  manifest: ProjectManifest,
  pathname: string,
): RouteBodyEntry | undefined {
  const { routeBodies } = manifest;
  if (routeBodies === undefined || manifest.exactPathnames === undefined) {
    return undefined;
  }
  const key = pageKeyOf(manifest.exactPathnames, pathname, manifest);
  const entry = key === undefined ? undefined : routeBodies[key];
  return entry?.pathname === key ? entry : undefined;
}
