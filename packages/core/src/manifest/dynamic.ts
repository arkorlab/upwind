import {
  type CompiledRule,
  compiledRules,
  type Patterned,
  patternOf,
} from '../request/compiled-patterns.ts';
import { conditionsHold } from '../request/conditions.ts';
import { execWithin, testWithin } from '../request/pattern-cost.ts';
import { requiresLiteral } from '../request/required-literal.ts';
import { findRouteEntry, keyOf, namesNoFile, withoutAssetPrefix } from './manifest.ts';
import type {
  DynamicRoute,
  MemberRoute,
  ProjectManifest,
  ReservedRoute,
  RouteEntry,
} from './schema.ts';

/**
 * Serving a dynamic route's shell to a pathname no exact route names.
 *
 * A hosted application's build produces one shell per class of URLs (`/en/[orgSlug]` for every
 * organization page), and the manifest carries Next.js's own dynamic route matchers in Next.js's
 * own order. The edge picks the class the way Next.js would pick the route: the first matcher
 * whose pattern and conditions hold. When that class has a shell, the shell is served; when it
 * does not — a page that renders blocking, a route handler — the request is Next.js's to answer,
 * and the edge does not go looking for a later class that happens to match too. A member of a page
 * with no shell may still be answered from the record its first render left (`memberRouteFor`).
 */

/** A path that begins with the name the trailing-slash redirect leaves alone, in any case. */
const WELL_KNOWN = /^\/\.well-known/iu;

/**
 * The spelling a request asks for a pathname by, in an application that keeps its pages behind a
 * trailing slash (`trailingSlash`): with the slash, which Next.js redirects the pathname without it
 * to, and which it takes off again before it looks the page up. A last segment that names a file
 * keeps none — Next.js redirects the other way there — and neither does the root, which is a slash.
 */
export function withTrailingSlash(pathname: string): string {
  // The redirect leaves a path that begins `/.well-known` alone, whatever follows — at the root of
  // the path only: under a base path, `/docs/.well-known/…` gains the slash like any other. In any
  // case, too: Next.js's router matches its rules without regard to case (`sensitive: false`), and
  // the redirect's exemption with them, so `/.WELL-KNOWN/acme` keeps no slash either.
  return namesNoFile(pathname) && !WELL_KNOWN.test(pathname) ? `${pathname}/` : pathname;
}

/**
 * Pathnames the edge leaves alone before it looks at any pattern. Next.js's own server normalizes
 * repeated slashes and trailing slashes with a redirect before routing, and the runtime's shell
 * lookup does not admit a trailing slash either, so neither is a member of any class here — save
 * the one trailing slash of an application that keeps its pages behind one (`trailingSlash`), which
 * is the spelling its members are asked for by. Whatever the last segment reads like: the redirect
 * the build writes to take the slash off a file's name is a reserved route, which claims the path
 * ahead of every class (`dynamicRouteFor`) by Next.js's own pattern — `.well-known` left alone, and
 * a dotted name it does not read as a file's (`/v1.2-beta/`) left to the class. Nor is a pathname
 * that does not decode: Next.js answers a route parameter that does not with 400, not with the
 * class's shell, and the Function is what answers it so.
 */
function isCanonicalPathname(pathname: string, trailingSlash: boolean): boolean {
  if (pathname === '/') {
    return true;
  }
  // A repeated slash is refused as asked for, before the one trailing slash allowed comes off.
  const bare = trailingSlash && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  return !pathname.includes('//') && !bare.includes('\\') && !bare.endsWith('/') && decodes(bare);
}

/** Whether `pathname` decodes; one without an escape does, and is not handed to the decoder. */
function decodes(pathname: string): boolean {
  if (!pathname.includes('%')) {
    return true;
  }
  try {
    decodeURIComponent(pathname);
    return true;
  } catch {
    return false;
  }
}

function patternMatch(compiled: CompiledRule<Patterned>, pathname: string): RegExpExecArray | null {
  // As Next.js compiled it, without the unicode flag, under the flags it was compiled with
  // (`compiledRules`): with case for a dynamic class — the runtime picks a class's shell by a
  // case-sensitive pattern, so a case variant is served by the Function rather than handed a shell
  // built for another spelling — and without, as the router matches them, for a rule of
  // `next.config`.
  return execWithin(patternOf(compiled), pathname);
}

function patternMatches(compiled: CompiledRule<Patterned>, pathname: string): boolean {
  return testWithin(patternOf(compiled), pathname);
}

/**
 * What the pathname of a request for a route's data spells, and a page's does not: the RSC payload
 * and the prefetch segments of an App Router page (`/[slug].rsc`, `/[slug].segments/….rsc`), and
 * the data of a Pages Router one (`/_next/data/<build>/[slug].json`). Next.js puts a matcher for
 * each ahead of the page's own, so a real application's list is mostly these — 423 of 637 routes —
 * and a document was asked every one of them before its own page.
 */
const DATA_ROUTE_MARKERS: readonly string[] = ['.rsc', '/_next/data/'];

interface DynamicRouteTable {
  /** Every route, in Next.js's order. */
  readonly all: readonly CompiledRule<DynamicRoute>[];
  /** The same, less each route only a pathname spelling a data marker can match. */
  readonly pages: readonly CompiledRule<DynamicRoute>[];
}

const dynamicRouteTables = new WeakMap<readonly DynamicRoute[], DynamicRouteTable>();

/**
 * Whether only a pathname that spells a data marker can match the route: proved of its pattern
 * (`requiresLiteral`), and only of one that compiles, so that a pattern that does not is still
 * reached — and throws — wherever it was reached before.
 */
function matchesOnlyData(compiled: CompiledRule<DynamicRoute>): boolean {
  return (
    compiled.pattern !== undefined &&
    DATA_ROUTE_MARKERS.some((marker) => requiresLiteral(compiled.rule.sourceRegex, marker))
  );
}

/**
 * The routes a pathname is asked of, in Next.js's order: every one, for a pathname that spells a
 * data marker; for any other — every page a visitor navigates to — all but the routes it cannot
 * match, which finds the same first match without asking those.
 */
function dynamicRoutesFor(
  routes: readonly DynamicRoute[],
  pathname: string,
): readonly CompiledRule<DynamicRoute>[] {
  let table = dynamicRouteTables.get(routes);
  if (table === undefined) {
    const all = compiledRules(routes);
    table = { all, pages: all.filter((compiled) => !matchesOnlyData(compiled)) };
    dynamicRouteTables.set(routes, table);
  }
  return DATA_ROUTE_MARKERS.some((marker) => pathname.includes(marker)) ? table.all : table.pages;
}

/**
 * A compiled header key or value with its captures filled in as Next's router fills them.
 *
 * Next's adapter converts `source: '/docs/:slug', value: ':slug'` to a positional capture and
 * `$1`. A colon left in that compiled value can be an escaped literal, so it must not be mapped
 * back through the source. Keep the existing named-group form for older manifests as well.
 */
export function interpolateHeader(value: string, match: RegExpExecArray): string {
  let out = value;
  const groups = match.groups;
  if (groups !== undefined && value.includes(':')) {
    out = value.replaceAll(/:(\w+)/gu, (reference: string, name: string) =>
      Object.hasOwn(groups, name) ? (groups[name] ?? reference) : reference,
    );
  }
  if (!value.includes('$')) return out;
  // Next replaces positional captures in order, then named groups. String searches keep
  // that order (including `$10` matching `$1` first and `$01` staying literal) without compiling
  // a regular expression for each capture on the request path.
  for (let index = 1; index < match.length; index += 1) {
    // Next also interprets replacement tokens in captured values; a callback would differ.
    // eslint-disable-next-line unicorn/no-unsafe-string-replacement
    out = out.replaceAll(`$${index}`, match[index] ?? '');
  }
  if (groups === undefined) return out;
  // Optional named groups can be undefined even though RegExpExecArray types them as strings.
  const namedCaptures: [string, string | undefined][] = Object.entries(groups);
  for (const [name, captured] of namedCaptures) {
    // Preserve Next's replacement-string semantics, including `$&` and `$$` in a capture.
    // eslint-disable-next-line unicorn/no-unsafe-string-replacement
    out = out.replaceAll(`$${name}`, captured ?? '');
  }
  return out;
}

/**
 * The entry of the class a pathname belongs to, when Next.js would serve that class: its `pathname`
 * is the class's template, the key it is validated and condemned under.
 */
export function matchDynamicRoute(
  manifest: ProjectManifest,
  url: URL,
  headers: Headers,
): RouteEntry | undefined {
  // The route Next.js picks, whatever its class holds; one whose class has no shell has none to serve.
  const route = dynamicRouteFor(manifest, url, headers)?.route;
  if (route === undefined) {
    return undefined;
  }
  return Object.hasOwn(manifest.routes, route) ? manifest.routes[route] : undefined;
}

/** A dynamic route the build made no class shell of, whose members a host serves from records. */
export type MemberOfClass = DynamicRoute & { readonly members: MemberRoute };

/**
 * The class a pathname is a member of, when Next.js would serve that class, the build made no
 * shell of it, and its members are served from the records their renders leave (`MemberRoute`):
 * the dynamic route Next.js picks (`dynamicRouteFor`), where no exact route and no pathname Next.js
 * resolves exactly comes first. `undefined` for a class with a shell, which `matchDynamicRoute`
 * answers.
 */
export function memberRouteFor(
  manifest: ProjectManifest,
  url: URL,
  headers: Headers,
): MemberOfClass | undefined {
  if (
    findRouteEntry(manifest, url.pathname) !== undefined ||
    isExactPathname(manifest, url.pathname)
  ) {
    return undefined;
  }
  const dynamic = dynamicRouteFor(manifest, url, headers);
  const members = dynamic?.members;
  if (dynamic === undefined || members === undefined) {
    return undefined;
  }
  const shell = dynamic.route !== undefined && Object.hasOwn(manifest.routes, dynamic.route);
  return shell ? undefined : { ...dynamic, members };
}

/**
 * The dynamic route Next.js would pick for a pathname no exact route names, whatever the class
 * holds — a shell or nothing: the first whose pattern and conditions hold, unless a redirect or a
 * rewrite of `next.config` claims the request ahead of the dynamic routes. `undefined` for none, and
 * for a pathname the edge leaves alone (`isCanonicalPathname`).
 *
 * `matchDynamicRoute` reads the class's shell off it; a reader that wants the route itself — which
 * app Function its code is in, say (`functionFor`) — asks this, and so the two never disagree.
 * One trailing slash is admitted where the pages are kept behind it (`trailingSlash`), unless the
 * reader says otherwise (`slashAdmitted`).
 */
export function dynamicRouteFor(
  manifest: ProjectManifest,
  url: URL,
  headers: Headers,
  slashAdmitted = manifest.trailingSlash === true,
): DynamicRoute | undefined {
  if (manifest.dynamicRoutes === undefined || !isCanonicalPathname(url.pathname, slashAdmitted)) {
    return undefined;
  }
  // A redirect or a rewrite Next.js evaluates ahead of its dynamic routes claims the request first.
  if (isReserved(manifest, url, headers, false)) {
    return undefined;
  }
  const { pathname } = url;
  for (const compiled of dynamicRoutesFor(manifest.dynamicRoutes, pathname)) {
    // A pattern that matches but whose conditions fail is passed over, as Next.js passes it over.
    if (patternMatches(compiled, pathname) && conditionsHold(compiled.rule, url, headers)) {
      return compiled.rule;
    }
  }
  return undefined;
}

/**
 * Whether a redirect or a rewrite from `next.config` claims a pathname before the edge could:
 * before the dynamic routes, or — `beforeFilesOnly` — before the filesystem, which is what a
 * shipped file's path has to clear.
 *
 * Taken on the rules alone, so a host can ask the same question of a build it is
 * about to publish as the edge asks of the manifest it publishes: a document the edge will not
 * serve from storage must not be validated as though it would.
 */
export function pathIsReserved(
  reserved: readonly ReservedRoute[],
  url: URL,
  headers: Headers,
  beforeFilesOnly: boolean,
): boolean {
  return compiledRules(reserved, 'i').some((compiled) => {
    const { rule } = compiled;
    return (
      (!beforeFilesOnly || rule.beforeFiles === true) &&
      patternMatches(compiled, url.pathname) &&
      conditionsHold(rule, url, headers)
    );
  });
}

/**
 * The path the asset prefix's rewrite lands a request under it on (`staticFileKey`), for the rest
 * of `beforeFiles` to be asked of: the router runs them on that path, and checks the filesystem
 * only after them. `undefined` for a path not under the prefix.
 */
function assetPrefixLanding(manifest: ProjectManifest, url: URL): URL | undefined {
  const prefix = manifest.staticFileAssetPrefix;
  const pathname = prefix === undefined ? undefined : withoutAssetPrefix(prefix, url.pathname);
  if (pathname === undefined) {
    return undefined;
  }
  const landed = new URL(url.href);
  landed.pathname = pathname;
  return landed;
}

/**
 * The same question of a manifest's own rules; nothing is reserved by one that carries none. A
 * path under the asset prefix is claimed ahead of the filesystem by a rule that claims the path
 * its rewrite lands on as well (`assetPrefixLanding`).
 */
export function isReserved(
  manifest: ProjectManifest,
  url: URL,
  headers: Headers,
  beforeFilesOnly: boolean,
): boolean {
  if (manifest.reservedRoutes === undefined) {
    return false;
  }
  if (pathIsReserved(manifest.reservedRoutes, url, headers, beforeFilesOnly)) {
    return true;
  }
  const landed = beforeFilesOnly ? assetPrefixLanding(manifest, url) : undefined;
  return landed !== undefined && pathIsReserved(manifest.reservedRoutes, landed, headers, true);
}

/**
 * Whether a pathname Next.js resolves exactly, with no shell, is what was asked for: as spelled or
 * decoded, as a route is looked up (`keyOf`). Read as spelled alone, an escaped request for such a
 * page passed this guard to a dynamic class that matched the escapes, and the class's shell was
 * served where Next.js serves the page.
 */
export function isExactPathname(manifest: ProjectManifest, pathname: string): boolean {
  if (manifest.exactPathnames === undefined) {
    return false;
  }
  return keyOf(manifest.exactPathnames, pathname) !== undefined;
}

/** What `next.config` sets on one request, and whether the request itself chose any of it. */
export interface ConfiguredHeaders {
  readonly headers: Record<string, string>;
  /**
   * A matched rule carried `has` or `missing`, so these headers are this visitor's.
   *
   * The same pathname answers differently to the next visitor, which is what makes the response
   * unshareable: a `Set-Cookie`, a CORS allowance or a disposition chosen for one request must not
   * be replayed to another out of a shared cache. Recorded here rather than asked for again,
   * because the loop below already knows it.
   */
  readonly conditioned: boolean;
}

function configuredHeaders(
  manifest: ProjectManifest,
  url: URL,
  headers: Headers,
  forDocument: boolean,
): ConfiguredHeaders {
  const out: Record<string, string> = {};
  let conditioned = false;
  if (manifest.headerRules === undefined) {
    return { headers: out, conditioned };
  }
  for (const compiled of compiledRules(manifest.headerRules, 'i')) {
    const { rule } = compiled;
    const match = patternMatch(compiled, url.pathname);
    if (match === null || !conditionsHold(rule, url, headers)) {
      continue;
    }
    conditioned ||= rule.has !== undefined || rule.missing !== undefined;
    const set = forDocument ? (rule.documentHeaders ?? rule.headers) : rule.headers;
    for (const [name, value] of Object.entries(set)) {
      out[interpolateHeader(name, match).toLowerCase()] = interpolateHeader(value, match);
    }
  }
  return { headers: out, conditioned };
}

/**
 * The headers `next.config` sets on this request, in rule order, judged against the request as
 * the application's router would judge them — the later of two rules naming one header wins.
 * Nothing for a manifest that carries no rule.
 */
export function headerRulesFor(
  manifest: ProjectManifest,
  url: URL,
  headers: Headers,
): ConfiguredHeaders {
  return configuredHeaders(manifest, url, headers, false);
}

/**
 * The headers the folded rules give a route (`foldedHeaderRules`), judged against the route's own
 * pathname as the deployment judged them, for a document the edge composes: a rule's
 * `documentHeaders` where it has them, and the later of two rules naming one header wins.
 * `undefined` for a manifest that carries none.
 */
export function foldedHeadersFor(
  manifest: ProjectManifest,
  pathname: string,
): Readonly<Record<string, string>> | undefined {
  if (manifest.foldedHeaderRules === undefined) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const compiled of compiledRules(manifest.foldedHeaderRules, 'i')) {
    const match = patternMatch(compiled, pathname);
    if (match === null) {
      continue;
    }
    const set = compiled.rule.documentHeaders ?? compiled.rule.headers;
    for (const [name, value] of Object.entries(set)) {
      out[interpolateHeader(name, match).toLowerCase()] = interpolateHeader(value, match);
    }
  }
  return out;
}

/**
 * The same, for a document the edge composes: a rule's `documentHeaders` where it has them, which
 * permit the recovery script only such a document can carry.
 */
export function documentHeaderRulesFor(
  manifest: ProjectManifest,
  url: URL,
  headers: Headers,
): ConfiguredHeaders {
  return configuredHeaders(manifest, url, headers, true);
}

const VALIDATION_SEGMENT = 'arkor-validation';
/** Bounded deployment-only search; a route with no unclaimed sample cannot be validated. */
const VALIDATION_RADIX = 36;
/** Only ever used to give `isReserved` a URL to read a pathname out of. */
const PLACEHOLDER_ORIGIN = 'https://validation.invalid';
const DYNAMIC_SEGMENT = /^\[[^\]]+\]\]?$/u;
const CATCH_ALL_SEGMENT = /^\[\[?\.\.\.[^\]]+\]\]?$/u;

/** A sample as a visitor asks for it: behind the trailing slash, where the pages are kept there. */
function askedFor(manifest: ProjectManifest | undefined, pathname: string): string {
  return manifest?.trailingSlash === true ? withTrailingSlash(pathname) : pathname;
}

function substitutedPathname(
  parts: readonly string[],
  segment: string,
  catchAllSegments = 1,
): string {
  return parts
    .map((part) => {
      if (CATCH_ALL_SEGMENT.test(part)) {
        return Array.from({ length: catchAllSegments }, () => segment).join('/');
      }
      return DYNAMIC_SEGMENT.test(part) ? segment : part;
    })
    .join('/');
}

/** Candidate depths are bounded by competing rules and by exact claims actually encountered. */
function* validationCandidates(
  parts: readonly string[],
  manifest: ProjectManifest,
  maxAttempts: number,
): Generator<string> {
  const suffix = encodeURIComponent(manifest.runId);
  const segments = [
    VALIDATION_SEGMENT,
    `${VALIDATION_SEGMENT}-${suffix}`,
    ...Array.from(
      { length: VALIDATION_RADIX },
      (_, index) => `${index.toString(VALIDATION_RADIX)}-${suffix}`,
    ),
  ];
  const expandable = parts.some((part) => CATCH_ALL_SEGMENT.test(part));
  for (const segment of segments) {
    let maxDepth = expandable ? maxAttempts : 1;
    for (let depth = 1; depth <= maxDepth; depth += 1) {
      const pathname = askedFor(manifest, substitutedPathname(parts, segment, depth));
      // Exact claims spend no depth budget, but only ones encountered extend the search.
      // Unrelated files cannot make a shadowed class search arbitrarily deeper URLs.
      if (expandable && claimedExactly(manifest, pathname)) {
        maxDepth += 1;
        continue;
      }
      yield pathname;
    }
  }
}

/**
 * A concrete pathname to validate a route key with: every dynamic segment of a template becomes
 * one placeholder segment initially, so the request reaches the class's shell and resumes with a
 * parameter the application can parse. Every kind gets one — leaving an optional catch-all out
 * would name the parent path, which is often an exact route with a shell of its own. An exact
 * pathname is returned as it is. A catch-all may need a deeper member to avoid a sibling class.
 *
 * A member the build named cannot stand in: Next.js resolves it exactly, to its own prerender,
 * and so does the edge — never to the class shell being validated. The placeholder is nothing the
 * application knows, and what it renders for an unknown member — a not-found boundary, a redirect
 * — is rendered inside the resumed part, after the shell; validation proves the shell and a
 * continuation that completes, not what the member says. Only a resume that fails outright fails
 * the route.
 */
export function validationPathnameFor(
  route: string,
  manifest?: ProjectManifest,
): string | undefined {
  const parts = route.split('/');
  // Asked for as a visitor asks for a page: behind the slash, where the application keeps them.
  const preferred = askedFor(manifest, substitutedPathname(parts, VALIDATION_SEGMENT));
  // Only require a class match when this manifest actually records the class being validated.
  const targetIndex =
    manifest?.dynamicRoutes?.findIndex((candidate) => candidate.route === route) ?? -1;
  const knownClass = targetIndex !== -1;
  if (manifest === undefined || !claimedElsewhere(manifest, preferred, route, knownClass)) {
    return preferred;
  }
  // Vary prefixes too: a reservation can cover every run-id suffix of the preferred spelling.
  // The caller reports unavailable samples without contacting the edge.
  // N earlier fixed-depth classes can occupy at most N depths of one spelling. Try N + 1,
  // allowing reservations a turn too; an earlier catch-all may still claim every candidate.
  const maxAttempts = Math.max(0, targetIndex) + (manifest.reservedRoutes?.length ?? 0) + 1;
  const candidates = validationCandidates(parts, manifest, maxAttempts);
  for (const pathname of candidates) {
    if (pathname !== preferred && !claimedElsewhere(manifest, pathname, route, knownClass)) {
      return pathname;
    }
  }
  return undefined;
}

/** Finite exact claims; deeper catch-all samples are distinct and can only hit each once. */
function claimedExactly(manifest: ProjectManifest, pathname: string): boolean {
  return Object.hasOwn(manifest.routes, pathname) || isExactPathname(manifest, pathname);
}

/** Whether something other than the class being validated answers at `pathname`. */
function claimedElsewhere(
  manifest: ProjectManifest,
  pathname: string,
  route: string,
  knownClass: boolean,
): boolean {
  if (pathname === route) {
    return false;
  }
  const url = new URL(pathname, PLACEHOLDER_ORIGIN);
  const headers = new Headers();
  return (
    claimedExactly(manifest, pathname) ||
    isReserved(manifest, url, headers, false) ||
    (knownClass && matchDynamicRoute(manifest, url, headers)?.pathname !== route)
  );
}
