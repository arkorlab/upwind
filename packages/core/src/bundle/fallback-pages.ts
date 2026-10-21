import {
  staticPageDataHeadersAllowSharing,
  staticPageHeadersAllowSharing,
} from '../cache/static-pages.ts';
import { compiledRules, patternOf } from '../request/compiled-patterns.ts';
import { testWithin } from '../request/pattern-budget.ts';
import { pageRoutes, type PageRoute } from './page-routes.ts';
import { pagesDataPathnameUnder } from './pages-data.ts';
import type { Entrypoint, Prerender, Route } from './schema.ts';
import {
  beforeFilesPhases,
  prerenderResponseHeaders,
  primaryPrerenders,
  reproducesDynamicRouting,
  type ServingBundle,
} from './serving.ts';

export interface StaticFallbackPage {
  readonly kind: 'member' | 'fallback';
  readonly page: Prerender;
  readonly params: Readonly<Record<string, string>>;
  readonly dataPathname: string;
  readonly privacy: typeof PRIVACY_VERSION;
}

type Member = StaticFallbackPage & { readonly kind: 'member' };
interface Admission {
  readonly members: Map<Prerender, Member>;
  readonly byPath: Map<string, Member>;
  readonly fallbacks: Map<string, Prerender>;
  readonly pages: readonly PageRoute[];
  readonly reserved: readonly Route[];
  readonly exact: ReadonlySet<string>;
  readonly outputs: ReadonlyMap<string, readonly Prerender[]>;
}
const admissions = new WeakMap<ServingBundle, Admission>();
const PRIVACY_VERSION = 3;
const HTTP_OK = 200;
const NO_MEMBERS: ReadonlyMap<Prerender, Member> = new Map();
const NO_FALLBACKS: readonly Prerender[] = [];
const PARAMETER = /^\[([A-Za-z_]\w*)\]$/u;
const PARAMETER_GLOBAL = /\[[A-Za-z_]\w*\]/gu;
const SAFE_SEGMENT = /^[\w~-]+(?:\.[\w~-]+)*$/u;
const REVALIDATION_HEADERS = new Set([
  'host',
  'x-matched-path',
  'x-next-revalidate-tag-token',
  'x-next-revalidated-tags',
  'x-prerender-revalidate',
  'x-prerender-revalidate-if-generated',
]);

/** Only canonical, single-segment named parameters; unsupported spellings remain private. */
export function staticFallbackParametersFor(
  route: string,
  pathname: string,
): Readonly<Record<string, string>> | undefined {
  const routeParts = route.split('/');
  const pathParts = pathname.split('/');
  if (
    !route.startsWith('/') ||
    !pathname.startsWith('/') ||
    routeParts.length !== pathParts.length ||
    routeParts.length < 2
  )
    return undefined;
  const params: Record<string, string> = {};
  for (let index = 1; index < routeParts.length; index += 1) {
    const part = routeParts[index] ?? '';
    const value = pathParts[index] ?? '';
    if (!SAFE_SEGMENT.test(value)) return undefined;
    const parameter = PARAMETER.exec(part)?.[1];
    if (parameter !== undefined) {
      if (
        parameter === '__proto__' ||
        parameter === 'constructor' ||
        parameter === 'prototype' ||
        Object.hasOwn(params, parameter)
      )
        return undefined;
      params[parameter] = value;
    } else if (part !== value || !SAFE_SEGMENT.test(part)) return undefined;
  }
  return Object.keys(params).length === 0 ? undefined : params;
}

function routeParameters(route: string): Readonly<Record<string, string>> | undefined {
  return staticFallbackParametersFor(route, route.replaceAll(PARAMETER_GLOBAL, 'member'));
}

function headers(page: Prerender): [string, string][] {
  return Object.entries(page.initialHeaders ?? {}).flatMap(([name, value]) =>
    (typeof value === 'string' ? [value] : value).map((part): [string, string] => [name, part]),
  );
}

function publicOutput(
  bundle: ServingBundle,
  page: Prerender,
  type: 'text/html' | 'application/json',
): boolean {
  const check =
    type === 'text/html' ? staticPageHeadersAllowSharing : staticPageDataHeadersAllowSharing;
  return (
    page.body !== undefined &&
    page.body.byteLength > 0 &&
    page.body.contentType.split(';', 1)[0]?.trim().toLowerCase() === type &&
    (page.initialStatus === undefined || page.initialStatus === HTTP_OK) &&
    check([...headers(page), ...prerenderResponseHeaders(bundle, page)])
  );
}

function ordinaryOutput(page: Prerender, params: Readonly<Record<string, string>>): boolean {
  const names = new Set(Object.keys(params).flatMap((name) => [name, `nxtP${name}`]));
  return (
    page.postponed === undefined &&
    page.pprChain === undefined &&
    page.segmentPath === undefined &&
    page.partialFallback !== true &&
    page.renderingMode !== 'PARTIALLY_STATIC' &&
    page.ensureStatic === undefined &&
    (page.allowQuery ?? []).every((name) => names.has(name)) &&
    (page.allowHeader ?? []).every((name) => REVALIDATION_HEADERS.has(name.toLowerCase()))
  );
}

function lifetime(page: Prerender): boolean {
  return (
    typeof page.initialRevalidate === 'number' &&
    Number.isSafeInteger(page.initialRevalidate) &&
    page.initialRevalidate > 0 &&
    (page.initialExpiration === undefined ||
      (Number.isSafeInteger(page.initialExpiration) &&
        page.initialExpiration >= page.initialRevalidate))
  );
}

/** Rules are compiled once in the immutable admission, never once per concrete pathname. */
function owns(admission: Admission, route: string, pathname: string, built: boolean): boolean {
  if (
    pathname.startsWith('/_') ||
    pathname.startsWith('/.well-known') ||
    ['/404', '/500'].includes(pathname)
  )
    return false;
  const early = compiledRules(admission.reserved, 'i');
  if (early.some((rule) => testWithin(patternOf(rule), pathname))) return false;
  if (admission.exact.has(pathname)) return false;
  if (!built && admission.outputs.has(pathname)) return false;
  const first = compiledRules(admission.pages).find((rule) =>
    testWithin(patternOf(rule), pathname),
  );
  return (
    first?.rule.template === route &&
    first.rule.route.has === undefined &&
    first.rule.route.missing === undefined
  );
}

function emptyAdmission(bundle: ServingBundle): Admission {
  const outputs = new Map<string, Prerender[]>();
  for (const page of bundle.prerenders) {
    const group = outputs.get(page.pathname);
    if (group === undefined) outputs.set(page.pathname, [page]);
    else group.push(page);
  }
  const exact = new Set(
    bundle.entrypoints
      .filter((entry) => !entry.pathname.includes('['))
      .map((entry) => entry.pathname),
  );
  for (const file of bundle.staticFiles) exact.add(file.pathname);
  const reserved = beforeFilesPhases(bundle);
  reserved.push(...bundle.routing.afterFiles);
  return {
    members: new Map(),
    byPath: new Map(),
    fallbacks: new Map(),
    exact,
    outputs,
    pages: pageRoutes(bundle.routing.dynamicRoutes, ''),
    reserved,
  };
}

function uniqueSources(bundle: ServingBundle): ReadonlyMap<string, Entrypoint> {
  const sources = new Map<string, Entrypoint>();
  const duplicates = new Set<string>();
  for (const source of bundle.entrypoints) {
    if (sources.has(source.pathname)) {
      sources.delete(source.pathname);
      duplicates.add(source.pathname);
    } else if (!duplicates.has(source.pathname)) sources.set(source.pathname, source);
  }
  return sources;
}

function safeFallback(
  bundle: ServingBundle,
  admission: Admission,
  page: Prerender,
  source: Entrypoint | undefined,
): boolean {
  const params = routeParameters(page.route);
  return (
    source?.kind === 'pages' &&
    source.runtime === undefined &&
    source.id === page.parentOutputId &&
    params !== undefined &&
    admission.outputs.get(page.pathname)?.length === 1 &&
    page.pathname === page.route &&
    page.routeType === 'fallback' &&
    page.response === 'initial' &&
    page.compute === 'static' &&
    page.parentFallbackMode === undefined &&
    (page.initialRevalidate === undefined || lifetime(page)) &&
    ordinaryOutput(page, params) &&
    publicOutput(bundle, page, 'text/html')
  );
}

function pairedData(
  bundle: ServingBundle,
  admission: Admission,
  page: Prerender,
  params: Readonly<Record<string, string>>,
): string | undefined {
  const pathname = pagesDataPathnameUnder(bundle.buildId, '', page.pathname);
  const outputs = admission.outputs.get(pathname);
  const data = outputs?.length === 1 ? outputs[0] : undefined;
  if (
    data?.route !== page.route ||
    data.groupId !== page.groupId ||
    data.parentOutputId !== page.parentOutputId ||
    data.routeType !== undefined ||
    data.response !== undefined ||
    data.compute !== undefined ||
    !ordinaryOutput(data, params) ||
    !publicOutput(bundle, data, 'application/json') ||
    data.initialRevalidate !== page.initialRevalidate ||
    data.initialExpiration !== page.initialExpiration
  )
    return undefined;
  return pathname;
}

function memberFor(
  bundle: ServingBundle,
  admission: Admission,
  page: Prerender,
  primary: Prerender | undefined,
): Member | undefined {
  const fallback = admission.fallbacks.get(page.route);
  const params = staticFallbackParametersFor(page.route, page.pathname);
  if (
    primary !== page ||
    fallback === undefined ||
    params === undefined ||
    page.parentOutputId !== fallback.parentOutputId ||
    page.routeType !== 'page' ||
    page.response !== 'complete' ||
    page.compute !== 'static' ||
    typeof page.parentFallbackMode !== 'string' ||
    admission.outputs.get(page.pathname)?.length !== 1 ||
    !page.parentFallbackMode.endsWith('.html') ||
    !ordinaryOutput(page, params) ||
    !publicOutput(bundle, page, 'text/html') ||
    !lifetime(page) ||
    !owns(admission, page.route, page.pathname, true)
  )
    return undefined;
  const dataPathname = pairedData(bundle, admission, page, params);
  return dataPathname === undefined
    ? undefined
    : { kind: 'member', page, params, dataPathname, privacy: PRIVACY_VERSION };
}

function admissionFor(bundle: ServingBundle): Admission {
  const held = admissions.get(bundle);
  if (held !== undefined) return held;
  const admission = emptyAdmission(bundle);
  admissions.set(bundle, admission);
  if (
    bundle.staticPagesPrivacy !== PRIVACY_VERSION ||
    !reproducesDynamicRouting(bundle) ||
    bundle.routing.shouldNormalizeNextData ||
    bundle.config.basePath !== '' ||
    bundle.config.trailingSlash ||
    bundle.config['output'] === 'export'
  )
    return admission;
  const primaries = primaryPrerenders(bundle.prerenders);
  const sources = uniqueSources(bundle);
  for (const page of bundle.prerenders) {
    if (
      primaries.get(page.id) === page &&
      safeFallback(bundle, admission, page, sources.get(page.route))
    )
      admission.fallbacks.set(page.route, page);
  }
  for (const page of bundle.prerenders) {
    const member = memberFor(bundle, admission, page, primaries.get(page.id));
    if (member !== undefined) {
      admission.members.set(page, member);
      admission.byPath.set(page.pathname, member);
    }
  }
  return admission;
}

export function staticPagesMembersOf(bundle: ServingBundle): ReadonlyMap<Prerender, Member> {
  return bundle.staticPagesPrivacy === PRIVACY_VERSION ? admissionFor(bundle).members : NO_MEMBERS;
}
export function staticFallbackPagesOf(bundle: ServingBundle): readonly Prerender[] {
  return bundle.staticPagesPrivacy === PRIVACY_VERSION
    ? [...admissionFor(bundle).fallbacks.values()]
    : NO_FALLBACKS;
}
export function staticFallbackPageFor(
  bundle: ServingBundle,
  route: string,
  pathname: string,
): StaticFallbackPage | undefined {
  if (bundle.staticPagesPrivacy !== PRIVACY_VERSION) return undefined;
  const params = staticFallbackParametersFor(route, pathname);
  if (params === undefined) return undefined;
  const admission = admissionFor(bundle);
  const built = admission.byPath.get(pathname);
  if (built !== undefined) return built.page.route === route ? built : undefined;
  const page = admission.fallbacks.get(route);
  return page !== undefined && owns(admission, route, pathname, false)
    ? {
        kind: 'fallback',
        page,
        params,
        dataPathname: pagesDataPathnameUnder(bundle.buildId, '', pathname),
        privacy: PRIVACY_VERSION,
      }
    : undefined;
}
