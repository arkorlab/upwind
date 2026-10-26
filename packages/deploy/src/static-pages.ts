import { type EncodedShellRef, shellEncodingsOf } from '@stayingupwind/core/artifact';
import {
  BuildPatternBudget,
  type BuildPatternMatcher,
  type DeploymentBundle,
  functionOfPrerender,
  pagesDataPathnameUnder,
  placedRoutes,
  type Prerender,
  PRIMARY_FUNCTION,
  shellHeaders,
  staticFallbackPagesOf,
  staticPagesMembersOf,
  staticPagesPrivacyOf,
} from '@stayingupwind/core/bundle';
import { deriveEntry } from '@stayingupwind/core/cache';
import type { PagesFallbackEntry, StaticPageEntry } from '@stayingupwind/core/manifest';

const FALLBACK_PRIVACY = 3;

/** Only current records may supply these Pages bodies; the manifest stores no body or lifetime. */
export async function staticPagesOf(
  bundle: DeploymentBundle,
  scopeId: string,
  enabled = true,
  patterns: BuildPatternMatcher = new BuildPatternBudget(),
): Promise<StaticPageEntry[]> {
  // Trailing-slash aliases need a separate canonical-path and raw-seed identity contract.
  if (!enabled || bundle.config.trailingSlash) return [];
  const placed = placedRoutes(bundle.entrypoints);
  const pages: StaticPageEntry[] = [];
  const members = staticPagesMembersOf(bundle, patterns);
  const admitted = new Map<Prerender, 1 | 2 | typeof FALLBACK_PRIVACY>(
    staticPagesPrivacyOf(bundle, patterns),
  );
  for (const [prerender] of members) admitted.set(prerender, FALLBACK_PRIVACY);
  for (const [prerender, staticPagePrivacy] of admitted) {
    const member = members.get(prerender);
    const { entryId } = await deriveEntry(scopeId, {
      kind: 'pages',
      route: prerender.route,
      pathname: prerender.pathname,
    });
    const fn = functionOfPrerender(placed, prerender);
    pages.push({
      pathname: prerender.pathname,
      route: prerender.route,
      entryId,
      ...((staticPagePrivacy === 2 || staticPagePrivacy === FALLBACK_PRIVACY) && {
        staticPagePrivacy,
      }),
      ...(member !== undefined && {
        parameters: { ...member.params },
        dataPathname: member.dataPathname,
      }),
      ...(prerender.bypassFor !== undefined && { bypassFor: prerender.bypassFor }),
      ...(fn !== PRIMARY_FUNCTION && { function: fn }),
    });
  }
  return pages;
}

/** Lazy loading bytes are build-owned, and never pretend to be a concrete generation. */
export function pagesFallbacksOf(
  bundle: DeploymentBundle,
  enabled = true,
  encodings?: ReadonlyMap<string, readonly EncodedShellRef[]>,
  patterns: BuildPatternMatcher = new BuildPatternBudget(),
): PagesFallbackEntry[] {
  if (!enabled) return [];
  const placed = placedRoutes(bundle.entrypoints);
  return staticFallbackPagesOf(bundle, patterns).flatMap((prerender) => {
    const { body } = prerender;
    if (body === undefined) return [];
    const fn = functionOfPrerender(placed, prerender);
    const rendered = shellEncodingsOf(encodings?.get(body.sha256) ?? []);
    return [
      {
        staticPagePrivacy: FALLBACK_PRIVACY,
        route: prerender.route,
        dataPathname: pagesDataPathnameUnder(bundle.buildId, '', prerender.route),
        shell: {
          artifact: { ...body, encoding: 'identity' as const },
          ...(rendered !== undefined && { encodings: rendered }),
        },
        headers: shellHeaders(bundle, prerender, patterns),
        ...(prerender.bypassFor !== undefined && { bypassFor: prerender.bypassFor }),
        ...(fn !== PRIMARY_FUNCTION && { function: fn }),
      },
    ];
  });
}
