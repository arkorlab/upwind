import { canonicalJson } from '../artifact/hash.ts';
import { SHIPPED_FILE_ENTITY_HEADERS } from '../request/constants.ts';
import type { BuildPatternMatcher } from './pattern-matcher.ts';
import { headerPhases, headersSetAt, isConditional, type RuleMatching } from './rule-headers.ts';
import type { BundleConfig, Route } from './schema.ts';
import type { ServingBundle } from './serving.ts';

/**
 * What the rules of `next.config` with no condition set on a file the build shipped, for a build
 * whose rules the edge does not judge on each request (`reproducesDynamicRouting`, one with
 * `i18n`): judged here once, when the manifest is written, and stored on the file's entry for the
 * edge to lay on it (`StaticFileEntry.headers`). Such a build publishes only the rules `next build`
 * writes itself for the edge to judge (`headerRulesOf`), and folds the rest into its documents'
 * headers alone — so its `public/` files and its scripts went out without the headers the
 * application set on them, a `Content-Security-Policy`, an `X-Content-Type-Options` or a
 * `Cross-Origin-Resource-Policy` among them, where `next start` sets every one: its router judges
 * the rules before it looks at the filesystem ("Headers are checked before the filesystem which
 * includes pages and `/public` files", in Next.js's `headers` documentation).
 *
 * Judged against the path Next.js's router matches them against (`resolve-routes.js`): with `i18n`
 * it puts the default locale in front of a path that names none, unless the path is under
 * `_next/` — so a `public/` file is matched behind the locale, where a rule `next build` put the
 * locale in front of matches it, and a script under `_next/` as it is, where only a rule written
 * with `locale: false` does. A rule `next build` writes itself is matched with that default locale
 * taken out again (`handleRoute`, for a route it marks `internal`), as the runtime matches one
 * (`internalPathname`, in `routing.ts`).
 *
 * What is stored is what the edge would lay for the same rules judged on the request, header for
 * header: the later of two rules naming one header wins, `Set-Cookie` among them, as the edge's own
 * judgement of the rules keeps one value a name (`headerRulesFor`) — where `next start` sends every
 * matched rule's cookie (`resolve-routes.js`). Nothing that describes the bytes is stored
 * (`SHIPPED_FILE_ENTITY_HEADERS`), since the edge lays none of it from a rule either.
 */

type I18n = NonNullable<BundleConfig['i18n']>;

/** What stored headers are, by the pathname a file is requested at; `undefined` where they set none. */
export type ShippedFileHeaders = (pathname: string) => Readonly<Record<string, string>> | undefined;

/** Next.js's `pathHasPrefix`, for a pathname: `''` is the prefix of every one. */
function hasPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** Next.js's `removePathPrefix`, for a pathname. */
function withoutPrefix(pathname: string, prefix: string): string {
  if (!hasPrefix(pathname, prefix)) {
    return pathname;
  }
  const rest = pathname.slice(prefix.length);
  return rest.startsWith('/') ? rest : `/${rest}`;
}

/** Next.js's `addPathPrefix`, for a pathname. */
function withPrefix(pathname: string, prefix: string): string {
  return prefix !== '' && pathname.startsWith('/') ? `${prefix}${pathname}` : pathname;
}

/** Next.js's `normalizeLocalePath`: the locale a path's first segment names, of `locales`, any case. */
function localeOf(
  pathname: string,
  locales: readonly string[],
): { readonly pathname: string; readonly locale?: string } {
  const segment = pathname.split('/', 2)[1]?.toLowerCase();
  const locale =
    segment === undefined || segment === ''
      ? undefined
      : locales.find((candidate) => candidate.toLowerCase() === segment);
  return locale === undefined
    ? { pathname }
    : { pathname: pathname.slice(locale.length + 1) || '/', locale };
}

/** A path given the trailing slash where the application keeps one (`maybeAddTrailingSlash`). */
function slashed(config: BundleConfig, pathname: string): string {
  return config.trailingSlash && config.skipProxyUrlNormalize !== true && !pathname.endsWith('/')
    ? `${pathname}/`
    : pathname;
}

/**
 * The path Next.js's router matches the rules against for a request of `pathname` on a host whose
 * default locale is `locale` (`resolveRoutes`, in `resolve-routes.js`): the path as it came where
 * it names a locale or is under `_next/` once the base path — or else the asset prefix — is off it,
 * and otherwise that path behind the locale, under the base path it came under.
 */
function routedPathname(
  config: BundleConfig,
  i18n: I18n,
  locale: string,
  pathname: string,
): string {
  const { basePath, assetPrefix } = config;
  const underBase = hasPrefix(pathname, basePath);
  let bare = pathname;
  if (basePath !== '' && underBase) {
    bare = withoutPrefix(pathname, basePath);
  } else if (assetPrefix !== undefined && hasPrefix(pathname, assetPrefix)) {
    bare = withoutPrefix(pathname, assetPrefix);
  }
  const initial = localeOf(bare, i18n.locales);
  if (initial.locale !== undefined || initial.pathname.startsWith('/_next/')) {
    return pathname;
  }
  const behind = initial.pathname === '/' ? `/${locale}` : `/${locale}${initial.pathname}`;
  const localized = withPrefix(behind, underBase ? basePath : '');
  return pathname.endsWith('/') ? slashed(config, localized) : localized;
}

/**
 * The path a rule `next build` writes itself is matched against (`handleRoute`, for a route marked
 * `internal`): the routed path with the host's default locale taken out again, under the base path.
 */
function internalPathname(
  config: BundleConfig,
  i18n: I18n,
  locale: string,
  routed: string,
): string {
  const { basePath } = config;
  const bare = basePath === '' ? routed : withoutPrefix(routed, basePath);
  const underBase = bare !== routed;
  const found = localeOf(bare, i18n.locales);
  const isDefault = found.locale === locale;
  let matched = bare;
  if (isDefault) {
    const prefix = underBase ? basePath : '';
    matched = underBase && found.pathname === '/' ? basePath : withPrefix(found.pathname, prefix);
  } else if (underBase) {
    matched = bare === '/' ? basePath : withPrefix(bare, basePath);
  }
  return (isDefault || underBase) && routed.endsWith('/') ? slashed(config, matched) : matched;
}

/**
 * The default locales a request may be routed under: the application's, and each domain's, which
 * Next.js puts in front of the path for a request on that domain (`detectDomainLocale`).
 */
function defaultLocalesOf(i18n: I18n): string[] {
  return [
    ...new Set([i18n.defaultLocale, ...(i18n.domains ?? []).map((domain) => domain.defaultLocale)]),
  ];
}

/**
 * A rule that sets headers whatever the request: one with no condition, and no redirect or rewrite,
 * each of which claims the path from the file before the edge would serve it (`isReserved`) — a
 * redirect's `Location` is listed among the header rules, and is no file's.
 */
function setsHeadersAlone(rule: Route): boolean {
  return (
    rule.headers !== undefined &&
    !isConditional(rule) &&
    rule.status === undefined &&
    rule.destination === undefined
  );
}

/** The headers `rules` set, in their order — the later of two naming one header wins. */
function headersAt(
  rules: readonly Route[],
  at: { readonly routed: string; readonly internal: string },
  matching: RuleMatching,
): Map<string, string> {
  const headers = new Map<string, string>();
  for (const rule of rules) {
    const pathname = rule.priority === true ? at.internal : at.routed;
    const set = headersSetAt(rule, pathname, matching);
    if (set === undefined) {
      continue;
    }
    for (const [name, value] of set) {
      headers.set(name, value);
    }
  }
  return headers;
}

/**
 * Of the headers each default locale's request is answered with, the ones every such request is
 * answered with alike, less what describes the bytes. A header a domain would be answered with
 * otherwise — another value, or none — is stored for none of them: a file is named by its path
 * alone, and a value one host would not have been given is worse than the header left to none.
 */
function agreedHeaders(answers: readonly Map<string, string>[]): Map<string, string> {
  const [first, ...rest] = answers;
  const agreed = new Map<string, string>();
  if (first === undefined) {
    return agreed;
  }
  for (const [name, value] of first) {
    if (
      !SHIPPED_FILE_ENTITY_HEADERS.has(name) &&
      rest.every((other) => other.get(name) === value)
    ) {
      agreed.set(name, value);
    }
  }
  return agreed;
}

/**
 * What each file of a build is stored with, by the pathname it is requested at, one object for
 * equal headers; `undefined` for a build whose rules the edge judges itself on each request, which
 * stores nothing. Every rule is matched against every file through `patterns`, whose allowance a
 * caller may let this exhaust without refusing anything else (`BuildPatternBudgetExceededError`).
 */
export function shippedFileHeadersOf(
  bundle: ServingBundle,
  patterns: BuildPatternMatcher,
): ShippedFileHeaders | undefined {
  const { config } = bundle;
  const { i18n } = config;
  if (i18n === null || i18n === undefined) {
    return undefined;
  }
  const rules = headerPhases(bundle).filter((rule) => setsHeadersAlone(rule));
  const locales = defaultLocalesOf(i18n);
  const matching: RuleMatching = { references: bundle.routerReferences, patterns };
  const interned = new Map<string, Readonly<Record<string, string>>>();
  return (pathname): Readonly<Record<string, string>> | undefined => {
    // Judged once for each path the router would match, which a file under `_next/` has one of
    // however many domains there are.
    const judged = new Map<string, Map<string, string>>();
    const answers = locales.map((locale) => {
      const routed = routedPathname(config, i18n, locale, pathname);
      const internal = internalPathname(config, i18n, locale, routed);
      const key = `${routed}\u{0}${internal}`;
      let answer = judged.get(key);
      if (answer === undefined) {
        answer = headersAt(rules, { routed, internal }, matching);
        judged.set(key, answer);
      }
      return answer;
    });
    const agreed = agreedHeaders(answers);
    if (agreed.size === 0) {
      return undefined;
    }
    const headers = Object.fromEntries(agreed);
    const key = canonicalJson(headers);
    const held = interned.get(key);
    if (held !== undefined) {
      return held;
    }
    interned.set(key, headers);
    return headers;
  };
}
