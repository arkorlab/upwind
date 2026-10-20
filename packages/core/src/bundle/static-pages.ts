import { staticPageHeadersAllowSharing } from '../cache/static-pages.ts';
import type { DeploymentBundle, Prerender } from './schema.ts';
import {
  completePrerenders,
  prerenderResponseHeaders,
  primaryPrerenders,
  reproducesDynamicRouting,
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
    page.initialRevalidate === false &&
    page.initialExpiration === undefined &&
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

function ordinaryPath(bundle: DeploymentBundle, pathname: string): boolean {
  const { basePath } = bundle.config;
  return pathname.startsWith(`${basePath}/`) && !ERROR_PAGES.has(pathname.slice(basePath.length));
}

function publicHtml(bundle: DeploymentBundle, page: Prerender): boolean {
  if (page.body?.contentType.split(';', 1)[0]?.trim().toLowerCase() !== 'text/html') return false;
  const initial: [string, string][] = [];
  if (page.initialHeaders !== undefined) {
    for (const [name, values] of Object.entries(page.initialHeaders)) {
      const list = typeof values === 'string' ? [values] : values;
      for (const value of list) initial.push([name, value]);
    }
  }
  return staticPageHeadersAllowSharing([...initial, ...prerenderResponseHeaders(bundle, page)]);
}

/** A build's explicit proof admits no ISR, class/loading shell, data twin or runtime generation. */
export function edgeServableStaticPages(bundle: DeploymentBundle): Prerender[] {
  if (bundle.staticPagesPrivacy !== 1 || !reproducesDynamicRouting(bundle)) return [];
  const pages = new Set(
    bundle.entrypoints
      .filter((entry) => entry.kind === 'pages' && entry.runtime === undefined)
      .map((entry) => entry.pathname),
  );
  const primary = primaryPrerenders(bundle.prerenders);
  return completePrerenders(bundle).filter((page) => {
    return (
      pages.has(page.route) &&
      fixedDocument(page) &&
      primary.get(page.id)?.id === page.id &&
      ordinaryPath(bundle, page.pathname) &&
      ordinaryPath(bundle, page.route) &&
      publicHtml(bundle, page)
    );
  });
}
