import { staticFallbackParametersFor } from '../bundle/fallback-pages.ts';
import { pageOfPagesData, pagesDataPathnameAtPrefix } from '../bundle/pages-data.ts';
import { findStaticPage, findPagesFallback, isReserved } from '../manifest/index.ts';
import { anyConditionHolds } from './conditions.ts';
import { isBotUserAgent } from './constants.ts';
import { dataRequestHeaders } from './headers.ts';
import { staticPageRequestPrivate } from './static-pages.ts';
import type { ClassifyInput, RequestClass } from './types.ts';
const PAGES_FALLBACK_PRIVACY = 3;

function targetOf(input: ClassifyInput) {
  const { manifest, url, headers } = input;
  if (
    manifest === undefined ||
    (manifest.pagesFallbacks === undefined && manifest.staticPages === undefined)
  )
    return;
  const prefix = manifest.pagesDataPrefix;
  const dataPage =
    prefix === undefined
      ? undefined
      : pageOfPagesData(
          prefix,
          manifest.pagesDataBasePath ?? '',
          url.pathname,
          manifest.trailingSlash === true,
        );
  const isData = dataPage !== undefined;
  const pathname = dataPage ?? url.pathname;
  const staticPage = findStaticPage(manifest, pathname);
  // Existing fixed-page requests allocate no additional URL or candidate state.
  if (
    staticPage?.staticPagePrivacy !== PAGES_FALLBACK_PRIVACY &&
    manifest.pagesFallbacks === undefined
  )
    return;
  const pageUrl = new URL(url.href);
  pageUrl.pathname = pathname;
  const fallback =
    staticPage === undefined ? findPagesFallback(manifest, pageUrl, headers) : undefined;
  const entry =
    staticPage?.staticPagePrivacy === PAGES_FALLBACK_PRIVACY ? staticPage : fallback?.entry;
  return entry === undefined
    ? undefined
    : { manifest, url, headers, prefix, isData, pathname, staticPage, fallback, entry, pageUrl };
}
type Target = NonNullable<ReturnType<typeof targetOf>>;

function privateRequest(target: Target): boolean {
  const { manifest, url, headers, isData } = target;
  return (
    manifest.cache === undefined ||
    manifest.trailingSlash === true ||
    (manifest.pagesDataBasePath ?? '') !== '' ||
    url.pathname.includes('%') ||
    url.pathname.includes('//') ||
    staticPageRequestPrivate(url, headers, isData)
  );
}
function reservedRequest(target: Target): boolean {
  const { manifest, url, pageUrl, headers, isData, entry } = target;
  return (
    isReserved(manifest, url, isData ? dataRequestHeaders(headers) : headers, true) ||
    isReserved(manifest, pageUrl, headers, true) ||
    anyConditionHolds(entry.bypassFor ?? [], url, headers) ||
    anyConditionHolds(entry.bypassFor ?? [], pageUrl, headers)
  );
}
function memberRequest(target: Target): RequestClass | undefined {
  const { staticPage, pathname, prefix, isData, url } = target;
  if (staticPage?.staticPagePrivacy !== PAGES_FALLBACK_PRIVACY) return undefined;
  const params = staticFallbackParametersFor(staticPage.route, pathname);
  if (
    params === undefined ||
    prefix === undefined ||
    staticPage.pathname !== pathname ||
    staticPage.dataPathname !== pagesDataPathnameAtPrefix(prefix, pathname) ||
    staticPage.parameters === undefined ||
    Object.keys(params).length !== Object.keys(staticPage.parameters).length ||
    Object.entries(params).some(([name, value]) => staticPage.parameters?.[name] !== value) ||
    (isData && staticPage.dataPathname !== url.pathname)
  )
    return bypass();
  return {
    kind: 'static-page',
    entry: staticPage,
    ...(isData && { representation: 'pages-data' as const }),
  };
}
function bypass(): RequestClass {
  return { kind: 'passthrough', reason: 'static-page-bypass' };
}

/** A complete member and its props share one authority; loading remains explicitly separate. */
export function fallbackPagesRequest(
  input: ClassifyInput,
  controls: (input: ClassifyInput, pagesData: boolean) => RequestClass | undefined,
): RequestClass | undefined {
  const target = targetOf(input);
  if (target === undefined) return undefined;
  if (privateRequest(target)) return bypass();
  const protocol = controls(input, target.isData);
  if (protocol !== undefined) return protocol;
  if (reservedRequest(target)) return bypass();
  const member = memberRequest(target);
  if (member !== undefined) return member;
  const { fallback, isData, headers } = target;
  if (fallback === undefined || (!isData && isBotUserAgent(headers.get('user-agent') ?? '')))
    return bypass();
  return { kind: 'pages-fallback', ...fallback, representation: isData ? 'pages-data' : 'html' };
}
