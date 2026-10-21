import type { BuildProjectManifestInput } from './manifest.ts';
import { namesPagesDataPrefix, pagesDataPrefixOf } from './pages-data-prefix.ts';
import type { ProjectManifest } from './schema.ts';
const PAGES_FALLBACK_PRIVACY = 3;
/**
 * What is wrong with where the manifest says a client asks for a page's props, if anything. Props
 * no prefix names are asked for at no URL, and a base path or a build id a prefix cannot carry, or a
 * request cannot spell as written, names no request: either way every data request would go to the
 * Function, and nothing would say why. So a manifest like that is refused where it is built, as one
 * naming an unreachable Function is.
 */
export function unaddressedProps(input: BuildProjectManifestInput): string | undefined {
  const under = input.pagesDataUnder;
  if (under !== undefined && !namesPagesDataPrefix(under.basePath, under.buildId)) {
    return `pagesDataUnder names no prefix: base path ${under.basePath}, build ${under.buildId}`;
  }
  if (
    under === undefined &&
    (input.routes.some((route) => route.pagesData !== undefined) ||
      input.staticPages?.some((page) => page.staticPagePrivacy === PAGES_FALLBACK_PRIVACY) ===
        true ||
      (input.pagesFallbacks?.length ?? 0) > 0)
  ) {
    return "routes hold a page's props (pagesData), and no pagesDataUnder says where a client asks for them";
  }
  return undefined;
}

/**
 * Where a client asks for props, where a route holds some (`RouteEntry.pagesData`): the prefix as a
 * request spells it, and the base path it is under, as the build wrote it, for naming the page a
 * request asks for; neither where no route's props sit under them, so that the fields say what
 * they say.
 */
export function pagesDataFields(
  input: BuildProjectManifestInput,
): Pick<ProjectManifest, 'pagesDataBasePath' | 'pagesDataPrefix'> {
  const under = input.pagesDataUnder;
  if (
    under === undefined ||
    (input.routes.every((route) => route.pagesData === undefined) &&
      input.staticPages?.some((page) => page.staticPagePrivacy === PAGES_FALLBACK_PRIVACY) !==
        true &&
      (input.pagesFallbacks?.length ?? 0) === 0)
  ) {
    return {};
  }
  return {
    pagesDataPrefix: pagesDataPrefixOf(under.buildId, under.basePath),
    ...(under.basePath !== '' && { pagesDataBasePath: under.basePath }),
  };
}
