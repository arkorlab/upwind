import type { EncodedShellRef } from '@stayingupwind/core/artifact';
import {
  type DeploymentBundle,
  dynamicRouting,
  edgeServablePrerenders,
  foldedHeaderRulesOf,
  headerRulesOf,
  placedRoutes,
  resumablePrerenders,
  routePagesData,
  routePayloads,
  type ServableOptions,
  staticFileAssetPrefixOf,
  staticFileLocalesOf,
} from '@stayingupwind/core/bundle';
import { KEY_SCHEMA_VERSION } from '@stayingupwind/core/cache';
import type { DeploymentFingerprint } from '@stayingupwind/core/deployment';
import {
  type AppRuntime,
  buildProjectManifest,
  computeManifestId,
  type HeaderRule,
  MAX_MANIFEST_BYTES,
  type ProjectManifest,
  type RouteEntry,
  serializeManifest,
  type StaticFileEntry,
} from '@stayingupwind/core/manifest';
import { allowRecoveryScript } from '@stayingupwind/core/request';
import { encodeUtf8 } from '@stayingupwind/core/util';
import { EDGE_ISOLATE_BUDGET_BYTES, manifestCharge } from '@stayingupwind/host/delivery';
import { nextSupportOf } from '@stayingupwind/host/next-support';

import {
  type ManifestContext,
  middlewareMatchersOf,
  routeArtifactsOf,
  routeCachesOf,
  routeEntryOf,
  routeSegmentsOf,
} from './routes.ts';
import { staticFilesOf } from './static-files.ts';

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

/** The policies a hint answers to (`withoutForbidden`), by the lowercase names they go by. */
const POLICY_HEADERS: ReadonlySet<string> = new Set(['content-security-policy', 'referrer-policy']);

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
  /** Not to publish — too large (`oversizedManifest`), or fingerprinted as another bundle — and why. */
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

/** Assemble the manifest from the build: one entry per edge-servable prerender. */
export async function assembleManifest(input: AssembleManifestInput): Promise<AssembledManifest> {
  const { bundle } = input;
  const foreign = foreignFingerprint(bundle, input.fingerprint);
  if (foreign !== undefined) {
    return { kind: 'refused', reason: foreign };
  }
  // The scope is the deployment; the same derivation the seed used names each entry.
  const cached = input.runtimeCache !== false;
  const servable = routedPages(input.runtimeCache);
  const prerenders = edgeServablePrerenders(bundle, servable);
  const caches = cached ? await routeCachesOf(bundle, input.deploymentId) : new Map();
  const middlewareMatchers = middlewareMatchersOf(bundle);
  const rules = headerRulesOf(bundle);
  const context: ManifestContext = {
    bundle,
    placed: placedRoutes(bundle.entrypoints),
    encodings: input.encodings,
    preloads: input.preloads,
    caches,
    matchers: middlewareMatchers ?? [],
    policyRules: rules.filter((rule) => {
      return (
        (rule.has !== undefined || rule.missing !== undefined) &&
        Object.keys(rule.headers).some((name) => POLICY_HEADERS.has(name.toLowerCase()))
      );
    }),
    recoverySource: input.recoverySource,
    resumable: new Set(resumablePrerenders(bundle).map((prerender) => prerender.id)),
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
  // script, and keeps the policy the application set.
  const forDocuments = (rule: HeaderRule): HeaderRule => {
    const widened = allowRecoveryScript(rule.headers, context.recoverySource);
    const changed = Object.entries(rule.headers).some(([name, value]) => widened[name] !== value);
    return changed ? { ...rule, documentHeaders: widened } : rule;
  };
  const headerRules = rules.map((rule) => forDocuments(rule));
  // A build the edge does not route folds its unconditional rules into its routes' headers; they
  // travel apart as well, widened the same way, to be laid over a regenerated page's own headers.
  const foldedHeaderRules = foldedHeaderRulesOf(bundle)?.map((rule) => forDocuments(rule));
  const staticFiles = staticFilesOf(bundle, input.previous);
  const staticFileLocales = staticFileLocalesOf(bundle);
  const staticFileAssetPrefix = staticFileAssetPrefixOf(bundle);
  const routing = dynamicRouting(bundle, routeKeys);
  const manifest = buildProjectManifest({
    projectId: input.projectId,
    runId: input.runId,
    generatedAt: input.generatedAt,
    originHost: input.originHost,
    deployment: input.fingerprint,
    routes,
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
    // Where a route holds a Pages Router page's props, what a client asks for them under.
    ...(context.pagesData.size > 0 && {
      pagesDataUnder: { basePath: bundle.config.basePath, buildId: bundle.buildId },
    }),
    ...(cached && { cache: { keySchemaVersion: KEY_SCHEMA_VERSION, scopeId: input.deploymentId } }),
  });
  const serialized = serializeManifest(manifest);
  const refused = oversizedManifest(manifest, serialized);
  if (refused !== undefined) {
    return { kind: 'refused', reason: refused };
  }
  return {
    kind: 'assembled',
    manifest,
    manifestId: await computeManifestId(manifest),
    serialized,
    routes,
    staticFiles,
    routing,
  };
}
