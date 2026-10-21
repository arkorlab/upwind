import type { EncodedShellRef } from '@stayingupwind/core/artifact';
import {
  type DeploymentBundle,
  dynamicRouting,
  edgeServablePrerenders,
  foldedHeaderRulesOf,
  headerRulesOf,
  placedRoutes,
  type Prerender,
  resumablePrerenders,
  routePagesData,
  routePayloads,
  type ServableOptions,
  spelledPrefixOf,
  staticFileAssetPrefixOf,
  staticFileLocalesOf,
  staticPagesMembersOf,
  staticFallbackPagesOf,
} from '@stayingupwind/core/bundle';
import { KEY_SCHEMA_VERSION } from '@stayingupwind/core/cache';
import type { DeploymentFingerprint } from '@stayingupwind/core/deployment';
import {
  type AppRuntime,
  buildProjectManifest,
  computeManifestId,
  MAX_MANIFEST_BYTES,
  type ProjectManifest,
  type RouteEntry,
  serializeManifest,
  type StaticFileEntry,
} from '@stayingupwind/core/manifest';
import { encodeUtf8 } from '@stayingupwind/core/util';
import { BuildTagBudget } from '@stayingupwind/host/bundle';
import { EDGE_ISOLATE_BUDGET_BYTES, manifestCharge } from '@stayingupwind/host/delivery';
import {
  nextSupportOf,
  nextVersionSupported,
  SUPPORTED_NEXT_RANGE,
} from '@stayingupwind/host/next-support';

import { routeBodiesOf } from './route-bodies.ts';
import {
  documentHeaderRule,
  type ManifestContext,
  maySetPreloadPolicy,
  middlewareMatchersOf,
  routeArtifactsOf,
  routeCachesOf,
  routeEntryOf,
  routePrerendersOf,
  routeSegmentsOf,
} from './routes.ts';
import { staticFileRequestKeysOf, staticFilesOf } from './static-files.ts';
import { pagesFallbacksOf, staticPagesOf } from './static-pages.ts';

/**
 * The manifest a deployment publishes, assembled from its build: everything the edge answers a
 * hosted route with, and nothing read or written on the way — what it is assembled from is handed
 * in, and storing it is the caller's.
 */

/**
 * Why a manifest is too large to publish, or `undefined` for one that is not: the edge keeps each
 * parsed, within the one budget its isolate holds shells, records and manifests against, and one
 * past `MAX_MANIFEST_BYTES` would take too much of it. Nor one within that, which lists so many
 * small entries that parsed it takes more than the whole budget (`manifestCharge`): no isolate
 * would hold it, and every request of the deployment would be passed through without it, its
 * `_next/` files among them, which its Workers do not carry. What makes it large is the build's —
 * its prerendered routes, files and rules — so the deployment is refused, as a bundle past any
 * other limit is.
 */
export function oversizedManifest(
  manifest: ProjectManifest,
  serialized: string,
): string | undefined {
  const bytes = encodeUtf8(serialized).byteLength;
  if (bytes > MAX_MANIFEST_BYTES) {
    return `this deployment's manifest comes to ${bytes} bytes; a manifest may be at most ${MAX_MANIFEST_BYTES}, so fewer prerendered routes, files or rules`;
  }
  const charge = Math.ceil(manifestCharge(manifest, bytes));
  return charge > EDGE_ISOLATE_BUDGET_BYTES
    ? `this deployment's manifest lists so many routes, files, pathnames and rules that the edge would take ${charge} bytes to hold it, past the ${EDGE_ISOLATE_BUDGET_BYTES} an isolate holds everything in, so fewer prerendered routes, files or rules`
    : undefined;
}

/**
 * Build membership is an optional improvement, never a reason to reject a previously publishable
 * deployment. Where it exceeds either the wire or parsed-memory budget, omit each complete list
 * before the final admission check. Unknown membership preserves the older reader's behavior.
 */
function withoutBuildTags(manifest: ProjectManifest): ProjectManifest {
  let changed = false;
  const routes: ProjectManifest['routes'] = {};
  for (const [pathname, route] of Object.entries(manifest.routes)) {
    if (route.cache?.buildTags === undefined) {
      routes[pathname] = route;
      continue;
    }
    const cache = { ...route.cache };
    delete cache.buildTags;
    changed = true;
    routes[pathname] = { ...route, cache };
  }
  const fitted = changed ? { ...manifest, routes } : manifest;
  return fitted;
}

/** Check optional aggregation without first cloning or serializing its tag objects. */
function boundedBuildTags(manifest: ProjectManifest): ProjectManifest {
  const budget = new BuildTagBudget();
  for (const route of Object.values(manifest.routes)) {
    if (route.cache !== undefined && budget.fit(route.cache) !== route.cache) {
      return withoutBuildTags(manifest);
    }
  }
  return manifest;
}

export function fitBuildTags(manifest: ProjectManifest): {
  readonly manifest: ProjectManifest;
  readonly serialized: string;
} {
  const bounded = boundedBuildTags(manifest);
  const serialized = serializeManifest(bounded);
  if (oversizedManifest(bounded, serialized) === undefined) {
    return { manifest: bounded, serialized };
  }
  const fitted = withoutBuildTags(bounded);
  return {
    manifest: fitted,
    serialized: fitted === bounded ? serialized : serializeManifest(fitted),
  };
}

/**
 * The pages a deployment's manifest routes, asked of the build as its servability is
 * (`ServableOptions`): every page the edge serves where the deployment has a runtime cache, and
 * only the pages the edge resumes where it has none. The edge tells a page the build finished from
 * one it resumes by the page's entry (`cache.delivery`), and without a runtime cache there is none:
 * it would resume a finished page and splice a render of the whole page behind it. Such a
 * deployment leaves those pages, and what the build wrote beside them, to its Function, which
 * serves them whole — and staging it imports none of their artifacts (`shellsOf`).
 */
export function routedPages(runtimeCache: boolean | undefined): ServableOptions {
  return { complete: runtimeCache !== false };
}

export interface AssembleManifestInput {
  readonly bundle: DeploymentBundle;
  /** The bundle of the deployment served just before this one, whose `_next/static` files stay. */
  readonly previous: DeploymentBundle | undefined;
  readonly projectId: string;
  readonly runId: string;
  readonly originHost: string;
  /** The deployment, which is also the cache scope its routes' entries were seeded under. */
  readonly deploymentId: string;
  readonly fingerprint: DeploymentFingerprint;
  readonly app: AppRuntime;
  /** When the manifest was generated: an ISO timestamp, the manifest's own. */
  readonly generatedAt: string;
  /** The renderings stored beside each shell and segment, by the digest of its identity bytes. */
  readonly encodings: ReadonlyMap<string, readonly EncodedShellRef[]>;
  /** What each shell's head names, by digest, as it was read when the shell was imported. */
  readonly preloads: Readonly<Record<string, readonly string[]>>;
  /** The CSP source that authorises the recovery script, added to every policy recorded here. */
  readonly recoverySource: string;
  /**
   * Whether the deployment has a runtime cache its routes are served from. `false` names none — no
   * entry on a route, no scope on the manifest — for a host that seeds none, whose edge then serves
   * each route from its shell alone, and routes no page the build finished: the edge tells one from
   * a page it resumes by its entry. Absent, it has one.
   */
  readonly runtimeCache?: boolean | undefined;
  /**
   * Whether the host judged the build's Next.js itself, when the deployment came in, and is
   * assembling one it already holds or serves. Absent, a build outside the versions deployed is
   * refused (`unsupportedNext`), as staging refuses it. Set, it is assembled whatever the range says
   * now: the range moves as the adapter's does, and a deployment admitted under the range of its own
   * day may be one it leaves out by the time it is assembled again.
   */
  readonly nextVersionJudged?: boolean | undefined;
}

export type AssembledManifest =
  | {
      readonly kind: 'assembled';
      readonly manifest: ProjectManifest;
      readonly manifestId: string;
      /** The manifest as it is stored, which its id is the digest of. */
      readonly serialized: string;
      readonly routes: readonly RouteEntry[];
      readonly staticFiles: Readonly<Record<string, StaticFileEntry>>;
      /** The rules the manifest publishes for the edge to route by (`dynamicRouting`). */
      readonly routing: ReturnType<typeof dynamicRouting>;
    }
  /**
   * Not to publish — too large (`oversizedManifest`), fingerprinted as another bundle, naming
   * another deployment's Functions, leaving out one the build places routes in, or built with a
   * Next.js outside the versions deployed (`unsupportedNext`) — and why.
   */
  | { readonly kind: 'refused'; readonly reason: string };

/**
 * Why a fingerprint is not this bundle's, or `undefined` for one that is. The edge holds every
 * request of the deployment to the one it names — a `dpl` its documents ask with, the build id its
 * continuations carry — so another bundle's would turn this one's own requests away, or take
 * another build's for them.
 */
function foreignFingerprint(
  bundle: DeploymentBundle,
  fingerprint: DeploymentFingerprint,
): string | undefined {
  if (fingerprint.dplId !== bundle.deploymentId) {
    return `the fingerprint names deployment ${fingerprint.dplId ?? '(none)'}, not ${bundle.deploymentId}`;
  }
  return fingerprint.buildId === undefined || fingerprint.buildId === bundle.buildId
    ? undefined
    : `the fingerprint names build ${fingerprint.buildId}, not ${bundle.buildId}`;
}

/**
 * Why the Functions a manifest would name are not those of the deployment it is assembled for, or
 * `undefined` for ones that are. The edge sends the deployment's requests to them, and tells them
 * where its scope stands under the id they carry (`AppRuntime.deploymentId`): the deployment the
 * routes' entries were seeded under (`deploymentId`). Another deployment's would answer this one's
 * requests, told of a scope this one's entries are not in.
 */
function foreignFunctions(input: AssembleManifestInput): string | undefined {
  const { app, deploymentId } = input;
  return app.deploymentId === deploymentId
    ? undefined
    : `the Functions handed in are ${app.deploymentId}'s, not ${deploymentId}'s`;
}

/**
 * Why the Functions handed in leave out one the build places routes in (`placedRoutes`), or
 * `undefined` where they name each. The edge reaches a Function only by the name `app.functions`
 * gives it, whether the manifest sends a request there or the first Function answers that the route
 * is that one's (`MISDIRECTED_STATUS`): a route placed in a Function they leave out is answered by
 * none. A manifest naming such a Function is refused where it is built (`buildProjectManifest`),
 * and refused here before that, as an answer rather than an error.
 */
export function unreachableFunctions(
  input: Pick<AssembleManifestInput, 'app' | 'bundle'>,
): string | undefined {
  const reachable = input.app.functions ?? {};
  const placed = new Set(placedRoutes(input.bundle.entrypoints).values());
  const unreachable = [...placed].filter((name) => !Object.hasOwn(reachable, name));
  return unreachable.length === 0
    ? undefined
    : `the build places routes in ${unreachable.join(', ')}, which the Functions handed in give no name to reach by (app.functions)`;
}

/**
 * Why the build's Next.js is outside the versions deployed, or `undefined` for one within them, or
 * for a build the host judged itself (`nextVersionJudged`). A build outside the adapter's range gets
 * nothing of what a host serves (`NextSupport`); one with limited support is deployed as any is.
 */
export function unsupportedNext(
  input: Pick<AssembleManifestInput, 'bundle' | 'nextVersionJudged'>,
): string | undefined {
  const { nextVersion } = input.bundle;
  if (input.nextVersionJudged === true || nextVersionSupported(nextVersion)) {
    return undefined;
  }
  const { min, max } = SUPPORTED_NEXT_RANGE;
  return `next ${nextVersion} is outside the versions deployed (>=${min.join('.')} <${max.join('.')})`;
}

/** Declared gates need an edge that asks them before any route is served. */
export function unsupportedGates(bundle: Pick<DeploymentBundle, 'gates'>): string | undefined {
  return bundle.gates === undefined
    ? undefined
    : 'the edge does not yet serve route gates; remove UPWIND_ROUTE_GATES until it does';
}

/** Why a build cannot be represented by what this edge serves. */
function manifestRefusal(input: AssembleManifestInput): string | undefined {
  return (
    foreignFingerprint(input.bundle, input.fingerprint) ??
    foreignFunctions(input) ??
    unreachableFunctions(input) ??
    unsupportedGates(input.bundle) ??
    unsupportedNext(input)
  );
}

function manifestPrerendersOf(
  bundle: DeploymentBundle,
  servable: Parameters<typeof edgeServablePrerenders>[1],
  cached: boolean,
): Prerender[] {
  const prerenders = new Set(edgeServablePrerenders(bundle, servable));
  if (cached) {
    for (const page of staticPagesMembersOf(bundle).keys()) prerenders.add(page);
    for (const page of staticFallbackPagesOf(bundle)) prerenders.add(page);
  }
  return [...prerenders];
}

/**
 * Assemble the manifest from the build: one entry per edge-servable prerender.
 *
 * A build of a Next.js outside the versions deployed is refused here as staging refuses it, so a
 * host that assembles from the pure modules, and never stages, has the same check by default; one
 * that judged the version itself when the deployment came in says so (`nextVersionJudged`).
 */
export async function assembleManifest(input: AssembleManifestInput): Promise<AssembledManifest> {
  const { bundle } = input;
  const refusal = manifestRefusal(input);
  if (refusal !== undefined) {
    return { kind: 'refused', reason: refusal };
  }
  // The scope is the deployment; the same derivation the seed used names each entry.
  const cached = input.runtimeCache !== false;
  const servable = routedPages(input.runtimeCache);
  const resumable = new Set(resumablePrerenders(bundle).map((prerender) => prerender.id));
  const prerenders = routePrerendersOf(manifestPrerendersOf(bundle, servable, cached), {
    bundle,
    resumable,
  });
  const caches = cached ? await routeCachesOf(bundle, input.deploymentId, prerenders) : new Map();
  const routeBodies = await routeBodiesOf(bundle, input.deploymentId, cached);
  const staticPages = await staticPagesOf(bundle, input.deploymentId, cached);
  const pagesFallbacks = pagesFallbacksOf(bundle, cached, input.encodings);
  const middlewareMatchers = middlewareMatchersOf(bundle);
  const rules = headerRulesOf(bundle);
  const context: ManifestContext = {
    bundle,
    placed: placedRoutes(bundle.entrypoints),
    encodings: input.encodings,
    preloads: input.preloads,
    caches,
    matchers: middlewareMatchers ?? [],
    policyRules: rules.filter(maySetPreloadPolicy),
    recoverySource: input.recoverySource,
    resumable,
    segments: routeSegmentsOf(bundle, input.encodings, servable),
    payloads: routeArtifactsOf(routePayloads(bundle, servable), input.encodings),
    pagesData: routeArtifactsOf(routePagesData(bundle, servable), input.encodings),
  };
  const routes = prerenders.flatMap((prerender) => {
    const entry = routeEntryOf(prerender, context);
    return entry === undefined ? [] : [entry];
  });
  const routeKeys = new Set(routes.map((route) => route.pathname));
  // The edge replays every rule that matches over a route's recorded headers, on each request
  // (`replayedDocumentHeaders`), so a policy a rule sets replaces the one recorded with the
  // recovery script permitted: the rule's has to permit it as well. Widened here, beside the
  // route's own, so that the serving path does no more than it did — and beside the rule's own
  // headers rather than over them: a file or an image the same rule matches carries no recovery
  // script, nor does a document the edge serves complete, and each keeps the policy the
  // application set.
  const headerRules = rules.map((rule) => documentHeaderRule(rule, context.recoverySource));
  // A build the edge does not route folds its unconditional rules into its routes' headers; they
  // travel apart as well, widened the same way, to be laid over a regenerated page's own headers.
  const foldedHeaderRules = foldedHeaderRulesOf(bundle)?.map((rule) =>
    documentHeaderRule(rule, context.recoverySource),
  );
  const staticFiles = staticFilesOf(bundle, input.previous);
  const staticFileLocales = staticFileLocalesOf(bundle);
  const staticFileAssetPrefix = staticFileAssetPrefixOf(bundle);
  // What the router reads of a path as written, which no page or file is found by decoding.
  const spelledPrefix = spelledPrefixOf(bundle);
  const routing = dynamicRouting(bundle, routeKeys);
  const built = buildProjectManifest({
    projectId: input.projectId,
    runId: input.runId,
    generatedAt: input.generatedAt,
    originHost: input.originHost,
    deployment: input.fingerprint,
    routes,
    routeBodies,
    staticPages,
    pagesFallbacks,
    app: input.app,
    staticFiles,
    ...(middlewareMatchers !== undefined && { middleware: { matchers: middlewareMatchers } }),
    ...routing,
    ...(headerRules.length > 0 && { headerRules }),
    ...(foldedHeaderRules !== undefined && { foldedHeaderRules }),
    // How the deployment's Functions fill a header's `$` references, which is how the edge fills
    // them for it. A bundle an earlier adapter wrote says nothing, and is filled as it always was.
    ...(bundle.routerReferences !== undefined && { routerReferences: bundle.routerReferences }),
    ...(bundle.config.images !== undefined && { images: bundle.config.images }),
    // The agents the application sends blocking metadata to — its own list, or Next.js's where it
    // names none: Next.js renders their pages whole, so the edge serves them no shell.
    ...(bundle.config.htmlLimitedBots !== undefined && {
      htmlLimitedBots: bundle.config.htmlLimitedBots,
    }),
    // Next.js streams a partially prerendered page to the crawlers it lists not from 16.3, and
    // renders it whole for every crawler before: such a build's crawlers are served no shell.
    crawlersStreamed: nextSupportOf(bundle.nextVersion) === 'full',
    ...(staticFileLocales !== undefined && { staticFileLocales }),
    ...(staticFileAssetPrefix !== undefined && { staticFileAssetPrefix }),
    ...(staticFileRequestKeysOf(bundle, input.previous) && { staticFileRequestKeys: true }),
    ...(spelledPrefix !== undefined && { spelledPrefix }),
    // Where a route holds a Pages Router page's props, what a client asks for them under.
    ...((context.pagesData.size > 0 || pagesFallbacks.length > 0) && {
      pagesDataUnder: { basePath: bundle.config.basePath, buildId: bundle.buildId },
    }),
    ...(cached && { cache: { keySchemaVersion: KEY_SCHEMA_VERSION, scopeId: input.deploymentId } }),
  });
  const { manifest, serialized } = fitBuildTags(built);
  const refused = oversizedManifest(manifest, serialized);
  if (refused !== undefined) {
    return { kind: 'refused', reason: refused };
  }
  return {
    kind: 'assembled',
    manifest,
    manifestId: await computeManifestId(manifest),
    serialized,
    routes: routes.map((route) => manifest.routes[route.pathname] ?? route),
    staticFiles,
    routing,
  };
}
