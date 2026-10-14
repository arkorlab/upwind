import { type EncodedShellRef, shellEncodingsOf } from '@stayingupwind/core/artifact';
import {
  cacheablePrerenders,
  type DeploymentBundle,
  functionOfPrerender,
  prefetchSegments,
  type Prerender,
  PRIMARY_FUNCTION,
  routePathnameOf,
  shellHeaders,
} from '@stayingupwind/core/bundle';
import type {
  HeaderRule,
  MiddlewareMatcher,
  RouteCache,
  RouteEntry,
  RouteSegment,
} from '@stayingupwind/core/manifest';
import {
  allowRecoveryScript,
  permitsAnyInlineScript,
  sandboxBlocksRecovery,
} from '@stayingupwind/core/request';
import { bundleGeneratedAtMs, seedRouteFor } from '@stayingupwind/host/bundle';
import { withoutAdvertised, withoutForbidden } from '@stayingupwind/host/preloads';

/**
 * The routes a deployment's manifest names, one entry per prerender the edge serves a document
 * for: its shell, the renderings stored beside it, its prefetch segments, the hints its head named,
 * and the cache entry it is served from.
 */

export function middlewareMatchersOf(bundle: DeploymentBundle): MiddlewareMatcher[] | undefined {
  return bundle.middleware?.matchers.map((matcher) => {
    return {
      sourceRegex: matcher.sourceRegex,
      ...(matcher.has !== undefined && { has: matcher.has }),
      ...(matcher.missing !== undefined && { missing: matcher.missing }),
    };
  });
}

/** A class shell's pathname is the template it was built for, which no request ever asks for. */
function isTemplate(pathname: string): boolean {
  return pathname.includes('[');
}

/**
 * Whether a middleware matcher covers this pathname, however the request turns out.
 *
 * A matcher with a `has` or a `missing` runs the middleware for some requests of a URI and not
 * for others, and what it does when it runs — a rewrite, a redirect, an answer of its own — is
 * not this document. The edge leaves the hints off a response its middleware ran for, but a `103`
 * is replayed from the URI rather than composed per request: one visitor the matcher passed over
 * seeds the cache for the next one it does not. So a route a matcher names carries no hints at
 * all, which for a matcher without conditions is what the edge was doing for every request of it
 * anyway.
 *
 * A class shell is judged by the company it keeps rather than by its own name: `/items/[id]` is
 * not a pathname anybody requests, and whether `^/items/private$` reaches one of the requests it
 * answers is a question about two patterns that nothing here can settle. Any matcher at all takes
 * its hints, which is the same answer as for the every-path matcher a build usually has.
 */
function middlewareCovers(matchers: readonly MiddlewareMatcher[], pathname: string): boolean {
  if (isTemplate(pathname)) {
    return matchers.length > 0;
  }
  return matchers.some((matcher) => {
    // The flags `middlewareApplies` runs them under at the edge: case-insensitive, as Next.js
    // matches them, and without the unicode flag, as it compiled them. A route this read as
    // uncovered and the edge reads as covered is a route with hints nothing there will use.
    // eslint-disable-next-line security/detect-non-literal-regexp, require-unicode-regexp
    return new RegExp(matcher.sourceRegex, 'i').test(pathname);
  });
}

/**
 * The rules judged on each request that may lay a policy over this route's own, for some of the
 * requests it answers (`ManifestContext.policyRules`): one whose pattern names its pathname, and
 * any at all for a class shell, judged by the company it keeps as for a middleware's matchers.
 */
function policyRulesCovering(
  rules: readonly HeaderRule[],
  pathname: string,
): readonly HeaderRule[] {
  if (isTemplate(pathname)) {
    return rules;
  }
  // As the edge judges them (`documentHeaderRulesFor`): case-insensitive, without the unicode flag.
  // eslint-disable-next-line security/detect-non-literal-regexp, require-unicode-regexp
  return rules.filter((rule) => new RegExp(rule.sourceRegex, 'i').test(pathname));
}

/** A rule's headers, under the lowercase names a route's own are recorded by. */
function lowercased(headers: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
}

/**
 * The hints the route's own policies leave standing, less what a rule judged on each request
 * forbids or quietens with the policies it lays over them: a `103` replays the same hints to the
 * requests the rule holds for as to any other, before either policy can reach the browser.
 */
function withoutRuledOut(
  hints: readonly string[],
  headers: Readonly<Record<string, string>>,
  rules: readonly HeaderRule[],
): string[] {
  let kept = [...hints];
  for (const rule of rules) {
    kept = withoutForbidden(kept, { ...headers, ...lowercased(rule.headers) });
  }
  return kept;
}

/** What every route entry of one deployment is built from, beside the prerender itself. */
export interface ManifestContext {
  readonly bundle: DeploymentBundle;
  /**
   * The app Worker each route outside the first is in, for a bundle split across several; empty for
   * one that was not.
   */
  readonly placed: ReadonlyMap<string, string>;
  readonly encodings: ReadonlyMap<string, readonly EncodedShellRef[]>;
  /** What each shell's head names, by digest, as it was read when the shell was imported. */
  readonly preloads: Readonly<Record<string, readonly string[]>>;
  /** The cache entry each prerender's route is served from, by prerender id. */
  readonly caches: ReadonlyMap<string, RouteCache>;
  /** The middleware matchers of the build, for the routes whose answer they can change. */
  readonly matchers: readonly MiddlewareMatcher[];
  /**
   * The rules of `next.config` the edge judges on each request — the ones with a condition, `has`
   * or `missing`, which no route's own headers can carry — that set a policy a hint answers to
   * (`withoutForbidden`): a `Content-Security-Policy` or a `Referrer-Policy`.
   */
  readonly policyRules: readonly HeaderRule[];
  /** The CSP source that authorises the recovery script, added to every policy recorded here. */
  readonly recoverySource: string;
  /**
   * The prerenders whose shell leaves the rest of the document to a continuation, by id: the ones
   * `@stayingupwind/core/bundle` serves as resumable. It asks Next.js's classification where the
   * build recorded it whole — `response` and `compute`, from 16.3 on — and the outputs where it did
   * not, so a 16.2 build and one with half a classification are read the way the edge serves them.
   */
  readonly resumable: ReadonlySet<string>;
  /**
   * The prefetch segments of each route the edge serves a document for, by the document's pathname
   * as the build named it — which a `trailingSlash` build's route entry is not keyed with — ready
   * to be named on the entry, renderings and all.
   */
  readonly segments: ReadonlyMap<string, Record<string, RouteSegment>>;
  /** The whole payload of each page the build finished, keyed as `segments` is (`routeArtifactsOf`). */
  readonly payloads: ReadonlyMap<string, RouteSegment>;
  /** A Pages Router page's props, keyed as `segments` is (`routeArtifactsOf`). */
  readonly pagesData: ReadonlyMap<string, RouteSegment>;
}

/**
 * The headers a route is recorded with. Its own Content-Security-Policy goes out with the shell,
 * long before the edge can learn it has to append the recovery script. A policy that restricts
 * inline scripts would then block the one piece of code that gets a reader off a broken document,
 * so the hash is added here, where the policy is recorded. Not to a document the edge serves whole
 * — the one its entry says is complete — which has no continuation to fail, and keeps the policy it
 * was given.
 */
function recordedHeaders(
  built: Readonly<Record<string, string>>,
  cache: RouteCache | undefined,
  recoverySource: string,
): Readonly<Record<string, string>> {
  return cache?.delivery === 'complete' ? built : allowRecoveryScript(built, recoverySource);
}

export function routeEntryOf(
  prerender: Prerender,
  context: ManifestContext,
): RouteEntry | undefined {
  if (prerender.body === undefined) {
    return undefined;
  }
  const { bundle } = context;
  const built = shellHeaders(bundle, prerender);
  // A recovery hash cannot relax sandbox flags. A resumable shell that cannot recover from a
  // failed continuation stays with the Worker; a complete document needs no continuation.
  const sandboxed = built['content-security-policy'];
  if (
    sandboxed !== undefined &&
    context.resumable.has(prerender.id) &&
    sandboxBlocksRecovery(sandboxed) !== undefined
  ) {
    return undefined;
  }
  const shellEncodings = shellEncodingsOf(context.encodings.get(prerender.body.sha256) ?? []);
  const cache = context.caches.get(prerender.id);
  const headers = recordedHeaders(built, cache, context.recoverySource);
  const csp = headers['content-security-policy'];
  // The scan ran before this route's headers were known, so what the build already preloads on
  // its own `Link` — the font React puts there — is taken out here rather than promoted twice.
  // Taken out for good, including for a request that arrives at a header of its own: a middleware
  // that sets `Link`, or a conditional `next.config` rule the edge judges per request. Both
  // replace the value rather than adding to it, so what they drop is the build's own advertising
  // along with what gave way to it — one statement, made where the two were compared. Comparing
  // against the header the request finally gets would mean reading a `Link` on the serving path,
  // which is the one thing this design does not do: the hints are joined and sent, never parsed.
  // The spelling a request asks for the page by, behind the slash where the application keeps its
  // pages there; a class shell under its template. The matchers are asked about that request.
  const pathname = routePathnameOf(bundle, prerender);
  const named = middlewareCovers(context.matchers, pathname)
    ? []
    : (context.preloads[prerender.body.sha256] ?? []);
  // And what the route's own policies forbid or quieten goes out with it: a hint replayed as a
  // `103` arrives before either can reach the browser, so both are read here instead.
  const preloads = withoutRuledOut(
    withoutForbidden(withoutAdvertised(named, headers['link']), headers),
    headers,
    policyRulesCovering(context.policyRules, pathname),
  );
  const segments = context.segments.get(prerender.pathname);
  const payload = context.payloads.get(prerender.pathname);
  const pagesData = context.pagesData.get(prerender.pathname);
  // The Worker that resumes and regenerates the shell: its route's, named where it is not the first.
  const fn = functionOfPrerender(context.placed, prerender);
  return {
    pathname,
    status: 200,
    shell: {
      sha256: prerender.body.sha256,
      byteLength: prerender.body.byteLength,
      contentType: prerender.body.contentType,
      encoding: 'identity',
    },
    ...(shellEncodings !== undefined && { shellEncodings }),
    ...(segments !== undefined && { segments }),
    ...(payload !== undefined && { payload }),
    ...(pagesData !== undefined && { pagesData }),
    ...(preloads.length > 0 && { preloads }),
    headers,
    prerenderId: prerender.id,
    ...(cache !== undefined && { cache }),
    ...(prerender.bypassFor !== undefined &&
      prerender.bypassFor.length > 0 && { bypassFor: prerender.bypassFor }),
    // Recorded rather than acted on: the nonce the edge mints is what stops an inline script this
    // policy still permits, and only the application can move one.
    ...(csp !== undefined && permitsAnyInlineScript(csp) && { cspUnsafeInline: true as const }),
    ...(fn !== PRIMARY_FUNCTION && { function: fn }),
  };
}

/**
 * The prefetch segments of each route the edge serves, by the document's pathname as the build
 * named it, each named with the renderings compressed for it. `routeEntryOf` looks them up
 * by that same name, and names them on the route the request is answered under, whatever its
 * spelling (`routePathnameOf`).
 *
 * Keyed by the document's own pathname rather than by the segment's, because that is the page a
 * request asks for part of: a prefetch arrives at the page's URL, and the segment's own path is
 * only the file the build wrote it to.
 */
export function routeSegmentsOf(
  bundle: DeploymentBundle,
  encodings: ReadonlyMap<string, readonly EncodedShellRef[]>,
): ReadonlyMap<string, Record<string, RouteSegment>> {
  const routes = new Map<string, Record<string, RouteSegment>>();
  const found = prefetchSegments(bundle, { complete: true });
  for (const segment of found) {
    const { body } = segment.prerender;
    if (body === undefined) {
      continue;
    }
    const rendered = shellEncodingsOf(encodings.get(body.sha256) ?? []);
    const named = routes.get(segment.document.pathname) ?? {};
    named[segment.segmentPath] = {
      artifact: { ...body, encoding: 'identity' },
      ...(rendered !== undefined && { encodings: rendered }),
    };
    routes.set(segment.document.pathname, named);
  }
  return routes;
}

/**
 * What the build wrote beside each page the edge serves, by the document's pathname as
 * `routeSegmentsOf` keys segments, with the renderings compressed for it: a finished page's
 * whole payload (`routePayloads`), a Pages Router page's props (`routePagesData`).
 */
export function routeArtifactsOf(
  found: readonly { readonly document: Prerender; readonly prerender: Prerender }[],
  encodings: ReadonlyMap<string, readonly EncodedShellRef[]>,
): ReadonlyMap<string, RouteSegment> {
  const routes = new Map<string, RouteSegment>();
  for (const { document, prerender } of found) {
    const { body } = prerender;
    if (body === undefined) {
      continue;
    }
    const rendered = shellEncodingsOf(encodings.get(body.sha256) ?? []);
    routes.set(document.pathname, {
      artifact: { ...body, encoding: 'identity' },
      ...(rendered !== undefined && { encodings: rendered }),
    });
  }
  return routes;
}

/** The cache entry of every prerender the cache was seeded with, by prerender id. */
export async function routeCachesOf(
  bundle: DeploymentBundle,
  scopeId: string,
): Promise<ReadonlyMap<string, RouteCache>> {
  const caches = new Map<string, RouteCache>();
  const context = { scopeId, generatedAt: bundleGeneratedAtMs(bundle) };
  for (const prerender of cacheablePrerenders(bundle)) {
    const seeded = await seedRouteFor(bundle, prerender, context);
    // A route handler's entry is the Worker's alone: no manifest route names it.
    if (seeded?.cache !== undefined) {
      caches.set(prerender.id, seeded.cache);
    }
  }
  return caches;
}
