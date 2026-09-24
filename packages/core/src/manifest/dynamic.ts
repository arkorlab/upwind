import { conditionsHold } from '../request/conditions.ts';
import type { ProjectManifest, ReservedRoute, RouteEntry } from './schema.ts';

/**
 * Serving a dynamic route's shell to a pathname no exact route names.
 *
 * A hosted application's build produces one shell per class of URLs (`/en/[orgSlug]` for every
 * organization page), and the manifest carries Next.js's own dynamic route matchers in Next.js's
 * own order. The edge picks the class the way Next.js would pick the route: the first matcher
 * whose pattern and conditions hold. When that class has a shell, the shell is served; when it
 * does not — a page that renders blocking, a route handler — the request is Next.js's to answer,
 * and the edge does not go looking for a later class that happens to match too.
 */

/**
 * Pathnames the edge leaves alone before it looks at any pattern. Next.js's own server normalizes
 * repeated slashes and trailing slashes with a redirect before routing, and the runtime's shell
 * lookup does not admit a trailing slash either, so neither is a member of any class here. Nor is
 * a pathname that does not decode: Next.js answers a route parameter that does not with 400, not
 * with the class's shell, and the Worker is what answers it so.
 */
function isCanonicalPathname(pathname: string): boolean {
  if (pathname === '/') {
    return true;
  }
  return (
    !pathname.includes('//') &&
    !pathname.includes('\\') &&
    !pathname.endsWith('/') &&
    decodes(pathname)
  );
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

function patternMatch(sourceRegex: string, pathname: string): RegExpExecArray | null {
  // As Next.js compiled it, without the unicode flag. Not case-insensitive, unlike the router's own
  // matching: the runtime picks a class's shell by a case-sensitive pattern, so a case variant is
  // served by the Worker rather than handed a shell built for another spelling.
  // eslint-disable-next-line security/detect-non-literal-regexp, require-unicode-regexp
  return new RegExp(sourceRegex).exec(pathname);
}

function patternMatches(sourceRegex: string, pathname: string): boolean {
  return patternMatch(sourceRegex, pathname) !== null;
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
  if (manifest.dynamicRoutes === undefined) {
    return undefined;
  }
  const { pathname } = url;
  if (!isCanonicalPathname(pathname)) {
    return undefined;
  }
  // A redirect or a rewrite Next.js evaluates ahead of its dynamic routes claims the request first.
  if (isReserved(manifest, url, headers, false)) {
    return undefined;
  }
  for (const candidate of manifest.dynamicRoutes) {
    if (!patternMatches(candidate.sourceRegex, pathname)) {
      continue;
    }
    // A pattern that matches but whose conditions fail is passed over, as Next.js passes it over.
    if (!conditionsHold(candidate, url, headers)) {
      continue;
    }
    if (candidate.route === undefined) {
      return undefined;
    }
    return Object.hasOwn(manifest.routes, candidate.route)
      ? manifest.routes[candidate.route]
      : undefined;
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
  return reserved.some((rule) => {
    return (
      (!beforeFilesOnly || rule.beforeFiles === true) &&
      patternMatches(rule.sourceRegex, url.pathname) &&
      conditionsHold(rule, url, headers)
    );
  });
}

/** The same question of a manifest's own rules; nothing is reserved by one that carries none. */
export function isReserved(
  manifest: ProjectManifest,
  url: URL,
  headers: Headers,
  beforeFilesOnly: boolean,
): boolean {
  if (manifest.reservedRoutes === undefined) {
    return false;
  }
  return pathIsReserved(manifest.reservedRoutes, url, headers, beforeFilesOnly);
}

/** Whether a pathname Next.js resolves exactly, with no shell, is what was asked for. */
export function isExactPathname(manifest: ProjectManifest, pathname: string): boolean {
  if (manifest.exactPathnames === undefined) {
    return false;
  }
  return Object.hasOwn(manifest.exactPathnames, pathname);
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
  for (const rule of manifest.headerRules) {
    const match = patternMatch(rule.sourceRegex, url.pathname);
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
      const pathname = substitutedPathname(parts, segment, depth);
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
  const preferred = substitutedPathname(parts, VALIDATION_SEGMENT);
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
