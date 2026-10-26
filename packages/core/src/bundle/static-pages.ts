import { STATIC_PAGES_FALLBACK_PRIVACY } from '../cache/static-page-version.ts';
import { staticPageHeadersAllowSharing } from '../cache/static-pages.ts';
import { type BuildPatternMatcher, nativeBuildPatterns } from './pattern-budget.ts';
import type { Prerender } from './schema.ts';
import {
  completePrerenders,
  prerenderResponseHeaders,
  primaryPrerenders,
  reproducesDynamicRouting,
  type ServingBundle,
} from './serving.ts';
import { isTemplate } from './spelling.ts';

/** Next.js 16.4's build-owned revalidation protocol, not application request-dependent headers. */
const REVALIDATION_HEADERS: ReadonlySet<string> = new Set([
  'host',
  'x-matched-path',
  'x-next-revalidate-tag-token',
  'x-next-revalidated-tags',
  'x-prerender-revalidate',
  'x-prerender-revalidate-if-generated',
]);
const ERROR_PAGES: ReadonlySet<string> = new Set([
  '/404',
  '/500',
  '/_error',
  '/_global-error',
  '/_not-found',
]);

function fixedDocument(page: Prerender): boolean {
  return (
    page.pathname === page.route &&
    !isTemplate(page.route) &&
    page.routeType === 'page' &&
    page.response === 'complete' &&
    page.compute === 'static' &&
    page.postponed === undefined &&
    page.pprChain === undefined &&
    page.segmentPath === undefined &&
    page.partialFallback !== true &&
    page.renderingMode !== 'PARTIALLY_STATIC' &&
    page.ensureStatic === undefined &&
    (page.allowQuery?.length ?? 0) === 0 &&
    (page.allowHeader ?? []).every((name) => REVALIDATION_HEADERS.has(name.toLowerCase()))
  );
}

function ordinaryPath(bundle: ServingBundle, pathname: string): boolean {
  const { basePath } = bundle.config;
  return (
    (pathname === basePath || pathname.startsWith(`${basePath}/`)) &&
    !ERROR_PAGES.has(pathname.slice(basePath.length))
  );
}

function publicHtml(
  bundle: ServingBundle,
  page: Prerender,
  patterns: BuildPatternMatcher,
): boolean {
  if (page.body?.contentType.split(';', 1)[0]?.trim().toLowerCase() !== 'text/html') return false;
  const initial: [string, string][] = [];
  if (page.initialHeaders !== undefined) {
    for (const [name, values] of Object.entries(page.initialHeaders)) {
      const list = typeof values === 'string' ? [values] : values;
      for (const value of list) initial.push([name, value]);
    }
  }
  return staticPageHeadersAllowSharing([
    ...initial,
    ...prerenderResponseHeaders(bundle, page, patterns),
  ]);
}

function privacyVersion(bundle: ServingBundle, page: Prerender): 1 | 2 | undefined {
  if (page.initialRevalidate === false && page.initialExpiration === undefined) return 1;
  const { initialRevalidate, initialExpiration } = page;
  return typeof initialRevalidate === 'number' &&
    (bundle.staticPagesPrivacy === 2 ||
      bundle.staticPagesPrivacy === STATIC_PAGES_FALLBACK_PRIVACY) &&
    bundle.config.basePath === '' &&
    bundle.config['output'] !== 'export' &&
    Number.isSafeInteger(initialRevalidate) &&
    initialRevalidate > 0 &&
    (initialExpiration === undefined ||
      (Number.isSafeInteger(initialExpiration) && initialExpiration >= initialRevalidate))
    ? 2
    : undefined;
}

/** Compute the actual build members and their proof versions once for publication. */
export function staticPagesPrivacyOf(
  bundle: ServingBundle,
  patterns: BuildPatternMatcher = nativeBuildPatterns,
): ReadonlyMap<Prerender, 1 | 2> {
  const admitted = new Map<Prerender, 1 | 2>();
  if (
    (bundle.staticPagesPrivacy !== 1 &&
      bundle.staticPagesPrivacy !== 2 &&
      bundle.staticPagesPrivacy !== STATIC_PAGES_FALLBACK_PRIVACY) ||
    !reproducesDynamicRouting(bundle)
  )
    return admitted;
  const pages = new Set(
    bundle.entrypoints
      .filter((entry) => entry.kind === 'pages' && entry.runtime === undefined)
      .map((entry) => entry.pathname),
  );
  const primary = primaryPrerenders(bundle.prerenders);
  for (const page of completePrerenders(bundle, patterns)) {
    const version = privacyVersion(bundle, page);
    if (
      version !== undefined &&
      pages.has(page.route) &&
      fixedDocument(page) &&
      primary.get(page.id)?.id === page.id &&
      ordinaryPath(bundle, page.pathname) &&
      ordinaryPath(bundle, page.route) &&
      publicHtml(bundle, page, patterns)
    )
      admitted.set(page, version);
  }
  return admitted;
}

/** The existing array API preserves the same built objects and order. */
export function edgeServableStaticPages(bundle: ServingBundle): Prerender[] {
  return [...staticPagesPrivacyOf(bundle).keys()];
}

/** A copied descriptor or output cannot grant authority outside this immutable build. */
export function staticPagePrivacyFor(bundle: ServingBundle, page: Prerender): 1 | 2 | undefined {
  return staticPagesPrivacyOf(bundle).get(page);
}
