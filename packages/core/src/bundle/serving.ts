import { interpolateHeader } from '../manifest/dynamic.ts';
import type { DynamicRoute, HeaderRule, ReservedRoute } from '../manifest/schema.ts';
import { mayHoldForDocument } from '../request/conditions.ts';
import { BEHAVIORAL_RESPONSE_HEADERS, CONTENT_DISPOSITION_HEADER } from '../request/constants.ts';
import { filterShellResponseHeaders, rendersInline } from '../request/headers.ts';
import { isInternalPage, nextNamespaceRoutes } from './base-path.ts';
import { filesystemPagesOf } from './filesystem-pages.ts';
import { type DynamicRouting, withFunctions } from './functions.ts';
import { withGates } from './gates.ts';
import { memberRoutesOf } from './member-routes.ts';
import { pageRoutes } from './page-routes.ts';
import { type BuildPatternMatcher, nativeBuildPatterns } from './pattern-matcher.ts';
import { queryDependent } from './query.ts';
import type { DeploymentBundle, Entrypoint, Prerender, Route } from './schema.ts';
import { edgeServedRewrites } from './served-rewrites.ts';
import { terminalShellsOf } from './shared-shell.ts';
import { isTemplate, keepsTrailingSlash, requestedPathname, routerSpellings } from './spelling.ts';
import { assetPrefixRewrite } from './static-files.ts';

/**
 * What of a deployment's build the edge serves, and under which headers: the prerenders with a
 * shell to serve, the routing the edge reproduces to pick a dynamic route's class, and the
 * `next.config` header rules — folded into a route's headers when unconditional, carried as rules
 * when they depend on the request.
 *
 * Pure functions of the bundle, shared by whoever publishes a manifest from them and by whoever
 * shows what that publication will decide, so the two never disagree.
 */

/** Build routing data shared by publication and the immutable Function manifest. */
export type ServingBundle = Omit<
  DeploymentBundle,
  'functions' | 'projectDir' | 'generatedAt' | 'v'
>;

const HTTP_OK = 200;
/** The entrypoint kinds whose code renders a document, rather than answering with a response. */
const DOCUMENT_KINDS: ReadonlySet<string> = new Set(['app-page', 'pages']);

/**
 * The primary output of each prerender group, by the id of every output in that group — so an
 * output beside a document can be asked which document it travels with (`prefetchSegments`), and
 * the document itself answers with itself.
 *
 * Next.js writes a group as one document and the RSC, segment and `_next/data` outputs beside it,
 * and every one of those is the document's own pathname with something added — `.rsc`,
 * `.segments/…`, or the `_next/data/<buildId>` form a Pages Router page's props take. So the
 * document is the shortest pathname in its group, and this is a fact about the group rather than
 * about any spelling: a route whose own last segment happens to read like a suffix is still the
 * shortest thing in its own group.
 *
 * Which matters for a build that says nothing else. Next.js classifies the primary of each group
 * from 16.3 on (`routeType`) and leaves the siblings unclassified; before that it classifies
 * nothing, and this is what stands in its place. On a build that does classify, the two agree.
 */
export function primaryPrerenders(
  prerenders: readonly Prerender[],
): ReadonlyMap<string, Prerender> {
  const groupOf = (prerender: Prerender): string =>
    `${prerender.route}\u{0}${String(prerender.groupId)}`;
  const primary = new Map<string, Prerender>();
  for (const prerender of prerenders) {
    const group = groupOf(prerender);
    const held = primary.get(group);
    const shorter =
      held === undefined ||
      prerender.pathname.length < held.pathname.length ||
      (prerender.pathname.length === held.pathname.length && prerender.pathname < held.pathname);
    if (shorter) {
      primary.set(group, prerender);
    }
  }
  const byId = new Map<string, Prerender>();
  for (const prerender of prerenders) {
    const held = primary.get(groupOf(prerender));
    if (held !== undefined) {
      byId.set(prerender.id, held);
    }
  }
  return byId;
}

function primaryPrerenderIds(prerenders: readonly Prerender[]): ReadonlySet<string> {
  return new Set([...primaryPrerenders(prerenders).values()].map((prerender) => prerender.id));
}

/**
 * Is this output a document the build rendered, rather than a route handler's response or one of
 * the outputs that travel beside a document?
 *
 * Next.js says so itself from 16.3 on. Before that it says nothing, and the same question is asked
 * of what a bundle carries either way: the entrypoint for the route says whether the code behind it
 * renders a document at all, and the group says which of its outputs is the document.
 */
export function documentPrerenders(
  prerenders: readonly Prerender[],
  entrypoints: readonly Entrypoint[],
): (prerender: Prerender) => boolean {
  const kinds = new Map(entrypoints.map((entry) => [entry.pathname, entry.kind]));
  const primaries = primaryPrerenderIds(prerenders);
  return (prerender) => {
    if (prerender.routeType !== undefined) {
      return prerender.routeType !== 'route';
    }
    return DOCUMENT_KINDS.has(kinds.get(prerender.route) ?? '') && primaries.has(prerender.id);
  };
}

/**
 * Whether the edge can pick a dynamic route's class the way Next.js picks the route. With `i18n`
 * Next.js rewrites the pathname before matching — a request that names no locale is matched under
 * the default one — and the edge matches the pathname as it was asked for: an app with `i18n`
 * keeps its exact routes and leaves dynamic ones to its Function.
 *
 * A `basePath` is not such a case. `next build` writes it into everything the edge matches: a
 * dynamic route's pattern and the page its destination names, the pathname of every page and
 * every file, the rules of `next.config`, and the redirects it adds of its own. A request is
 * matched as it arrives, prefix and all, and lands on the class shell whose name carries the same
 * prefix.
 */
export function reproducesDynamicRouting(bundle: ServingBundle): boolean {
  const { i18n } = bundle.config;
  return i18n === null || i18n === undefined;
}

/** The templates the edge could reach: the ones a dynamic route resolves to (`pageRoutes`). */
function reachableTemplates(bundle: ServingBundle): ReadonlySet<string> {
  if (!reproducesDynamicRouting(bundle)) {
    return new Set();
  }
  return new Set(
    pageRoutes(bundle.routing.dynamicRoutes, bundle.config.basePath).flatMap(({ template }) =>
      template === undefined ? [] : [template],
    ),
  );
}

function isConditional(rule: Route): boolean {
  return rule.has !== undefined || rule.missing !== undefined;
}

/**
 * Whether a shell can be served without the Function's say on its headers: a header rule with a
 * condition is judged at the edge only where the edge reproduces the router's matching; elsewhere
 * a page such a rule covers keeps its headers, and its document, with the Function.
 *
 * Not a rule whose condition no document meets (`mayHoldForDocument`): it never sets a header on
 * one, so there is nothing to judge. Next.js writes such a rule over every path of every build with
 * a deployment id, and counted here it left no page of a build the edge does not route on the edge
 * at all.
 */
function headersReproducible(
  bundle: ServingBundle,
  prerender: Prerender,
  patterns: BuildPatternMatcher,
): boolean {
  if (reproducesDynamicRouting(bundle)) {
    return true;
  }
  return headerPhases(bundle).every((rule) => {
    return (
      rule.headers === undefined ||
      !isConditional(rule) ||
      !mayHoldForDocument(rule) ||
      // Compiled by Next.js for its own router, which runs them without the unicode flag, and
      // without regard to case (`claimedBeforeFiles`).
      !patterns.test(rule.sourceRegex, 'i', requestedPathname(bundle, prerender.pathname))
    );
  });
}

/**
 * The phases Next.js evaluates before it looks at the filesystem: the redirects and the rewrites
 * of `next.config` that claim a path outright, whatever the build wrote under it.
 */
export function beforeFilesPhases(bundle: ServingBundle): Route[] {
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
 *
 * That holds where the edge has the rules to ask. A build whose routing it does not reproduce
 * publishes none (`dynamicRouting`), and a page a conditional rule may claim is then settled here
 * as a header rule's is (`headersReproducible`): the Function keeps it, since the edge would serve
 * the request the rule claims. A rule no document meets (`mayHoldForDocument`) claims no document
 * either way.
 */
function claimedBeforeFiles(
  bundle: ServingBundle,
  prerender: Prerender,
  patterns: BuildPatternMatcher,
): boolean {
  return beforeFilesPhases(bundle).some((rule) => {
    return (
      (reproducesDynamicRouting(bundle) ? !isConditional(rule) : mayHoldForDocument(rule)) &&
      // Compiled by Next.js for its own router, which runs them without the unicode flag, and
      // without regard to case, as `mayRoutePath` matches them: a rule for `/Account` claims the
      // page at `/account`, and `.well-known`'s exemption from a slash redirect is any case's.
      patterns.test(rule.sourceRegex, 'i', requestedPathname(bundle, prerender.pathname))
    );
  });
}

/** The routes the build put on the edge runtime, by the pathname a prerender names them with. */
function edgeRuntimeRoutes(bundle: ServingBundle): ReadonlySet<string> {
  return new Set(
    bundle.entrypoints.flatMap((entry) => (entry.runtime === 'edge' ? [entry.pathname] : [])),
  );
}

/** The routes of Pages Router pages, by the pathname a prerender names them with. */
function pagesRoutes(bundle: ServingBundle): ReadonlySet<string> {
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
function generationIn(
  bundle: ServingBundle,
  patterns: BuildPatternMatcher,
): (prerender: Prerender) => boolean {
  const edgeRuntime = edgeRuntimeRoutes(bundle);
  const pages = pagesRoutes(bundle);
  const rewritten = new Set(edgeServedRewrites(bundle, patterns).map((served) => served.pathname));
  const isDocument = documentPrerenders(bundle.prerenders, bundle.entrypoints);
  return (prerender) => {
    return (
      // A beforeFiles alias hides the page at this pathname, or at the spelling it is asked for by.
      // Publishing its shell too would ask deployment validation to prove a document where live
      // routing correctly serves the file.
      !rewritten.has(prerender.pathname) &&
      !rewritten.has(requestedPathname(bundle, prerender.pathname)) &&
      !edgeRuntime.has(prerender.route) &&
      !(isTemplate(prerender.pathname) && pages.has(prerender.route)) &&
      // A page's own shell: exact, or the class shell of a dynamic route. Where a build classifies
      // its outputs that is every `routeType` but `route`, and where it does not it is read off the
      // outputs themselves — `documentPrerenders` says how.
      isDocument(prerender) &&
      prerender.body !== undefined &&
      (prerender.initialStatus === undefined || prerender.initialStatus === HTTP_OK)
    );
  };
}

/**
 * Whether Next.js picks the locale a page is answered in when the request comes, which the edge
 * does not: with `i18n`, the root redirects a visitor to the locale their `NEXT_LOCALE` cookie or
 * `Accept-Language` names, unless `localeDetection` is `false`; with `domains`, every page is in the
 * locale of the host it is asked on, which a route keyed by its pathname alone cannot tell apart.
 * Such a page stays with the deployment's Function, which picks it.
 */
function localePickedPerRequest(bundle: ServingBundle): (prerender: Prerender) => boolean {
  const { basePath, i18n } = bundle.config;
  if (i18n === null || i18n === undefined) {
    return () => false;
  }
  if ((i18n.domains ?? []).length > 0) {
    return () => true;
  }
  if (i18n.localeDetection === false) {
    return () => false;
  }
  const root = basePath === '' ? '/' : basePath;
  return (prerender) => prerender.pathname === root;
}

function servableIn(
  bundle: ServingBundle,
  patterns: BuildPatternMatcher,
): (prerender: Prerender) => boolean {
  const generation = generationIn(bundle, patterns);
  const templates = reachableTemplates(bundle);
  const localePicked = localePickedPerRequest(bundle);
  return (prerender) => {
    return (
      generation(prerender) &&
      (!isTemplate(prerender.pathname) || templates.has(prerender.pathname)) &&
      !localePicked(prerender) &&
      !claimedBeforeFiles(bundle, prerender, patterns) &&
      headersReproducible(bundle, prerender, patterns)
    );
  };
}

function resumableBy(
  bundle: DeploymentBundle,
  eligible: (prerender: Prerender) => boolean,
): Prerender[] {
  return bundle.prerenders.filter(
    (prerender) =>
      resumesFromItself(prerender) && prerender.postponed !== undefined && eligible(prerender),
  );
}

/**
 * The prerenders the edge can serve a shell for: a page whose build produced a shell and the state
 * that resumes it, whether the page has one pathname or is the class shell of a dynamic route the
 * edge can resolve. A blocking page has no shell, and a shell with no postponed state cannot be
 * resumed (Next.js refuses to, vercel/next.js#98647) — both reach the deployment's Function.
 */
export function resumablePrerenders(
  bundle: DeploymentBundle,
  patterns: BuildPatternMatcher = nativeBuildPatterns,
): Prerender[] {
  return resumableBy(bundle, servableIn(bundle, patterns));
}

/**
 * The headers this page would answer with, as the edge would read them: what the build recorded,
 * under the rules of `next.config` that name it — the same two sources `shellHeaders` folds
 * together, before the allowlist takes anything out.
 *
 * `conditional` is what to do with a rule that depends on the request. A shell is served with the
 * headers a request cannot change, so folding one in would be an answer given before the question
 * (`shellHeaders`); deciding whether a page can be served at all is the other case, and there a
 * rule that may apply is a rule that has to be reckoned with (`actsThroughHeaders`). A rule whose
 * condition no document meets (`mayHoldForDocument`) cannot apply, and is reckoned with by
 * neither.
 */
function applicableHeaders(
  bundle: ServingBundle,
  prerender: Prerender,
  conditional: 'fold' | 'leave',
  patterns: BuildPatternMatcher,
): Map<string, string> {
  const headers = new Map<string, string>();
  const recorded = Object.entries(prerender.initialHeaders ?? {});
  for (const [name, value] of recorded) {
    headers.set(name.toLowerCase(), headerValue(value));
  }
  for (const rule of headerPhases(bundle)) {
    const applies = mayHoldForDocument(rule) && (conditional === 'fold' || !isConditional(rule));
    if (!applies || rule.headers === undefined) {
      continue;
    }
    // Compiled by Next.js for its own router, which runs them without the unicode flag, and
    // without regard to case: a rule for `/Shop/:slug` sets its headers on `/shop/x` too.
    const match = patterns.exec(
      rule.sourceRegex,
      'i',
      requestedPathname(bundle, prerender.pathname),
    );
    if (match === null) {
      continue;
    }
    // With the `:name` references filled in from what the path matched, as the router fills them:
    // a rule written `value: ':slug'` means the value, not the six characters.
    for (const [name, value] of Object.entries(rule.headers)) {
      headers.set(
        interpolateHeader(name, match, bundle.routerReferences).toLowerCase(),
        interpolateHeader(value, match, bundle.routerReferences),
      );
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
 * for a header whose whole purpose is to change what the response does. Save a rule no document
 * meets: no request the edge answers with this page can be answered with the header.
 */
function actsThroughHeaders(
  bundle: ServingBundle,
  prerender: Prerender,
  patterns: BuildPatternMatcher,
): boolean {
  const headers = applicableHeaders(bundle, prerender, 'fold', patterns);
  if (BEHAVIORAL_RESPONSE_HEADERS.some((name) => headers.has(name))) {
    return true;
  }
  const disposition = headers.get(CONTENT_DISPOSITION_HEADER);
  return disposition !== undefined && !rendersInline(disposition);
}

/**
 * The pages complete at build time that the edge can serve whole: nothing resumes them, so the
 * document is the shell. Next.js's own error documents are left out, under a base path as at the
 * root — they are rendered for a status, never for a request at their pathname — and so is a page
 * that reads query parameters, which the build rendered without any and a runtime cache would have
 * to key by.
 */
function completeBy(
  bundle: ServingBundle,
  eligible: (prerender: Prerender) => boolean,
  patterns: BuildPatternMatcher,
): Prerender[] {
  return bundle.prerenders.filter((prerender) => {
    return (
      completeByItself(prerender) &&
      prerender.postponed === undefined &&
      !isInternalPage(bundle, prerender.pathname) &&
      !actsThroughHeaders(bundle, prerender, patterns) &&
      (prerender.allowQuery === undefined || prerender.allowQuery.length === 0) &&
      eligible(prerender)
    );
  });
}

export function completePrerenders(
  bundle: ServingBundle,
  patterns: BuildPatternMatcher = nativeBuildPatterns,
): Prerender[] {
  return completeBy(bundle, servableIn(bundle, patterns), patterns);
}

export interface ServableOptions {
  /** Include the pages complete at build time, which the edge serves without a continuation. */
  readonly complete?: boolean | undefined;
}

/** The prerenders the edge serves a document for under the given delivery. */
export function edgeServablePrerenders(
  bundle: DeploymentBundle,
  options: ServableOptions = {},
  patterns: BuildPatternMatcher = nativeBuildPatterns,
): Prerender[] {
  const resumable = resumablePrerenders(bundle, patterns);
  return options.complete === true
    ? [...resumable, ...completePrerenders(bundle, patterns)]
    : resumable;
}

/**
 * The route handlers rendered at build time (`export const revalidate`, or nothing dynamic
 * read): the deployment's Function serves them whole, from the cache's generation of each. One on
 * the edge runtime has no generation — the Function runs it for every request.
 */
export function routeHandlerPrerenders(bundle: DeploymentBundle): Prerender[] {
  const edgeRuntime = edgeRuntimeRoutes(bundle);
  const handlers = handlerRoutes(bundle);
  return bundle.prerenders.filter((prerender) => {
    return (
      !edgeRuntime.has(prerender.route) &&
      isHandlerOutput(prerender, handlers) &&
      !queryDependent(prerender, prerender.route, prerender.pathname) &&
      completeByItself(prerender) &&
      prerender.body !== undefined &&
      !isTemplate(prerender.pathname)
    );
  });
}

/**
 * The prerenders a runtime cache holds a generation of, and a deployment seeds it with:
 * every document the edge or the deployment's Function may answer from one, resumable or complete,
 * whose key is its pathname alone; every terminal shell keyed by the parameters it leaves open,
 * whose own pathname is the one entry its members are answered from (`terminalShellPathname`);
 * and every route handler the build rendered.
 *
 * Not only what the edge serves. What keeps a page off the edge — a rule of `next.config` that
 * claims its path before the filesystem, while a rewrite or a middleware still leads to the page; a
 * header rule the edge cannot judge; a template it cannot reach — is about routing at the edge,
 * and the Function answers the page from its generation all the same. Left unseeded, it had none to
 * answer from: it served the build's document for as long as the deployment lived, and neither
 * `revalidate` nor `revalidatePath` ever reached it.
 *
 * So was a terminal shell, which its keys kept out of the documents above: its entry held nothing
 * until a regeneration made it, the lifetime the build gave the shell (`fallbackRevalidate`) never
 * began, and neither `revalidateTag` nor `revalidatePath` reached the build's document every member
 * was answered with. `next start` counts that lifetime from the build, and keeps the shell's tags.
 */
/**
 * Has this output the classification that answers for it, whole?
 *
 * Next.js writes `response` and `compute` together or not at all, and the bundle carries each as
 * it found it. One without the other answers nothing — the pair is the answer — so it is read as
 * the absence it is, and the outputs themselves are asked instead.
 */
function isClassified(prerender: Prerender): boolean {
  return prerender.response !== undefined && prerender.compute !== undefined;
}

/**
 * A response the build finished, and one it left the rest of to a resume — asked of the
 * classification where there is one whole, and of what it classifies where there is not.
 *
 * `response` and `compute` arrived in 16.3. What they say about an output the build wrote is what
 * the output itself says: a body is a response to serve, and postponed state is the rest of a
 * document — so an output with both is the initial part of one and resumes, one with a body alone
 * is the whole of it, and one with no body is neither. That last is the part a first attempt at
 * this missed: the class shell of a `fallback: true` route carries no body, and Next.js calls it
 * `empty`/`blocking` where postponed state alone would have called it complete.
 *
 * Checked against every classified prerender of every fixture bundle to hand — 16.2 and 16.3, both
 * fixtures — where Next.js's answer and this one agree on all of them.
 */
function completeByItself(prerender: Prerender): boolean {
  if (isClassified(prerender)) {
    return prerender.response === 'complete' && prerender.compute === 'static';
  }
  return prerender.body !== undefined && prerender.postponed === undefined;
}

function resumesFromItself(prerender: Prerender): boolean {
  if (isClassified(prerender)) {
    return prerender.response === 'initial' && prerender.compute === 'resuming';
  }
  return prerender.body !== undefined && prerender.postponed !== undefined;
}

/** The routes whose entrypoint answers with a response rather than rendering a document. */
function handlerRoutes(bundle: DeploymentBundle): ReadonlySet<string> {
  const handlers = new Set<string>();
  for (const entry of bundle.entrypoints) {
    if (DOCUMENT_KINDS.has(entry.kind)) {
      continue;
    }
    handlers.add(entry.pathname);
  }
  return handlers;
}

/** Is this a route handler's own response? The classification says so, or the entrypoint does. */
function isHandlerOutput(prerender: Prerender, handlers: ReadonlySet<string>): boolean {
  return prerender.routeType === undefined
    ? handlers.has(prerender.route)
    : prerender.routeType === 'route';
}

export function cacheablePrerenders(
  bundle: DeploymentBundle,
  patterns: BuildPatternMatcher = nativeBuildPatterns,
): Prerender[] {
  const generation = generationIn(bundle, patterns);
  return [
    ...resumableBy(bundle, generation).filter(
      (prerender) => prerender.allowQuery === undefined || prerender.allowQuery.length === 0,
    ),
    ...completeBy(bundle, generation, patterns),
    ...terminalShellsOf(bundle.prerenders, generation),
    ...routeHandlerPrerenders(bundle),
  ];
}

/**
 * Every header rule, in the order Next.js applies them, for the edge to judge on each request —
 * and, for a build whose routing the edge does not reproduce, the rules `next build` writes itself
 * alone (`priority`): the `Service-Worker-Allowed` a service worker registers under, whose pattern
 * names the whole path, base path included, and no locale. Without it the service worker of such
 * an application was refused registration, and never controlled a page (`service-worker`).
 *
 * Each says the phase it came from (`HeaderRule.phase`): Next.js judges a rule ahead of the
 * middleware on the request as the client sent it, and one that runs on a match on the request as
 * it is finally matched, so the edge hands a Function only the first as judged (`aheadOfMiddleware`).
 */
export function headerRulesOf(bundle: ServingBundle): HeaderRule[] {
  const reproduced = reproducesDynamicRouting(bundle);
  return phasedHeaderRoutes(bundle).flatMap(({ route, phase }) => {
    return route.headers === undefined || (!reproduced && route.priority !== true)
      ? []
      : [{ sourceRegex: route.sourceRegex, ...conditionsOf(route), headers: route.headers, phase }];
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

/** A rewrite of `next.config` the edge answers itself, and the file of the build it answers with. */
/**
 * What the edge needs to pick a dynamic route's class the way Next.js picks the route; for a
 * bundle whose routes are split across app Functions, which Function each route it picks is in;
 * for one that declares gates, which gated route each lands on (`withGates`); and, where the
 * application keeps its pages behind a trailing slash, that it does, since a member of a class is
 * asked for with the slash too. Where it has `trailingSlash` at all, that a shipped file is found
 * by the slash as well: the router finds one so with the redirect or without it
 * (`routerSpellings`), and `skipTrailingSlashRedirect` leaves only the pages at the build's spelling.
 */
export function dynamicRouting(
  bundle: DeploymentBundle,
  routeKeys: ReadonlySet<string>,
  patterns: BuildPatternMatcher = nativeBuildPatterns,
): DynamicRouting & {
  readonly trailingSlash?: boolean;
  readonly staticFileTrailingSlash?: boolean;
} {
  const { routing } = bundle;
  const spelled = {
    ...(keepsTrailingSlash(bundle) && { trailingSlash: true }),
    ...(bundle.config.trailingSlash && { staticFileTrailingSlash: true }),
  };
  if (!reproducesDynamicRouting(bundle)) {
    return { ...spelled };
  }
  // Next.js's own order, every route kept: a class with no shell that matches first is a request
  // the edge must not serve from the build, and only the whole list says which class is first.
  const membersOf = memberRoutesOf(bundle, {
    edgeRuntime: edgeRuntimeRoutes(bundle),
    isDocument: documentPrerenders(bundle.prerenders, bundle.entrypoints),
    servable: (prerender) => {
      return (
        !claimedBeforeFiles(bundle, prerender, patterns) &&
        headersReproducible(bundle, prerender, patterns)
      );
    },
  });
  // One for each page and one for each page's data, however the build collapsed them.
  const pages = pageRoutes(routing.dynamicRoutes, bundle.config.basePath);
  const dynamicRoutes: DynamicRoute[] = pages.map(({ route, sourceRegex, template }) => {
    const shell = template !== undefined && routeKeys.has(template);
    const members = template === undefined || shell ? undefined : membersOf(template);
    return {
      sourceRegex,
      ...conditionsOf(route),
      ...(shell && { route: template }),
      ...(members !== undefined && { members }),
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
  const aliases = edgeServedRewrites(bundle, patterns);
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
    ...nextNamespaceRoutes(bundle),
  ];
  // Pathnames Next.js resolves exactly, ahead of its dynamic routes, that have no shell — under
  // each spelling the router finds one by (`routerSpellings`): `/stream/` is the page `/stream`
  // where the application keeps its pages behind the slash, and no member of a class that also
  // matches it.
  const pathnames = [
    ...bundle.entrypoints.map((entry) => entry.pathname),
    ...bundle.prerenders.map((prerender) => prerender.pathname),
    // A middleware rewrite must reach the alias's file, not a dynamic route's class shell.
    ...aliases.map((served) => served.pathname),
  ]
    .filter((pathname) => !isTemplate(pathname))
    .flatMap((pathname) => routerSpellings(bundle, pathname));
  // A shipped file is the edge's under its own name, which it looks up before any of this; under
  // another spelling the router finds it by (`/manual/` for `/manual`), it is exact, and no member
  // of a class.
  const fileSpellings = bundle.staticFiles.flatMap((file) =>
    routerSpellings(bundle, file.pathname).filter((spelling) => spelling !== file.pathname),
  );
  const exact = new Set(
    [...pathnames, ...fileSpellings].filter((pathname) => !routeKeys.has(pathname)),
  );
  const filesystemPages = filesystemPagesOf(bundle, dynamicRoutes, patterns);
  // The page each dynamic route lands on, or answers the data of, in their order.
  const landings = pages.map((page) => page.template ?? page.dataOf);
  const tables = { dynamicRoutes, reservedRoutes, exactPathnames: [...exact], filesystemPages };
  return {
    ...withGates(bundle, withFunctions(bundle, routeKeys, tables, landings), landings),
    ...spelled,
  };
}

function headerValue(value: string | readonly string[]): string {
  return typeof value === 'string' ? value : value.join(', ');
}

/** The routing phases whose header rules apply to a document, in the order Next.js applies them. */
export function headerPhases(bundle: ServingBundle): Route[] {
  return phasedHeaderRoutes(bundle).map(({ route }) => route);
}

/** The phases `headerPhases` reads, each named as the manifest records a rule's (`HeaderRule.phase`). */
const HEADER_PHASES = ['beforeMiddleware', 'afterFiles', 'onMatch'] as const;

/** `headerPhases`, each rule with the phase it came from. */
function phasedHeaderRoutes(
  bundle: ServingBundle,
): { readonly route: Route; readonly phase: NonNullable<HeaderRule['phase']> }[] {
  return HEADER_PHASES.flatMap((phase) => bundle.routing[phase].map((route) => ({ route, phase })));
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
  bundle: ServingBundle,
  prerender: Prerender,
  patterns: BuildPatternMatcher = nativeBuildPatterns,
): Map<string, string> {
  return applicableHeaders(bundle, prerender, 'leave', patterns);
}

/** The response headers a shell is served with, as the application would have sent them. */
export function shellHeaders(
  bundle: DeploymentBundle,
  prerender: Prerender,
  patterns: BuildPatternMatcher = nativeBuildPatterns,
): Record<string, string> {
  return filterShellResponseHeaders(prerenderResponseHeaders(bundle, prerender, patterns));
}

export { edgeServedRewrites, type ServedRewrite } from './served-rewrites.ts';
