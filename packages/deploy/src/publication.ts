import type { DeploymentBundle } from '@stayingupwind/core/bundle';
import type { PublicationRequirement } from '@stayingupwind/core/cache';
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

/** Source route identities are sealed beside the post-staging publication requirement. */
export function publicationFields(
  requirement: PublicationRequirement | undefined,
  bundle: DeploymentBundle,
  routes: readonly RouteEntry[],
): { readonly routes: readonly RouteEntry[]; readonly publication?: PublicationRequirement } {
  if (requirement === undefined) return { routes };
  const sources = new Map(bundle.prerenders.map((prerender) => [prerender.id, prerender.route]));
  return {
    publication: requirement,
    routes: routes.map((entry) => {
      const source = sources.get(entry.prerenderId ?? '');
      return source === undefined || entry.cache === undefined
        ? entry
        : { ...entry, cache: { ...entry.cache, route: source } };
    }),
  };
}
