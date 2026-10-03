import { z } from 'zod';

import { sha256HexSchema } from '../artifact/artifact.ts';
import { cronsSchema } from '../cron/schema.ts';
import { checkedImagesConfigSchema } from '../images/config.ts';
import { runnableSourceRegexSchema, unsafeRoutePatternReason } from '../request/pattern-safety.ts';
import { isId } from '../util/id.ts';

/**
 * The deployment bundle: what the Next.js adapter writes at the end of `next build`, and the only
 * thing a host needs to run an application. Every file the bundle names is a blob addressed by
 * its SHA-256, so an upload sends only what the host has never seen, and two deployments that
 * share a chunk share its storage.
 */

export const BUNDLE_VERSION = 1;

/**
 * The version of a bundle whose routes the build split across more than one app Function
 * (`functions.split`). Everything a version-1 bundle says, a version-2 one says the same way; what
 * it adds is that the app Function is no longer the only place a route's code is.
 *
 * A version of its own, rather than an optional field a version-1 reader could drop, because
 * dropping it is the one wrong thing to do: a reader that knew nothing of the split would take the
 * first Function for the whole application and run it, and every route of the others would answer
 * not-found. A reader that knows only version 1 refuses this one outright. A bundle that was not
 * split stays version 1, byte for byte what it was.
 */
export const SPLIT_BUNDLE_VERSION = 2;

/**
 * How many app Functions one bundle may run as. Each is a Function a host uploads, keeps and wakes
 * apart from the others, so a split is meant to come to a handful; this is far past any the
 * adapter's planner makes, and is here so that no bundle can ask for thousands.
 */
export const MAX_APP_FUNCTIONS = 32;

/**
 * The name of an app Function after the first: `app-2`, `app-3` and on, which is how the adapter
 * names them. The first is `app`, and is `functions.app` itself rather than a key of `split`.
 */
export const splitFunctionNameSchema = z
  .string()
  .regex(/^app-(?:[2-9]|[1-9]\d+)$/u, 'expected app-2, app-3, …');

export const DEPLOYMENT_ID_PREFIX = 'dpl';

export const deploymentIdSchema = z
  .string()
  .refine((value) => isId(DEPLOYMENT_ID_PREFIX, value), 'expected a deployment id');

/**
 * What a blob is served as.
 *
 * The adapter writes a media type, but the bundle is uploaded as JSON by whoever owns the project,
 * and this string is put in a `content-type` header — by the edge on the hot path, by the shell
 * a reader that frames a build's shells, by the Cache API write behind a static file. A value a header cannot hold makes the
 * response fail to build where it is served rather than where it was accepted, so the upload is
 * where it is refused: printable ASCII (no newline can split a response, no control character can
 * confuse a parser) with the slash a media type has.
 */
const contentTypeSchema = z
  .string()
  .min(1)
  .regex(/^[\u{20}-\u{7E}]+$/u, 'expected printable ASCII')
  .refine((value) => value.includes('/'), 'expected a media type');

/** A file in the bundle, named by content. */
export const blobRefSchema = z.object({
  sha256: sha256HexSchema,
  byteLength: z.number().int().nonnegative(),
  contentType: contentTypeSchema,
});
export type BlobRef = z.infer<typeof blobRefSchema>;

export const routeHasSchema = z.object({
  type: z.enum(['header', 'cookie', 'query', 'host']),
  key: z.string().optional(),
  value: z.string().optional(),
});
export type RouteHas = z.infer<typeof routeHasSchema>;

/**
 * The same condition, with its pattern held to what the edge may run on a shared Function.
 *
 * A condition's value is tested against a header, cookie or query value the visitor chose, so a
 * pattern that backtracks catastrophically is CPU any caller can spend. Refused here, at the
 * upload, rather than guarded per request: the edge does no more work than it did.
 */
const uploadedRouteHasSchema = routeHasSchema.superRefine((condition, ctx) => {
  const reason =
    condition.value === undefined ? undefined : unsafeRoutePatternReason(condition.value);
  if (reason !== undefined) {
    ctx.addIssue({
      code: 'custom',
      message: `unusable condition pattern: ${reason}`,
      path: ['value'],
    });
  }
});

/**
 * A header name as RFC 9110 defines one: a token. `$` is a token character, so the `$1` and
 * `$name` references Next.js compiles a parameterized key into are names like any other.
 */
const HEADER_NAME = /^[!#$%&'*+\-.^`|~\w]+$/u;
/** A value `Headers` takes: no NUL, CR or LF, and no character a single byte cannot carry. */
const HEADER_VALUE = /^[^\0\n\r\u{100}-\u{10FFFF}]*$/u;
/**
 * The edge and the Function set these on responses they build, and `Headers` throws on a name or a
 * value it refuses: out of every request that reaches the rule or the page, long after the upload
 * that could have said so. Refused here instead, as a content type is.
 */
const headerNameSchema = z.string().regex(HEADER_NAME, 'must be a header name');
const headerTextSchema = z.string().regex(HEADER_VALUE, 'must be a value a header can carry');
const headersSchema = z.record(headerNameSchema, headerTextSchema);
const headerValueSchema = z.union([headerTextSchema, z.array(headerTextSchema)]);
/** Response headers as Next.js records them: a header set more than once is an array. */
const headerValuesSchema = z.record(headerNameSchema, headerValueSchema);
/** What `Response` takes: a status outside 200–599 throws where the response is built. */
const LOWEST_RESPONSE_STATUS = 200;
const HIGHEST_RESPONSE_STATUS = 599;
const responseStatusSchema = z
  .number()
  .int()
  .min(LOWEST_RESPONSE_STATUS)
  .max(HIGHEST_RESPONSE_STATUS);

/** One routing rule as Next.js emits it: a compiled regex plus what to do on a match. */
export const routeSchema = z.object({
  source: z.string().optional(),
  sourceRegex: runnableSourceRegexSchema,
  destination: z.string().optional(),
  headers: headersSchema.optional(),
  has: z.array(uploadedRouteHasSchema).optional(),
  missing: z.array(uploadedRouteHasSchema).optional(),
  status: responseStatusSchema.optional(),
  priority: z.boolean().optional(),
});
export type Route = z.infer<typeof routeSchema>;

/** The routing phases from `onBuildComplete`, verbatim, so the runtime resolves exactly as Next would. */
export const routingSchema = z.object({
  beforeMiddleware: z.array(routeSchema),
  middlewareMatchers: z.array(routeSchema),
  beforeFiles: z.array(routeSchema),
  afterFiles: z.array(routeSchema),
  dynamicRoutes: z.array(routeSchema),
  onMatch: z.array(routeSchema),
  fallback: z.array(routeSchema),
  shouldNormalizeNextData: z.boolean(),
  rsc: z.looseObject({
    header: z.string(),
    varyHeader: z.string(),
    prefetchHeader: z.string(),
    didPostponeHeader: z.string(),
    contentTypeHeader: z.string(),
    suffix: z.string(),
    prefetchSuffix: z.string().optional(),
    prefetchSegmentHeader: z.string(),
    prefetchSegmentSuffix: z.string(),
    prefetchSegmentDirSuffix: z.string(),
  }),
});
export type Routing = z.infer<typeof routingSchema>;

export const entrypointKindSchema = z.enum(['app-page', 'app-route', 'pages', 'pages-api']);
export type EntrypointKind = z.infer<typeof entrypointKindSchema>;

/** A route that runs code. Its module is part of the app Function and is required by `id`. */
export const entrypointSchema = z.object({
  id: z.string().min(1),
  kind: entrypointKindSchema,
  /** URL pathname as Next.js routes it (the source page for dynamic routes, e.g. `/[locale]`). */
  pathname: z.string().startsWith('/'),
  /**
   * Present only on a route the build put on Next.js's deprecated edge runtime. Such a route is
   * answered by a Web handler the Function loads from its own bundle, and — this is what the field
   * is read for — it cannot resume a postponed shell: Next.js's edge template renders with
   * `postponed: undefined`, so nothing it renders is the rest of a document.
   */
  runtime: z.literal('edge').optional(),
  /**
   * The app Function this route's code is in, when the build split the routes across more than
   * one: a key of `functions.split`. Absent for a route of the first, `app` — which is every route
   * of a bundle that was not split. A host sends the route's requests to that Function, and the
   * Function that is handed a request for a route it does not hold says which one does.
   */
  function: splitFunctionNameSchema.optional(),
});
export type Entrypoint = z.infer<typeof entrypointSchema>;

/**
 * Where an entrypoint's code sits in the application's own source tree, as the Adapter API states
 * it: `sourcePage` is `/[locale]/(site)/(legal)/terms/page` for the route `/[locale]/terms`.
 *
 * Next.js takes every route group (`(site)`) and parallel slot (`@modal`) out of a pathname
 * (`normalizeAppPath`), so no pathname can be read back into the folders the author wrote — the
 * build is the only place that still knows them, and this is where it says so. The Adapters RFC
 * names `sourcePage` as what replaces reading `app-path-routes-manifest.json`, which is
 * undocumented and versioned apart from Next.js.
 *
 * Recorded verbatim, in the two shapes Next.js emits (`build/adapter/build-complete.ts`): an App
 * Router entry keeps its leading slash and its `page` or `route` file (`/blog/[slug]/page`), a
 * Pages Router entry has neither (`blog/[slug]`).
 *
 * The adapter builds the Function's runtime manifest without this field (`index.ts`): nothing at
 * request time routes by a source page, and a Function that parsed these at every cold start would
 * spend the time before its first byte on what only a reader of the build ever looks at.
 */
export const sourcePageSchema = z.object({
  /** The entrypoint this is the source of, by its `id`. */
  id: z.string().min(1),
  sourcePage: z.string().min(1),
});
export type SourcePage = z.infer<typeof sourcePageSchema>;

export const prerenderRouteTypeSchema = z.enum(['route', 'fallback', 'shell', 'page']);
export const prerenderResponseSchema = z.enum(['empty', 'initial', 'complete']);
export const prerenderComputeSchema = z.enum(['blocking', 'resuming', 'static']);

/**
 * A prerendered response, or the reusable shell of one. `body` is the bytes the build produced
 * (HTML, RSC payload, segment) and `postponed` the state a resume needs to finish the document.
 * Both come from the same build, which is what makes serving one with the other correct.
 */
export const prerenderSchema = z.object({
  id: z.string().min(1),
  pathname: z.string().startsWith('/'),
  /** The source route this prerender belongs to (`/[locale]` for `/en`), under the `basePath`. */
  route: z.string().startsWith('/'),
  parentOutputId: z.string().min(1),
  groupId: z.number().int(),
  routeType: prerenderRouteTypeSchema.optional(),
  response: prerenderResponseSchema.optional(),
  compute: prerenderComputeSchema.optional(),
  renderingMode: z.enum(['STATIC', 'PARTIALLY_STATIC']).optional(),
  htmlSize: z.number().int().nonnegative().optional(),
  /**
   * The value of `next-router-segment-prefetch` this output answers, for one the build wrote as a
   * prefetch segment of its group's document. Read off the pathname the build gave it, against the
   * suffixes the build declared (`segmentPathOf`).
   *
   * Absent on every other output, and on a bundle from before this was recorded — a reader that
   * finds none has a build's prefetches to hand to the deployment's Function, not a build without
   * any.
   */
  segmentPath: z.string().startsWith('/').optional(),
  body: blobRefSchema.optional(),
  postponed: blobRefSchema.optional(),
  initialStatus: responseStatusSchema.optional(),
  initialHeaders: headerValuesSchema.optional(),
  /**
   * The lifetime the build gave the prerender, as Next.js hands it over: seconds until it is
   * stale, or `false` for no time-based revalidation (on-demand invalidation still applies).
   */
  initialRevalidate: z.union([z.number().nonnegative(), z.literal(false)]).optional(),
  /** Seconds after which the prerender may no longer be served stale. */
  initialExpiration: z.number().nonnegative().optional(),
  pprChain: z.object({ headers: headersSchema }).optional(),
  allowQuery: z.array(z.string()).optional(),
  /** The request headers an ISR render may see. Never part of a cache key. */
  allowHeader: z.array(z.string()).optional(),
  /** Run by the edge against the visitor's headers on every request for the page, as a route's are. */
  bypassFor: z.array(uploadedRouteHasSchema).optional(),
  /** `false`: the route admits no parameters beyond the prerendered ones; recorded, not relied on. */
  parentFallbackMode: z.union([z.boolean(), z.null(), z.string()]).optional(),
  /** A shell to be specialized in the background; recorded, not relied on. */
  partialFallback: z.boolean().optional(),
});
export type Prerender = z.infer<typeof prerenderSchema>;

export const staticFileSchema = z.object({
  pathname: z.string().startsWith('/'),
  blob: blobRefSchema,
  /** Content-addressed by Next.js itself: safe to cache forever and to share across deployments. */
  immutable: z.boolean(),
});
export type StaticFile = z.infer<typeof staticFileSchema>;

export const sourceMapKindSchema = z.enum(['client', 'function']);
export type SourceMapKind = z.infer<typeof sourceMapKindSchema>;

/**
 * A source map the deployment carries but nothing serves.
 *
 * `client` maps are named by the pathname of the file they describe (`/_next/static/chunks/x.js`),
 * because that is what a browser's stack frame says. `function` maps are named by the module
 * inside the Function (`app.cjs`), because that is what a server's stack frame says. Either way
 * the name is what a reader looks the map up by, having read a frame.
 *
 * Deliberately not a `StaticFile`. Next.js serves the browser maps it emits, and a deployment
 * that published them would publish the application's source with it; these travel as blobs, are
 * stored by the host, and are served to nobody.
 */
export const sourceMapSchema = z.object({
  kind: sourceMapKindSchema,
  /** What a stack frame names: a served pathname, or a module inside the Function. */
  name: z.string().min(1),
  blob: blobRefSchema,
});
export type SourceMapRef = z.infer<typeof sourceMapSchema>;

export const functionModuleTypeSchema = z.enum(['esm', 'commonjs', 'text', 'json', 'wasm', 'data']);
export type FunctionModuleType = z.infer<typeof functionModuleTypeSchema>;

export const functionModuleSchema = z.object({
  /** Module path inside the Function (`index.mjs`, `.next/server/app-paths-manifest.json`). */
  name: z.string().min(1),
  type: functionModuleTypeSchema,
  blob: blobRefSchema,
});
export type FunctionModule = z.infer<typeof functionModuleSchema>;

/** A Function as it will be uploaded: its modules, entry, and the runtime it was built for. */
export const functionSchema = z.object({
  mainModule: z.string().min(1),
  modules: z.array(functionModuleSchema),
  compatibilityDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  compatibilityFlags: z.array(z.string()),
});
export type FunctionSpec = z.infer<typeof functionSchema>;

const i18nDomainSchema = z.object({
  defaultLocale: z.string(),
  domain: z.string(),
  http: z.literal(true).optional(),
  locales: z.array(z.string()).optional(),
});
const i18nSchema = z.object({
  defaultLocale: z.string(),
  locales: z.array(z.string()),
  localeDetection: z.literal(false).optional(),
  domains: z.array(i18nDomainSchema).optional(),
});

/** One `cacheLife` profile as Next.js resolved it; a field it left out is left out here too. */
export const cacheLifeProfileSchema = z.object({
  stale: z.number().nonnegative().optional(),
  revalidate: z.number().nonnegative().optional(),
  expire: z.number().nonnegative().optional(),
});
export type CacheLifeProfile = z.infer<typeof cacheLifeProfileSchema>;

/** The subset of `next.config` the runtime and the edge need at request time. */
export const bundleConfigSchema = z.looseObject({
  basePath: z.string(),
  /**
   * The path the application's `_next` files are served under as well as under the base path:
   * for an `assetPrefix` (the pathname of one that is a URL), `next build` rewrites
   * `<assetPrefix>/_next/:path+` to `<basePath>/_next/:path+` before the filesystem is checked.
   * Absent where it writes no such rewrite.
   */
  assetPrefix: z.string().min(1).optional(),
  trailingSlash: z.boolean(),
  skipTrailingSlashRedirect: z.boolean(),
  skipProxyUrlNormalize: z.boolean().optional(),
  /**
   * The user agents Next.js sends blocking metadata to, as the pattern it tests them with
   * (`htmlLimitedBots`, its own list when the app names none): the Function renders a partially
   * prerendered page whole for them, as Next.js does; a manifest carries it on for the edge to
   * judge them by (`ProjectManifest.htmlLimitedBots`).
   */
  htmlLimitedBots: z.string().optional(),
  poweredByHeader: z.boolean(),
  i18n: i18nSchema.nullable().optional(),
  /** What `/_next/image` enforces; absent when the build left `next/image` unoptimized. */
  images: checkedImagesConfigSchema.optional(),
  /** Whether the app is on Cache Components (`use cache`) rather than route-level ISR. */
  cacheComponents: z.boolean().optional(),
  /** Whether prefetches carry only the static part of a route (Next.js's `'unstable_eager'` counts). */
  partialPrefetching: z.boolean().optional(),
  /** `expireTime`: the `stale-while-revalidate` window Next.js states for ISR responses. */
  expireTime: z.number().nonnegative().optional(),
  /** The `cacheLife` profiles after Next.js resolved them: what a runtime lifetime by name means. */
  cacheLife: z.record(z.string(), cacheLifeProfileSchema).optional(),
  /**
   * `experimental.proxyClientMaxBodySize`, in bytes: how much of a request body the middleware
   * may read. Absent from a bundle built before it was carried, which leaves Next.js's default.
   */
  proxyClientMaxBodySize: z.number().int().positive().optional(),
});
export type BundleConfig = z.infer<typeof bundleConfigSchema>;

const bundleSchema = z.object({
  v: z.union([z.literal(BUNDLE_VERSION), z.literal(SPLIT_BUNDLE_VERSION)]),
  deploymentId: deploymentIdSchema,
  nextVersion: z.string().min(1),
  buildId: z.string().min(1),
  /** The Next.js project directory relative to the repository root (`apps/site`, say). */
  projectDir: z.string(),
  generatedAt: z.iso.datetime(),
  config: bundleConfigSchema,
  routing: routingSchema,
  /**
   * What a request must carry to be in draft mode: the value Next.js gives the build, which it
   * compares its `__prerender_bypass` cookie against (`previewModeId`). A request carrying it
   * asks for the page rendered now, so the deployment's Function renders it instead of answering
   * from what the build wrote. One value per build, and absent for a build with no prerenders.
   */
  bypassToken: z.string().min(1).optional(),
  entrypoints: z.array(entrypointSchema),
  /**
   * Optional: a bundle an earlier adapter wrote has none, and a reader shows what it can of a
   * deployment it did not build rather than refusing it.
   */
  sourcePages: z.array(sourcePageSchema).optional(),
  /**
   * The cron jobs the project declared, from `upwind.config.ts`, `upwind.jsonc`, `upwind.json`
   * or `vercel.json`. Absent for a build that declared none, which is every build made before
   * this field existed.
   */
  crons: cronsSchema.optional(),
  middleware: z.object({ matchers: z.array(routeSchema) }).optional(),
  prerenders: z.array(prerenderSchema),
  staticFiles: z.array(staticFileSchema),
  /**
   * The maps from what the build emitted back to what the project wrote. Optional: a bundle from
   * an adapter that did not carry them has none, and a host that does not ask for them gets none.
   */
  sourceMaps: z.array(sourceMapSchema).optional(),
  functions: z.object({
    /** The application's code: every route's, or — when `split` is there — the first group's. */
    app: functionSchema,
    middleware: functionSchema.optional(),
    /**
     * The app Functions after the first, by name, when the build split the routes across them
     * (`SPLIT_BUNDLE_VERSION`). Each carries its own routes' code and prerendered bodies, and every
     * one of them carries the same `runtime.json`, so each knows where every route is.
     */
    split: z.record(splitFunctionNameSchema, functionSchema).optional(),
  }),
});
export type DeploymentBundle = z.infer<typeof bundleSchema>;

/**
 * How many routing rules a deployment may carry: every phase of `routing`, and the middleware's
 * matchers. The edge and the Function walk them in order on every request, so a table is only as
 * long as a request can afford to walk. A large application's table runs to a couple of hundred
 * rules; this is twenty times that, rounded.
 */
export const MAX_ROUTING_RULES = 5000;
/**
 * How many image patterns a deployment may carry — `remotePatterns`, `localPatterns` and
 * `domains` together — which every `/_next/image` request walks.
 */
export const MAX_IMAGE_PATTERNS = 200;

function routingRuleCount(bundle: DeploymentBundle): number {
  const { routing } = bundle;
  const phases = [
    routing.beforeMiddleware,
    routing.middlewareMatchers,
    routing.beforeFiles,
    routing.afterFiles,
    routing.dynamicRoutes,
    routing.onMatch,
    routing.fallback,
  ];
  return phases.reduce(
    (total, rules) => total + rules.length,
    bundle.middleware?.matchers.length ?? 0,
  );
}

function imagePatternCount(bundle: DeploymentBundle): number {
  const { images } = bundle.config;
  return images === undefined
    ? 0
    : images.remotePatterns.length + images.localPatterns.length + images.domains.length;
}

/** What of the bundle is past what a deployment may carry, said as the refusal says it. */
function limitsPassed(bundle: DeploymentBundle): string[] {
  const passed: string[] = [];
  const rules = routingRuleCount(bundle);
  if (rules > MAX_ROUTING_RULES) {
    passed.push(
      `a deployment may carry at most ${MAX_ROUTING_RULES} routing rules; this one carries ${rules}`,
    );
  }
  const patterns = imagePatternCount(bundle);
  if (patterns > MAX_IMAGE_PATTERNS) {
    passed.push(
      `a deployment may carry at most ${MAX_IMAGE_PATTERNS} image patterns; this one carries ${patterns}`,
    );
  }
  return passed;
}

/**
 * What of a split is not as a host has to be able to read it: a version that does not say whether
 * the bundle is split, a route placed in a Function the bundle does not carry, a Function that
 * holds no route at all.
 *
 * A route with no `function` is the first Function's, so an unsplit bundle — no `split`, no route
 * placed — passes untouched, and so does a split one whose every named Function answers a route.
 */
function splitIssues(bundle: DeploymentBundle): string[] {
  const split = bundle.functions.split;
  const names = Object.keys(split ?? {});
  const issues: string[] = [];
  if (split !== undefined && names.length === 0) {
    issues.push('functions.split names no Function; a bundle that was not split leaves it out');
  }
  if ((bundle.v === SPLIT_BUNDLE_VERSION) !== names.length > 0) {
    issues.push(
      `a bundle with functions.split is version ${SPLIT_BUNDLE_VERSION}, and only such a bundle is`,
    );
  }
  if (names.length + 1 > MAX_APP_FUNCTIONS) {
    issues.push(
      `a deployment may run as at most ${MAX_APP_FUNCTIONS} app Functions; this one runs as ${names.length + 1}`,
    );
  }
  const placed = new Set<string>();
  for (const entry of bundle.entrypoints) {
    if (entry.function === undefined) {
      continue;
    }
    if (!names.includes(entry.function)) {
      issues.push(
        `${entry.id} is placed in ${entry.function}, which functions.split does not carry`,
      );
    }
    placed.add(entry.function);
  }
  for (const name of names) {
    if (!placed.has(name)) {
      issues.push(`functions.split carries ${name}, which no entrypoint is placed in`);
    }
  }
  return issues;
}

/**
 * Every occurrence is checked before collection can collapse references with the same digest, and
 * the tables the edge walks per request are held to what a request can afford.
 */
export const deploymentBundleSchema = bundleSchema
  .superRefine((bundle, ctx) => {
    const lengths = new Map<string, number>();
    forEachBlob(bundle, (ref) => {
      const previous = lengths.get(ref.sha256);
      if (previous !== undefined && previous !== ref.byteLength) {
        ctx.addIssue({
          code: 'custom',
          message: `blob ${ref.sha256} has conflicting byteLength declarations`,
        });
      }
      lengths.set(ref.sha256, ref.byteLength);
    });
  })
  .superRefine((bundle, ctx) => {
    for (const message of limitsPassed(bundle)) {
      ctx.addIssue({ code: 'custom', message });
    }
  })
  .superRefine((bundle, ctx) => {
    for (const message of splitIssues(bundle)) {
      ctx.addIssue({ code: 'custom', message });
    }
  });

/** The complete reference walk shared by validation and collection. */
function forEachBlob(bundle: DeploymentBundle, visit: (ref: BlobRef) => void): void {
  const add = (ref: BlobRef | undefined): void => {
    if (ref !== undefined) {
      visit(ref);
    }
  };
  for (const prerender of bundle.prerenders) {
    add(prerender.body);
    add(prerender.postponed);
  }
  for (const file of bundle.staticFiles) {
    add(file.blob);
  }
  if (bundle.sourceMaps !== undefined) {
    for (const map of bundle.sourceMaps) {
      add(map.blob);
    }
  }
  const functions = [
    bundle.functions.app,
    bundle.functions.middleware,
    ...Object.values(bundle.functions.split ?? {}),
  ];
  for (const spec of functions) {
    if (spec === undefined) {
      continue;
    }
    for (const module of spec.modules) {
      add(module.blob);
    }
  }
}

/** Every blob a validated bundle references, deduplicated by content. */
export function bundleBlobs(bundle: DeploymentBundle): Map<string, BlobRef> {
  const blobs = new Map<string, BlobRef>();
  forEachBlob(bundle, (ref) => blobs.set(ref.sha256, ref));
  return blobs;
}
