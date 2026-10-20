import type { BuildProjectManifestInput } from './manifest.ts';
import { pageKeyOf } from './page-keys.ts';
import type { ProjectManifest, RouteEntry, StaticPageEntry } from './schema.ts';

/** Build once; a request reuses the same filesystem winner as documents and route bodies. */
export function staticPageFields(
  input: BuildProjectManifestInput,
  routes: Readonly<Record<string, RouteEntry>>,
): Pick<ProjectManifest, 'staticPages' | 'exactPathnames'> {
  if (input.staticPages === undefined || input.staticPages.length === 0) return {};
  if (input.cache === undefined) throw new Error('static pages need the manifest cache authority');
  const pages: Record<string, StaticPageEntry> = {};
  const bodies = new Set(input.routeBodies?.map((entry) => entry.pathname));
  for (const entry of input.staticPages) {
    if (Object.hasOwn(pages, entry.pathname) || bodies.has(entry.pathname)) {
      throw new Error(`static page ${entry.pathname} is already named`);
    }
    const route = routes[entry.pathname];
    if (
      route === undefined ||
      route.cache?.kind !== 'pages' ||
      route.cache.delivery !== 'complete' ||
      route.cache.entryId !== entry.entryId ||
      route.function !== entry.function ||
      (route.cache.route !== undefined && route.cache.route !== entry.route)
    ) {
      throw new Error(`static page ${entry.pathname} disagrees with its document authority`);
    }
    pages[entry.pathname] = entry;
  }
  const keys = [
    ...(input.exactPathnames ?? []),
    ...Object.keys(routes),
    ...bodies,
    ...Object.keys(pages),
  ];
  return {
    staticPages: pages,
    exactPathnames: Object.fromEntries(keys.map((key) => [key, true as const])),
  };
}

/** A lookup cannot grant a different table entry authority through an alias key. */
export function findStaticPage(
  manifest: ProjectManifest,
  pathname: string,
): StaticPageEntry | undefined {
  if (manifest.staticPages === undefined || manifest.exactPathnames === undefined) return undefined;
  const key = pageKeyOf(manifest.exactPathnames, pathname, manifest);
  const entry = key === undefined ? undefined : manifest.staticPages[key];
  return entry?.pathname === key ? entry : undefined;
}
