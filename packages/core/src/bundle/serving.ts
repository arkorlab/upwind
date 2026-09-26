import { interpolateHeader } from '../manifest/dynamic.ts';
import type { BuildProjectManifestInput } from '../manifest/manifest.ts';
import type {
  DynamicRoute,
  HeaderRule,
  ReservedRoute,
  StaticFileAssetPrefix,
  StaticFileLocales,
} from '../manifest/schema.ts';
import { BEHAVIORAL_RESPONSE_HEADERS, CONTENT_DISPOSITION_HEADER } from '../request/constants.ts';
import { filterShellResponseHeaders, rendersInline } from '../request/headers.ts';
import { queryDependent } from './query.ts';
import type { DeploymentBundle, Prerender, Route, StaticFile } from './schema.ts';

/**
 * What of a deployment's build the edge serves, and under which headers: the prerenders with a
 * shell to serve, the routing the edge reproduces to pick a dynamic route's class, and the
 * `next.config` header rules — folded into a route's headers when unconditional, carried as rules
 * when they depend on the request.
 *
 * Pure functions of the bundle, shared by whoever publishes a manifest from them and by whoever
 * shows what that publication will decide, so the two never disagree.
 */

const HTTP_OK = 200;
/**
 * The documents `next build` writes for an error, which the Function answers a miss with — under
 * these exact names, which are the ones the runtime looks them up by. A `trailingSlash` export
 * writes its not-found a second time, as `404/index.html`, for a visitor who types that path; that
 * one is a file like any other page of the site, so the edge serves it from storage and the Function
 * never opens it.
 */
const ERROR_DOCUMENTS: readonly string[] = ['/404', '/500'];
const KIB = 1024;
const MAX_FUNCTION_FILE_KIB = 256;
/** The largest file, other than an error document, that is shipped with the Function as well. */
const MAX_FUNCTION_FILE_BYTES = MAX_FUNCTION_FILE_KIB * KIB;
/**
 * A path with nothing in it for a router to interpret: no parameter, no group, no wildcard. Only
 * such a source and destination say, at build time, exactly which request a rule answers and with
 * what — which is what `edgeServedRewrites` needs before it may answer one itself.
 */
const LITERAL_PATHNAME = /^\/[^\s:(*?#[]*$/u;
/** The prerender kinds that are a page's own shell: exact, or the class shell of a dynamic route. */
const SHELL_ROUTE_TYPES: ReadonlySet<string> = new Set(['fallback', 'page', 'shell']);
/** Documents Next.js renders for an error, never for a request at their own pathname. */
const INTERNAL_PAGES: ReadonlySet<string> = new Set(['/_error', '/_global-error', '/_not-found']);

function isTemplate(pathname: string): boolean {
  return pathname.includes('[');
}

/**
 * Whether the edge can pick a dynamic route's class the way Next.js picks the route. With `i18n`
 * Next.js rewrites the pathname before matching, and with a `basePath` both the patterns and the
 * pathnames carry a prefix the edge does not strip: an app with either keeps its exact routes and
 * leaves dynamic ones to its Function.
 */
function reproducesDynamicRouting(bundle: DeploymentBundle): boolean {
  const { config } = bundle;
  return (config.i18n === null || config.i18n === undefined) && config.basePath === '';
}

/** The templates the edge could reach: the ones a dynamic route resolves to. */
function reachableTemplates(bundle: DeploymentBundle): ReadonlySet<string> {
  if (!reproducesDynamicRouting(bundle)) {
    return new Set();
  }
  return new Set(
    bundle.routing.dynamicRoutes.flatMap((route) => {
      const template = route.destination?.split('?', 1)[0];
      return template === undefined ? [] : [template];
    }),
  );
}

function isConditional(rule: Route): boolean {
  return rule.has !== undefined || rule.missing !== undefined;
}

/**
 * Whether a shell can be served without the Function's say on its headers: a header rule with a
 * condition is judged at the edge only where the edge reproduces the router's matching; elsewhere
 * a page such a rule covers keeps its headers, and its document, with the Function.
 */
function headersReproducible(bundle: DeploymentBundle, prerender: Prerender): boolean {
  if (reproducesDynamicRouting(bundle)) {
    return true;
  }
  return !headerPhases(bundle).some(
    (rule) =>
      rule.headers !== undefined &&
      isConditional(rule) &&
      // Compiled by Next.js for its own router, which runs them without the unicode flag.
      // eslint-disable-next-line security/detect-non-literal-regexp, require-unicode-regexp
      new RegExp(rule.sourceRegex).test(prerender.pathname),
  );
}

/**
 * The phases Next.js evaluates before it looks at the filesystem: the redirects and the rewrites
 * of `next.config` that claim a path outright, whatever the build wrote under it.
 */
function beforeFilesPhases(bundle: DeploymentBundle): Route[] {
  const { routing } = bundle;
  return [
    // A `beforeMiddleware` rule that neither answers nor rewrites is a header rule and claims
    // nothing, which is how `dynamicRouting` reads the same list.
    ...routing.beforeMiddleware.filter(
      (route) => route.status !== undefined || route.destination !== undefined,
    ),
    ...routing.beforeFiles,
  ];
}

/**
 * Whether one of those rules claims this pathname from every request there is.
 *
 * The edge refuses a page such a rule claims (`routeFor`), so naming it for the edge would
 * promise a document the edge never sends. Only a rule with no conditions is decided here: one
 * with conditions claims some requests and not others, which is a question about a request and
 * not about a build — the edge answers it per request, as Next.js does, and the publication
 * puts the same question to the manifest before it asks the edge for a sample (`validateOne`).
 */
function claimedBeforeFiles(bundle: DeploymentBundle, prerender: Prerender): boolean {
  return beforeFilesPhases(bundle).some(
    (rule) =>
      !isConditional(rule) &&
      // Compiled by Next.js for its own router, which runs them without the unicode flag.
      // eslint-disable-next-line security/detect-non-literal-regexp, require-unicode-regexp
      new RegExp(rule.sourceRegex).test(prerender.pathname),
  );
}

/** The routes the build put on the edge runtime, by the pathname a prerender names them with. */
function edgeRuntimeRoutes(bundle: DeploymentBundle): ReadonlySet<string> {
  return new Set(
    bundle.entrypoints.flatMap((entry) => (entry.runtime === 'edge' ? [entry.pathname] : [])),
  );
}

/** The routes of Pages Router pages, by the pathname a prerender names them with. */
function pagesRoutes(bundle: DeploymentBundle): ReadonlySet<string> {
  return new Set(
    bundle.entrypoints.flatMap((entry) => (entry.kind === 'pages' ? [entry.pathname] : [])),
  );
}

/**
 * What every prerender the edge serves a document for has: a page, 200, at a reachable pathname,
 * on the Node.js runtime. A page on Next.js's edge runtime renders with `postponed: undefined`,
 * so there is no resume to send after its shell, whatever state the build left behind — and
 * nothing of its render is captured for the cache, so it has no generation to serve from either.
 * Its documents, complete or not, are the deployment's Function's.
 *
 * So is the class shell of a Pages Router route (`fallback: true`): the build's document for a
 * member it never saw is a loading page, not the page, which Next.js renders only at build — the
 * Function renders the member instead, and a runtime cache holds no generation of the class.
 */
function generationIn(bundle: DeploymentBundle): (prerender: Prerender) => boolean {
  const edgeRuntime = edgeRuntimeRoutes(bundle);
  const pages = pagesRoutes(bundle);
  const rewritten = new Set(edgeServedRewrites(bundle).map((served) => served.pathname));
  return (prerender) => {
    return (
      // A beforeFiles alias hides the page at this pathname. Publishing its shell too would ask
      // deployment validation to prove a document where live routing correctly serves the file.
      !rewritten.has(prerender.pathname) &&
      !edgeRuntime.has(prerender.route) &&
      !(isTemplate(prerender.pathname) && pages.has(prerender.route)) &&
      prerender.routeType !== undefined &&
      SHELL_ROUTE_TYPES.has(prerender.routeType) &&
      prerender.body !== undefined &&
      (prerender.initialStatus === undefined || prerender.initialStatus === HTTP_OK)
    );
  };
}

function servableIn(bundle: DeploymentBundle): (prerender: Prerender) => boolean {
  const generation = generationIn(bundle);
  const templates = reachableTemplates(bundle);
  return (prerender) => {
    return (
      generation(prerender) &&
      (!isTemplate(prerender.pathname) || templates.has(prerender.pathname)) &&
      !claimedBeforeFiles(bundle, prerender) &&
      headersReproducible(bundle, prerender)
    );
  };
}

function resumableBy(
  bundle: DeploymentBundle,
  eligible: (prerender: Prerender) => boolean,
): Prerender[] {
  return bundle.prerenders.filter((prerender) => {
    return (
      prerender.response === 'initial' &&
      prerender.compute === 'resuming' &&
      prerender.postponed !== undefined &&
      eligible(prerender)
    );
  });
}

/**
 * The prerenders the edge can serve a shell for: a page whose build produced a shell and the state
 * that resumes it, whether the page has one pathname or is the class shell of a dynamic route the
 * edge can resolve. A blocking page has no shell, and a shell with no postponed state cannot be
 * resumed (Next.js refuses to, vercel/next.js#98647) — both reach the deployment's Function.
 */
export function resumablePrerenders(bundle: DeploymentBundle): Prerender[] {
  return resumableBy(bundle, servableIn(bundle));
}

/**
 * The headers this page would answer with, as the edge would read them: what the build recorded,
 * under the rules of `next.config` that name it — the same two sources `shellHeaders` folds
 * together, before the allowlist takes anything out.
 *
 * `conditional` is what to do with a rule that depends on the request. A shell is served with the
 * headers a request cannot change, so folding one in would be an answer given before the question
 * (`shellHeaders`); deciding whether a page can be served at all is the other case, and there a
 * rule that may apply is a rule that has to be reckoned with (`actsThroughHeaders`).
 */
function applicableHeaders(
  bundle: DeploymentBundle,
  prerender: Prerender,
  conditional: 'fold' | 'leave',
): Map<string, string> {
  const headers = new Map<string, string>();
  const recorded = Object.entries(prerender.initialHeaders ?? {});
  for (const [name, value] of recorded) {
    headers.set(name.toLowerCase(), headerValue(value));
  }
  for (const rule of headerPhases(bundle)) {
    if (rule.headers === undefined || (conditional === 'leave' && isConditional(rule))) {
      continue;
    }
    // Compiled by Next.js for its own router, which runs them without the unicode flag.
    // eslint-disable-next-line security/detect-non-literal-regexp, require-unicode-regexp
    const match = new RegExp(rule.sourceRegex).exec(prerender.pathname);
    if (match === null) {
      continue;
    }
    // With the `:name` references filled in from what the path matched, as the router fills them:
    // a rule written `value: ':slug'` means the value, not the six characters.
    for (const [name, value] of Object.entries(rule.headers)) {
      headers.set(interpolateHeader(name, match).toLowerCase(), interpolateHeader(value, match));
    }
  }
  return headers;
}

/**
 * Whether a header this page answers with changes what the answer *does* — a `refresh` that
 * navigates away, a `clear-site-data` that empties the browser's storage, a
 * `content-disposition` that downloads the page instead of rendering it.
 *
 * None of those is replayed with a shell (`SHELL_RESPONSE_HEADER_ALLOWLIST`), and for a shell
 * that is caught at request time: the continuation carries the header, the edge sees it and
 * condemns the route. A document the build finished starts no continuation, so nothing would
 * ever see it — the page would quietly lose the header for as long as the deployment lives.
 * It stays with the Function, which answers it as the application wrote it.
 *
 * A rule with conditions counts here as one without. The edge does judge those per request
 * (`headerRulesFor`), but what it judges them for is a header it may replay, and these are not:
 * the request that meets the condition would be answered without the header and nothing would
 * notice. One rule takes the page off the edge for every request, which is the safe way round
 * for a header whose whole purpose is to change what the response does.
 */
function actsThroughHeaders(bundle: DeploymentBundle, prerender: Prerender): boolean {
  const headers = applicableHeaders(bundle, prerender, 'fold');
  if (BEHAVIORAL_RESPONSE_HEADERS.some((name) => headers.has(name))) {
    return true;
  }
  const disposition = headers.get(CONTENT_DISPOSITION_HEADER);
  return disposition !== undefined && !rendersInline(disposition);
}

/**
 * The pages complete at build time that the edge can serve whole: nothing resumes them, so the
 * document is the shell. Next.js's own error documents are left out — they are rendered for a
 * status, never for a request at their pathname — and so is a page that reads query parameters,
 * which the build rendered without any and a runtime cache would have to key by.
 */
function completeBy(
  bundle: DeploymentBundle,
  eligible: (prerender: Prerender) => boolean,
): Prerender[] {
  return bundle.prerenders.filter((prerender) => {
    return (
      prerender.response === 'complete' &&
      prerender.compute === 'static' &&
      prerender.postponed === undefined &&
      !INTERNAL_PAGES.has(prerender.pathname) &&
      !actsThroughHeaders(bundle, prerender) &&
      (prerender.allowQuery === undefined || prerender.allowQuery.length === 0) &&
      eligible(prerender)
    );
  });
}

export function completePrerenders(bundle: DeploymentBundle): Prerender[] {
  return completeBy(bundle, servableIn(bundle));
}

export interface ServableOptions {
  /** Include the pages complete at build time, which the edge serves without a continuation. */
  readonly complete?: boolean | undefined;
}

/** The prerenders the edge serves a document for under the given delivery. */
export function edgeServablePrerenders(
  bundle: DeploymentBundle,
  options: ServableOptions = {},
): Prerender[] {
  const resumable = resumablePrerenders(bundle);
  return options.complete === true ? [...resumable, ...completePrerenders(bundle)] : resumable;
}

/**
 * The route handlers rendered at build time (`export const revalidate`, or nothing dynamic
 * read): the deployment's Function serves them whole, from the cache's generation of each. One on
 * the edge runtime has no generation — the Function runs it for every request.
 */
export function routeHandlerPrerenders(bundle: DeploymentBundle): Prerender[] {
  const edgeRuntime = edgeRuntimeRoutes(bundle);
  return bundle.prerenders.filter((prerender) => {
    return (
      !edgeRuntime.has(prerender.route) &&
      prerender.routeType === 'route' &&
      !queryDependent(prerender, prerender.route, prerender.pathname) &&
      prerender.response === 'complete' &&
      prerender.compute === 'static' &&
      prerender.body !== undefined &&
      !isTemplate(prerender.pathname)
    );
  });
}

/**
 * The prerenders a runtime cache holds a generation of, and a deployment seeds it with:
 * every document the edge or the deployment's Function may answer from one, resumable or complete,
 * whose key is its pathname alone, and every route handler the build rendered.
 *
 * Not only what the edge serves. What keeps a page off the edge — a rule of `next.config` that
 * claims its path before the filesystem, as `trailingSlash` claims every path without the slash;
 * a header rule the edge cannot judge; a template it cannot reach — is about routing at the edge,
 * and the Function answers the page from its generation all the same. Left unseeded, it had none to
 * answer from: it served the build's document for as long as the deployment lived, and neither
 * `revalidate` nor `revalidatePath` ever reached it.
 */
export function cacheablePrerenders(bundle: DeploymentBundle): Prerender[] {
  const generation = generationIn(bundle);
  return [
    ...resumableBy(bundle, generation).filter(
      (prerender) => prerender.allowQuery === undefined || prerender.allowQuery.length === 0,
    ),
    ...completeBy(bundle, generation),
    ...routeHandlerPrerenders(bundle),
  ];
}

/**
 * The default locales a shipped file is found behind as well, in an application with `i18n`: its
 * own, and each domain's, under its base path — what Next.js's filesystem check takes out of a
 * static file's path. `undefined` for an application without `i18n`.
 */
export function staticFileLocalesOf(bundle: DeploymentBundle): StaticFileLocales | undefined {
  const { basePath, i18n } = bundle.config;
  if (i18n === null || i18n === undefined) {
    return undefined;
  }
  const domains = (i18n.domains ?? []).map((domain) => domain.defaultLocale);
  return { basePath, locales: [...new Set([i18n.defaultLocale, ...domains])] };
}

/**
 * The rewrite `next build` writes, first of its `beforeFiles`, for an `assetPrefix`:
 * `<assetPrefix>/_next/:path+` to `<basePath>/_next/:path+` (`loadRewrites`, in
 * `lib/load-custom-routes.ts`). `undefined` for a build without one.
 */
function assetPrefixRewrite(bundle: DeploymentBundle): Route | undefined {
  const { assetPrefix, basePath } = bundle.config;
  const [rule] = bundle.routing.beforeFiles;
  if (
    assetPrefix === undefined ||
    rule?.source !== `${assetPrefix}/_next/:path+` ||
    rule.destination !== `${basePath}/_next/$1` ||
    rule.status !== undefined ||
    isConditional(rule)
  ) {
    return undefined;
  }
  return rule;
}

/**
 * Where a shipped file under the base path's `_next` is found as well, in an application with an
 * `assetPrefix` `next build` rewrites from: under the prefix (`assetPrefixRewrite`). `undefined`
 * for any other.
 *
 * A later `beforeFiles` rule that may claim the path a file lands on leaves that file, not every
 * file, to the router: the edge asks it of each request, as it asks its other rules (`isReserved`).
 * Decided here for the whole build, one rule that might claim one chunk had every script under
 * the prefix handed to the Function, which carries none of them.
 */
export function staticFileAssetPrefixOf(
  bundle: DeploymentBundle,
): StaticFileAssetPrefix | undefined {
  const { basePath, assetPrefix } = bundle.config;
  return assetPrefix === undefined || assetPrefixRewrite(bundle) === undefined
    ? undefined
    : { basePath, assetPrefix };
}

/**
 * Every header rule, in the order Next.js applies them, for the edge to judge on each request —
 * and, for a build whose routing the edge does not reproduce, the rules `next build` writes itself
 * alone (`priority`): the `Service-Worker-Allowed` a service worker registers under, whose pattern
 * names the whole path, base path included, and no locale. Without it the function of an application
 * with a base path was refused registration, and never controlled a page (`service-worker`).
 */
export function headerRulesOf(bundle: DeploymentBundle): HeaderRule[] {
  const phases = reproducesDynamicRouting(bundle)
    ? headerPhases(bundle)
    : headerPhases(bundle).filter((rule) => rule.priority === true);
  return phases.flatMap((rule) => {
    return rule.headers === undefined
      ? []
      : [{ sourceRegex: rule.sourceRegex, ...conditionsOf(rule), headers: rule.headers }];
  });
}

/**
 * The rules a build the edge does not route folds into its routes' headers (`applicableHeaders`),
 * in the order Next.js applies them: every rule with headers and no condition. The edge judges
 * them against a route's own pathname, as the deployment did, and lays them over the headers of
 * a generation, whose record holds only what its render set. `undefined` for a build whose rules
 * the edge judges on each request (`headerRulesOf`).
 */
export function foldedHeaderRulesOf(bundle: DeploymentBundle): HeaderRule[] | undefined {
  if (reproducesDynamicRouting(bundle)) {
    return undefined;
  }
  return headerPhases(bundle).flatMap((rule) => {
    return rule.headers === undefined || isConditional(rule)
      ? []
      : [{ sourceRegex: rule.sourceRegex, headers: rule.headers }];
  });
}

/** A route's conditions as the manifest carries them, absent fields left out. */
function conditionsOf(route: Route): Pick<DynamicRoute, 'has' | 'missing'> {
  return {
    ...(route.has !== undefined && { has: route.has }),
    ...(route.missing !== undefined && { missing: route.missing }),
  };
}

/**
 * Whether a file of the build is shipped inside the application's Function as well as held by the
 * edge. The error documents always are — the Function answers its own misses with them — and so is
 * anything small outside `_next/static`, which a rewrite may name. Everything else stays with the
 * edge alone: a Function has a size limit, and a public asset need not count against it.
 */
export function travelsWithFunction(file: StaticFile, basePath: string, exported = false): boolean {
  if (ERROR_DOCUMENTS.some((document) => file.pathname === `${basePath}${document}`)) {
    return true;
  }
  // A static export ships nothing else: the edge serves every file from storage in every mode the
  // pointer can be in, and the one reason the Function carries a small file — a middleware rewrite
  // that lands on it — cannot arise, since a static export has no middleware. A site's every
  // document is a file here, and a Function carrying them all would outgrow its size limit.
  if (exported) {
    return false;
  }
  return (
    !file.pathname.startsWith(`${basePath}/_next/`) &&
    file.blob.byteLength <= MAX_FUNCTION_FILE_BYTES
  );
}

/** A rewrite of `next.config` the edge answers itself, and the file of the build it answers with. */
export interface ServedRewrite {
  /** The rule this came from, so the routing it is taken out of can leave it out. */
  readonly rule: Route;
  /** What the visitor asks for. */
  readonly pathname: string;
  readonly file: StaticFile;
}

/** A rule that can change where this pathname goes, for at least one request. */
function mayRoutePath(rule: Route, pathname: string): boolean {
  if (rule.destination === undefined && rule.status === undefined) {
    return false;
  }
  // Conditions cannot be settled at build time: an alias must be right for every request. Match
  // the compiled pattern, including parameterized sources and Next.js's case-insensitive default.
  // eslint-disable-next-line security/detect-non-literal-regexp, require-unicode-regexp
  return new RegExp(rule.sourceRegex, 'i').test(pathname);
}

/** The literal file a rule can name, before routing precedence is considered. */
function rewriteCandidate(
  rule: Route,
  files: ReadonlyMap<string, StaticFile>,
  basePath: string,
): ServedRewrite | undefined {
  const { source, destination } = rule;
  if (
    source === undefined ||
    destination === undefined ||
    rule.status !== undefined ||
    isConditional(rule) ||
    !LITERAL_PATHNAME.test(source) ||
    !LITERAL_PATHNAME.test(destination)
  ) {
    return undefined;
  }
  const file = files.get(destination);
  return file === undefined || travelsWithFunction(file, basePath)
    ? undefined
    : { rule, pathname: source, file };
}

/**
 * The rewrites the edge serves from its own storage rather than handing to the Function.
 *
 * A rewrite to a file too large to travel with the Function had nowhere to be answered: the Function
 * is where routing happens, and the file it resolves to is not in the manifest compiled into it,
 * so the request came back a miss while the edge held the bytes all along. Resolved here, once,
 * against the build — never at request time — and the edge serves the source pathname as the
 * static file it names.
 *
 * Only a rule that says at build time exactly what it answers qualifies: a literal source and
 * destination, no condition, no status, and no earlier rule that may claim its source. A
 * `beforeFiles` rewrite overrides an existing pathname, but must leave its destination alone for
 * the rest of that phase; an `afterFiles` rewrite is reached only when no file or exact route
 * claims its source. Conditions and rewrite chains stay with the router that can resolve them.
 */
export function edgeServedRewrites(bundle: DeploymentBundle): ServedRewrite[] {
  if (!reproducesDynamicRouting(bundle)) {
    return [];
  }
  const { basePath } = bundle.config;
  const files = new Map(bundle.staticFiles.map((file) => [file.pathname, file]));
  const claimed = new Set<string>(files.keys());
  for (const entry of bundle.entrypoints) {
    claimed.add(entry.pathname);
  }
  for (const prerender of bundle.prerenders) {
    claimed.add(prerender.pathname);
  }
  const served: ServedRewrite[] = [];
  // Every earlier rule counts, including one serving a small file, a conditional rule and a
  // redirect before middleware. Failing to promote one does not mean routing skipped it.
  const earlier = [...bundle.routing.beforeMiddleware];
  const phases = [
    { rules: bundle.routing.beforeFiles, beforeFiles: true },
    { rules: bundle.routing.afterFiles, beforeFiles: false },
  ];
  for (const phase of phases) {
    for (const [index, rule] of phase.rules.entries()) {
      const candidate = rewriteCandidate(rule, files, basePath);
      const prior =
        candidate !== undefined && earlier.some((route) => mayRoutePath(route, candidate.pathname));
      earlier.push(rule);
      if (
        candidate === undefined ||
        prior ||
        (!phase.beforeFiles && claimed.has(candidate.pathname))
      ) {
        continue;
      }
      // Unlike afterFiles, beforeFiles keeps rewriting before checking the filesystem. A later
      // rule can replace this destination, even though the build already contains a file there.
      if (
        phase.beforeFiles &&
        phase.rules.slice(index + 1).some((route) => mayRoutePath(route, candidate.file.pathname))
      ) {
        continue;
      }
      served.push(candidate);
    }
  }
  return served;
}

/** What the edge needs to pick a dynamic route's class the way Next.js picks the route. */
export function dynamicRouting(
  bundle: DeploymentBundle,
  routeKeys: ReadonlySet<string>,
): Pick<BuildProjectManifestInput, 'dynamicRoutes' | 'exactPathnames' | 'reservedRoutes'> {
  const { routing } = bundle;
  if (!reproducesDynamicRouting(bundle)) {
    return {};
  }
  // Next.js's own order, every route kept: a class with no shell that matches first is a request
  // the edge must not serve, and only the whole list says which class is first.
  const dynamicRoutes: DynamicRoute[] = routing.dynamicRoutes.map((route) => {
    const template = route.destination?.split('?', 1)[0];
    return {
      sourceRegex: route.sourceRegex,
      ...conditionsOf(route),
      ...(template !== undefined && routeKeys.has(template) && { route: template }),
    };
  });
  // Redirects and rewrites Next.js evaluates ahead of its dynamic routes — and, for the ones
  // ahead of the filesystem, of a shipped file too.
  const reserved = (routes: readonly Route[], beforeFiles: boolean): ReservedRoute[] => {
    return routes.map((route) => {
      return {
        sourceRegex: route.sourceRegex,
        ...conditionsOf(route),
        ...(beforeFiles && { beforeFiles: true as const }),
      };
    });
  };
  // A beforeFiles alias replaces its rule ahead of the filesystem: reserving that rule would
  // send the request to the Function, which cannot carry the file. An afterFiles reservation only
  // guards dynamic matching; direct static-file classification and its gate run before it.
  const aliases = edgeServedRewrites(bundle);
  const servedHere = new Set(aliases.map((served) => served.rule));
  // The asset prefix's rewrite lands a file under the prefix on the file the edge finds there
  // itself (`staticFileAssetPrefixOf`), so it does not claim such a file ahead of the filesystem;
  // every other path under the prefix — a script that is not there, `_next/image` — it still
  // claims from the dynamic routes, for the router to rewrite.
  const prefixed = assetPrefixRewrite(bundle);
  const reservedRoutes: ReservedRoute[] = [
    ...reserved(
      routing.beforeMiddleware.filter(
        (route) => route.status !== undefined || route.destination !== undefined,
      ),
      true,
    ),
    ...reserved(
      routing.beforeFiles.filter((route) => !servedHere.has(route) && route !== prefixed),
      true,
    ),
    ...reserved(prefixed === undefined ? [] : [prefixed], false),
    ...reserved(routing.afterFiles, false),
  ];
  // Pathnames Next.js resolves exactly, ahead of its dynamic routes, that have no shell.
  const exact = new Set<string>();
  const pathnames = [
    ...bundle.entrypoints.map((entry) => entry.pathname),
    ...bundle.prerenders.map((prerender) => prerender.pathname),
    // A middleware rewrite must reach the alias's file, not a dynamic route's class shell.
    ...aliases.map((served) => served.pathname),
  ];
  for (const pathname of pathnames) {
    if (!isTemplate(pathname) && !routeKeys.has(pathname)) {
      exact.add(pathname);
    }
  }
  return { dynamicRoutes, reservedRoutes, exactPathnames: [...exact] };
}

function headerValue(value: string | readonly string[]): string {
  return typeof value === 'string' ? value : value.join(', ');
}

/** The routing phases whose header rules apply to a document, in the order Next.js applies them. */
function headerPhases(bundle: DeploymentBundle): Route[] {
  return [
    ...bundle.routing.beforeMiddleware,
    ...bundle.routing.afterFiles,
    ...bundle.routing.onMatch,
  ];
}

/**
 * The response headers the page answers with whatever the request: what the build recorded, and
 * what an unconditional rule of `next.config` that names it adds. Nothing is taken out; what a
 * shell or a generation may keep of them is for `shellHeaders` and the cache to say.
 *
 * The prerender carries what the render set; the rules from `next.config` headers land in the
 * routing phases and are added here for an unconditional rule that matches the pathname. A rule
 * with a `has` or `missing` condition depends on the request, which a response decided before the
 * request is looked at cannot honour here; it travels in the manifest and is judged at the edge.
 */
export function prerenderResponseHeaders(
  bundle: DeploymentBundle,
  prerender: Prerender,
): Map<string, string> {
  return applicableHeaders(bundle, prerender, 'leave');
}

/** The response headers a shell is served with, as the application would have sent them. */
export function shellHeaders(
  bundle: DeploymentBundle,
  prerender: Prerender,
): Record<string, string> {
  return filterShellResponseHeaders(prerenderResponseHeaders(bundle, prerender));
}
