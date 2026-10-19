import {
  type BlobRef,
  cacheablePrerenders,
  edgeServablePrerenders,
  functionOfPrerender,
  headerRulesOf,
  placedRoutes,
  type Prerender,
  PRIMARY_FUNCTION,
  resumablePrerenders,
  routePathnameOf,
  shellHeaders,
} from '@stayingupwind/core/bundle';
import type { RouteCache, RouteEntry, RouteSegment } from '@stayingupwind/core/manifest';
import { allowRecoveryScript, sandboxBlocksRecovery } from '@stayingupwind/core/request';
import { compareCodeUnits } from '@stayingupwind/core/util';
import { bundleGeneratedAtMs, seedRouteFor } from '@stayingupwind/host/bundle';
import {
  scanPreloadLinks,
  withoutAdvertised,
  withoutForbidden,
} from '@stayingupwind/host/preloads';
import { recoveryScriptCspSource } from '@stayingupwind/host/splice';

import { type CheckedStack, failed, type Verdict } from './answers.ts';
import { builtPartsOf, type BuiltParts } from './parts.ts';
import { blobBytesOf } from './shells.ts';

/**
 * The routes of the manifest the edge serves by, held to the pages the build prerendered for the
 * edge (`checkStack`): each one there, as the build wrote it and as a deploy routes it, and none
 * besides — judged by the build, not by the manifest under check, which a document's verdict
 * reads its route from.
 */

/** Where a verdict is kept, by what was asked. */
interface Tallies {
  add(asked: string, verdict: Verdict): void;
}

/**
 * Whether a deploy leaves a prerender to the deployment's Function on purpose, routing none for it
 * (`routeEntryOf` in the deploy): a resumable shell whose policy sandboxes away the script that
 * recovers a document whose continuation failed.
 */
function leftToFunction(stack: CheckedStack, prerender: Prerender, resumable: ReadonlySet<string>) {
  const policy = shellHeaders(stack.bundle, prerender)['content-security-policy'];
  return (
    resumable.has(prerender.id) &&
    policy !== undefined &&
    sandboxBlocksRecovery(policy) !== undefined
  );
}

/**
 * Why a route of the manifest is not the page the build prerendered for it, as a deploy holds one:
 * held at all, and as the shell the build wrote — its bytes, its type and its length, which the
 * document is judged by below and served as. Its status needs no word: the manifest's schema holds
 * every route to 200 (`routeEntrySchema`), the only status a page the edge serves is prerendered
 * with (`edgeServablePrerenders`), and a manifest holding another is none a deploy can build.
 */
function heldShellFailure(
  held: RouteEntry | undefined,
  prerender: { readonly body: BlobRef; readonly owner: string },
): string | undefined {
  if (held === undefined) {
    return 'prerendered by the build for the edge to serve, and held by no route of the manifest the edge serves by';
  }
  const { body, owner } = prerender;
  // The Function that resumes and regenerates it, which a shell asked for fresh never shows.
  const heldBy = held.function ?? PRIMARY_FUNCTION;
  if (heldBy !== owner) {
    return `held by the manifest the edge serves by as a route of the ${heldBy} Function, not of the ${owner} one the build places it in`;
  }
  if (held.shell.sha256 !== body.sha256) {
    return 'held by the manifest the edge serves by as another shell than the build wrote';
  }
  if (held.shell.contentType !== body.contentType) {
    return `held by the manifest the edge serves by with its shell's type ${held.shell.contentType}, not the ${body.contentType} the build wrote`;
  }
  return held.shell.byteLength === body.byteLength
    ? undefined
    : `held by the manifest the edge serves by with its shell's length ${held.shell.byteLength}, not the ${body.byteLength} the build wrote`;
}

/** The pages a deploy routes, by the name it routes each under, and the names it leaves out. */
interface Routed {
  readonly named: ReadonlyMap<string, Prerender & { readonly body: BlobRef }>;
  readonly leftOut: ReadonlySet<string>;
}

/**
 * The pages a deploy makes routes of (`routeEntryOf`): every one the build prerendered for the edge
 * with a shell, under the name it routes it by (`routePathnameOf`) — the later of two named alike,
 * as a manifest holds it — but those it leaves to the Function on purpose (`leftToFunction`).
 */
function routedOf(stack: CheckedStack): Routed {
  const { bundle } = stack;
  const resumable = new Set(resumablePrerenders(bundle).map((prerender) => prerender.id));
  const named = new Map<string, Prerender & { readonly body: BlobRef }>();
  const leftOut = new Set<string>();
  const servable = edgeServablePrerenders(bundle, { complete: true });
  for (const prerender of servable) {
    const { body } = prerender;
    if (body === undefined) {
      continue;
    }
    const pathname = routePathnameOf(bundle, prerender);
    if (leftToFunction(stack, prerender, resumable)) {
      leftOut.add(pathname);
    } else {
      named.set(pathname, { ...prerender, body });
    }
  }
  return { named, leftOut };
}

/** The names a deploy routes the build's pages under, as `routedOf` finds them. */
export function routedPathnames(stack: CheckedStack): ReadonlySet<string> {
  return new Set(routedOf(stack).named.keys());
}

/** Why a page a deploy leaves to the Function on purpose is held as a route all the same. */
const LEFT_TO_FUNCTION =
  "held by the manifest the edge serves by as a shell, though its policy sandboxes away the script that recovers a failed continuation, which leaves it to the deployment's Function";

/**
 * Every page the build prerendered for the edge to serve (`edgeServablePrerenders`, as a deploy
 * reads it), held by a route of the manifest the edge serves by, under the name a deploy gives it
 * (`routePathnameOf`), as the shell the build wrote: one a deploy left out would be asked for by
 * nothing below, and one held otherwise judged by what it holds. Of two a deploy names alike, the
 * later it holds, as a manifest holds it. And none it leaves to the Function on purpose — a
 * resumable shell whose policy sandboxes away the recovery script — held all the same, which would
 * be served with nothing to rescue a failed continuation.
 */
export async function unheldRoutes(stack: CheckedStack, tally: Tallies): Promise<void> {
  const { bundle, manifest } = stack;
  const recovery = await recoveryScriptCspSource();
  const parts = builtPartsOf(bundle);
  const caches = await seededCaches(stack);
  const placed = placedRoutes(bundle.entrypoints);
  const { named, leftOut } = routedOf(stack);
  const routeAt = (pathname: string): RouteEntry | undefined =>
    Object.hasOwn(manifest.routes, pathname) ? manifest.routes[pathname] : undefined;
  for (const [pathname, prerender] of named) {
    const held = routeAt(pathname);
    const owner = functionOfPrerender(placed, prerender);
    const failure =
      heldShellFailure(held, { body: prerender.body, owner }) ??
      (held === undefined
        ? undefined
        : (heldRouteFailure(held, deployedAs(stack, prerender, { pathname, recovery, caches })) ??
          heldPartsFailure(held, parts, prerender.pathname)));
    if (failure !== undefined) {
      tally.add(pathname, failed(failure));
    }
  }
  for (const pathname of leftOut) {
    if (!named.has(pathname) && routeAt(pathname) !== undefined) {
      tally.add(pathname, failed(LEFT_TO_FUNCTION));
    }
  }
  unprerenderedRoutes(manifest.routes, { named, leftOut }, tally);
}

/** Why a route fails, where the build prerendered no page for the edge under its name. */
const UNPRERENDERED_ROUTE =
  'held by the manifest the edge serves by as a route, though the build prerendered no page for the edge to serve under its name';

/**
 * Every route of the manifest that no page the build prerendered for the edge is named by (`named`),
 * nor one a deploy leaves to the Function (`leftOut`, which fails apart): a deploy makes a route of
 * nothing else (`routeEntryOf`), so one besides is a deploy's own, however soundly it is served.
 */
function unprerenderedRoutes(
  routes: Readonly<Record<string, RouteEntry>>,
  expected: { readonly named: ReadonlyMap<string, unknown>; readonly leftOut: ReadonlySet<string> },
  tally: Tallies,
): void {
  for (const pathname of Object.keys(routes)) {
    if (!expected.named.has(pathname) && !expected.leftOut.has(pathname)) {
      tally.add(pathname, failed(UNPRERENDERED_ROUTE));
    }
  }
}

/** What a deploy routes a page as, by what the build prerendered (`routeEntryOf`). */
interface Prerendered {
  /** The page's own id, by which a resume asks for its postponed state (`prerenderId`). */
  readonly id: string;
  /**
   * The headers the build's shell is answered with (`shellHeaders`), the edge's recovery script
   * permitted on its policy (`allowRecoveryScript`) where the edge may resume it, as a deploy
   * records them.
   */
  readonly headers: Readonly<Record<string, string>>;
  readonly bypassFor: Prerender['bypassFor'];
  /** The hints a deploy names on the route (`preloadsOf`). */
  readonly preloads: readonly string[];
  /** The entry the cache was seeded with for the page, where it was seeded one (`seededCaches`). */
  readonly cache: RouteCache | undefined;
}

/** Whether the build's middleware covers a route a deploy names hints on, as a deploy judges it. */
function middlewareCoversRoute(stack: CheckedStack, pathname: string): boolean {
  const matchers = stack.bundle.middleware?.matchers ?? [];
  // A class's members are any pathname, which the middleware may cover where it covers any.
  if (pathname.includes('[')) {
    return matchers.length > 0;
  }
  // Compiled by Next.js for its own router: case-insensitive, without the unicode flag.
  // eslint-disable-next-line security/detect-non-literal-regexp, require-unicode-regexp
  return matchers.some((matcher) => new RegExp(matcher.sourceRegex, 'i').test(pathname));
}

/** The policies a hint answers to (`withoutForbidden`), by the lowercase names they go by. */
const POLICY_HEADERS: ReadonlySet<string> = new Set(['content-security-policy', 'referrer-policy']);

/**
 * The headers of each rule the edge judges on each request — one with a condition — that sets a
 * policy a hint answers to and may hold for a request of the route, as a deploy judges it: one whose
 * pattern names the route, and any at all for a class, whose members are any pathname. Named as a
 * route's own headers are, in lowercase.
 */
function policyRulesOver(stack: CheckedStack, pathname: string): Record<string, string>[] {
  return headerRulesOf(stack.bundle).flatMap((rule) => {
    const lowercase = Object.fromEntries(
      Object.entries(rule.headers).map(([name, value]) => [name.toLowerCase(), value]),
    );
    const conditional = rule.has !== undefined || rule.missing !== undefined;
    const covers =
      pathname.includes('[') ||
      // eslint-disable-next-line security/detect-non-literal-regexp, require-unicode-regexp
      new RegExp(rule.sourceRegex, 'i').test(pathname);
    return conditional && covers && Object.keys(lowercase).some((name) => POLICY_HEADERS.has(name))
      ? [lowercase]
      : [];
  });
}

/**
 * The hints a deploy names on a route (`routeEntryOf`): what its shell's head preloads
 * (`scanPreloadLinks`) — none where the build's middleware covers the route, which may set a `Link`
 * of its own — less what the route's own `Link` already preloads and what its policies forbid, its
 * own and those a rule judged on each request lays over them.
 */
function preloadsOf(
  stack: CheckedStack,
  shell: BlobRef,
  route: { readonly pathname: string; readonly headers: Readonly<Record<string, string>> },
): string[] {
  const bytes = blobBytesOf(stack, shell.sha256);
  const named =
    bytes === undefined || middlewareCoversRoute(stack, route.pathname)
      ? []
      : scanPreloadLinks(bytes);
  let kept = withoutForbidden(withoutAdvertised(named, route.headers['link']), route.headers);
  for (const rule of policyRulesOver(stack, route.pathname)) {
    kept = withoutForbidden(kept, { ...route.headers, ...rule });
  }
  return kept;
}

/** What a deploy routes the page as (`routeEntryOf`), under the name it routes it by. */
function deployedAs(
  stack: CheckedStack,
  prerender: Prerender & { readonly body: BlobRef },
  named: {
    readonly pathname: string;
    readonly recovery: string;
    readonly caches: ReadonlyMap<string, RouteCache>;
  },
): Prerendered {
  const cache = named.caches.get(prerender.id);
  const built = shellHeaders(stack.bundle, prerender);
  // A page the edge serves whole has no continuation to recover from, and keeps its own policy.
  const headers =
    cache?.delivery === 'complete' ? built : allowRecoveryScript(built, named.recovery);
  return {
    id: prerender.id,
    headers,
    bypassFor: prerender.bypassFor,
    preloads: preloadsOf(stack, prerender.body, { pathname: named.pathname, headers }),
    cache,
  };
}

/**
 * The entry of every page the stack seeded its cache with, by the page's id, as a deploy seeds it
 * (`seedRouteFor`): under the deployment's scope, its id, its kind, and whether the edge resumes it.
 */
async function seededCaches(stack: CheckedStack): Promise<ReadonlyMap<string, RouteCache>> {
  const { bundle } = stack;
  const context = { scopeId: stack.deploymentId, generatedAt: bundleGeneratedAtMs(bundle) };
  const caches = new Map<string, RouteCache>();
  for (const prerender of cacheablePrerenders(bundle)) {
    const seeded = await seedRouteFor(bundle, prerender, context);
    if (seeded?.cache !== undefined) {
      caches.set(prerender.id, seeded.cache);
    }
  }
  return caches;
}

/**
 * Why a route of the manifest is not routed as a deploy routes the page the build prerendered: with
 * the headers the build's shell is answered with, as a deploy holds them — permitting the edge's
 * recovery script on the policy of a page it may resume, which a policy held without it would keep
 * from running — the
 * requests the build leaves to the Function (`bypassFor`), and under the entry the cache was seeded
 * with for the page (`cacheFailure`). A document's verdict reads each from the route, so one dropped
 * or changed would be agreed with.
 */
function heldRouteFailure(held: RouteEntry, built: Prerendered): string | undefined {
  const expected = built.headers;
  const names = new Set(Object.keys(expected));
  for (const name of Object.keys(held.headers)) {
    names.add(name);
  }
  const differing = [...names]
    .toSorted(compareCodeUnits)
    .find((name) => expected[name] !== held.headers[name]);
  if (differing !== undefined) {
    return `held by the manifest the edge serves by with ${differing} ${held.headers[differing] ?? 'none'}, not the ${expected[differing] ?? 'none'} the build's shell is answered with`;
  }
  const bypassFor =
    built.bypassFor !== undefined && built.bypassFor.length > 0 ? built.bypassFor : undefined;
  if (JSON.stringify(held.bypassFor) !== JSON.stringify(bypassFor)) {
    return `held by the manifest the edge serves by as bypassed for ${JSON.stringify(held.bypassFor ?? [])}, not the ${JSON.stringify(bypassFor ?? [])} the build prerendered it with`;
  }
  if (held.prerenderId !== built.id) {
    return `held by the manifest the edge serves by as the page ${held.prerenderId ?? 'none'}, which a resume asks for the state of, not the ${built.id} the build prerendered`;
  }
  const preloads = JSON.stringify(held.preloads ?? []);
  if (preloads !== JSON.stringify(built.preloads)) {
    return `held by the manifest the edge serves by with the hints ${preloads}, not the ${JSON.stringify(built.preloads)} a deploy names from the build's shell`;
  }
  return cacheFailure(held.cache, built.cache);
}

/** A route's entry, in a verdict's words. */
function describedCache(cache: RouteCache): string {
  const filed = cache.route === undefined ? '' : ` filed under ${cache.route}`;
  return `the ${cache.kind} entry ${cache.entryId}${filed}`;
}

/**
 * Why the entry a route is held under is not the one the cache was seeded with for its page: the
 * same entry — its id, its kind, the route a class's is filed under — which the edge reads and has
 * regenerated by, and delivered as the build left the page, resumed or whole; and none where the
 * cache was seeded with none. A route held with no entry the stack seeded one for is served from
 * its build's shell for good, never from the record the cache keeps of it.
 */
function cacheFailure(
  held: RouteCache | undefined,
  seeded: RouteCache | undefined,
): string | undefined {
  if (held === undefined) {
    return seeded === undefined
      ? undefined
      : `held by the manifest the edge serves by under no entry, though the cache was seeded with ${describedCache(seeded)} for the page`;
  }
  if (seeded === undefined) {
    return `held by the manifest the edge serves by under ${describedCache(held)}, though the cache was seeded with no entry for the page`;
  }
  if (held.entryId !== seeded.entryId || held.kind !== seeded.kind || held.route !== seeded.route) {
    return `held by the manifest the edge serves by under ${describedCache(held)}, not ${describedCache(seeded)} the cache was seeded with`;
  }
  if (held.delivery === seeded.delivery) {
    return undefined;
  }
  return held.delivery === 'complete'
    ? 'held by the manifest the edge serves by as a page whole in itself, though the build prerendered it to be resumed'
    : 'held by the manifest the edge serves by as a page to be resumed, though the build prerendered it whole';
}

/** A part's bytes, in a verdict's words. */
function describedPart(part: BlobRef | undefined): string {
  return part === undefined
    ? 'none'
    : `${part.byteLength} bytes of ${part.contentType} (${part.sha256})`;
}

/** Whether a part the manifest holds is the one the build wrote: both none, or the same bytes. */
function samePart(held: RouteSegment | undefined, built: BlobRef | undefined): boolean {
  if (held === undefined || built === undefined) {
    return held === undefined && built === undefined;
  }
  const { artifact } = held;
  return (
    artifact.sha256 === built.sha256 &&
    artifact.byteLength === built.byteLength &&
    artifact.contentType === built.contentType
  );
}

/**
 * Why a route's parts are not the ones the build wrote for its page (`builtPartsOf`): each prefetch
 * segment, the whole payload, the props — none the build wrote left out, none besides, each as the
 * bytes the build wrote. The edge answers a part as the route holds it, and the check asks for each
 * the build wrote (`parts.ts`): one the route leaves out the edge hands on to the Function, whose
 * answer is the application's, and one it holds besides it serves, asked for by nothing.
 */
function heldPartsFailure(
  held: RouteEntry,
  built: BuiltParts,
  /**
   * The pathname the build named the page by — its prerender's own, not the name a deploy routes it
   * under — which `builtPartsOf` keys each part by, as `partsOf` finds it (`BuiltParts.documents`).
   */
  document: string,
): string | undefined {
  const heldSegments = held.segments ?? {};
  const builtSegments = built.segments.get(document) ?? new Map<string, BlobRef>();
  const paths = new Set(Object.keys(heldSegments));
  for (const path of builtSegments.keys()) {
    paths.add(path);
  }
  for (const path of [...paths].toSorted(compareCodeUnits)) {
    const heldSegment = Object.hasOwn(heldSegments, path) ? heldSegments[path] : undefined;
    const builtSegment = builtSegments.get(path);
    if (!samePart(heldSegment, builtSegment)) {
      return `held by the manifest the edge serves by with its prefetch segment ${path} as ${describedPart(heldSegment?.artifact)}, not the ${describedPart(builtSegment)} the build wrote`;
    }
  }
  const named: readonly (readonly [string, RouteSegment | undefined, BlobRef | undefined])[] = [
    ['whole payload', held.payload, built.payloads.get(document)],
    ["page's props", held.pagesData, built.pagesData.get(document)?.body],
  ];
  const differing = named.find(([, heldPart, builtPart]) => !samePart(heldPart, builtPart));
  return differing === undefined
    ? undefined
    : `held by the manifest the edge serves by with its ${differing[0]} as ${describedPart(differing[1]?.artifact)}, not the ${describedPart(differing[2])} the build wrote`;
}
