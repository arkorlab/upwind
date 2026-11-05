import type { DeploymentBundle, Prerender } from '@stayingupwind/core/bundle';
import {
  isPublicationTag,
  parseCacheTagsHeader,
  publicationForRoute,
  resourceSnapshotOf,
  type PublicationRequirement,
} from '@stayingupwind/core/cache';
import type { RouteEntry } from '@stayingupwind/core/manifest';

export function unsupportedPublication(input: {
  readonly publication?: PublicationRequirement | undefined;
  readonly bundle: Pick<DeploymentBundle, 'publicationGrants'>;
}): string | undefined {
  if (input.publication === undefined) return undefined;
  return input.bundle.publicationGrants === 1
    ? undefined
    : 'Publication grants require a bundle with an enforcing Function runtime.';
}

/** Essential source proof is never part of the optional build-membership budget. */
function sourceTags(source: Prerender): string[] {
  if (source.initialHeaders === undefined) return [];
  const tags: string[] = [];
  for (const [name, value] of Object.entries(source.initialHeaders)) {
    if (name.toLowerCase() !== 'x-next-cache-tags') continue;
    tags.push(...parseCacheTagsHeader(Array.isArray(value) ? value.join(',') : value));
  }
  return tags.filter((tag) => isPublicationTag(tag) || resourceSnapshotOf(tag) !== undefined);
}

/** Source route identities are sealed beside the post-staging publication requirement. */
export function publicationFields(
  requirement: PublicationRequirement | undefined,
  bundle: DeploymentBundle,
  routes: readonly RouteEntry[],
): { readonly routes: readonly RouteEntry[]; readonly publication?: PublicationRequirement } {
  if (requirement === undefined) return { routes };
  const sources = new Map(bundle.prerenders.map((prerender) => [prerender.id, prerender]));
  return {
    publication: requirement,
    routes: routes.map((entry) => {
      const source = sources.get(entry.prerenderId ?? '');
      if (source === undefined) return entry;
      return {
        ...entry,
        ...(entry.cache !== undefined && { cache: { ...entry.cache, route: source.route } }),
        ...(publicationForRoute(requirement, source.route) !== undefined && {
          publication: { route: source.route, tags: sourceTags(source) },
        }),
      };
    }),
  };
}
