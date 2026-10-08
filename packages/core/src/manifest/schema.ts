import { z } from 'zod';

import { artifactRefSchema, sha256HexSchema, shellEncodingsSchema } from '../artifact/artifact.ts';
import {
  routeHasSchema,
  routerReferencesSchema,
  splitFunctionNameSchema,
} from '../bundle/schema.ts';
import { KEY_SCHEMA_VERSION } from '../cache/keys.ts';
import { deploymentFingerprintSchema } from '../deployment/fingerprint.ts';
import { imagesConfigSchema } from '../images/config.ts';

/**
 * Bumped when a manifest starts to mean something an older reader would get wrong. An edge that
 * does not know the version refuses the manifest and proxies the project, which is the safe side.
 * Not bumped for a field an older reader drops and serves no worse without than it did before
 * the field existed: for the window of a rolling deployment of the edge, what such a reader
 * loses is the field's improvement, where a version it does not know would lose it every route
 * of the project.
 *
 * Nor is what a version accepts ever narrowed: a reader of a version takes every manifest a
 * writer of it wrote, so that a rollout of the edge never refuses a manifest it served the day
 * before. What a manifest may not carry is refused where it is written — at the build and at
 * the upload — not where it is read.
 *
 * 4: a build with a `basePath` is routed at the edge, its dynamic routes and its rules with it, and
 * a rule of `next.config` is matched without regard to case, as Next.js's router matches it. A
 * reader of 3 matched rules by case: given such a build, it would serve a class's shell where a
 * rule spelled in another case claims the path (`/Shop/:slug` for `/docs/shop/x`).
 *
 * 5: a header's `$` references are filled the way the deployment's Functions fill them, which is in
 * one pass where the manifest says `routerReferences: 'one-pass'`. A reader of 4 drops the field
 * and fills every header in turn: given such a deployment, it would answer a `$10` against one
 * capture with the capture and a `0`, where the deployment's Function answers `$10`.
 *
 * 6: a stored manifest may name a route's headers, conditions and preloads by their place in its
 * `tables` (`stored.ts`). A reader of 4 or 5 would take those places for the values themselves.
 */
export const MANIFEST_SCHEMA_VERSION = 6;
/** The first version a manifest may store what its routes repeat in `tables` at (above). */
export const TABLES_SCHEMA_VERSION = 6;
/** The version before, which `routerReferences` was first published at. */
const ONE_PASS_REFERENCES_VERSION = 5;
/** The version before that, which every manifest published until 5 was. */
const PREVIOUS_MANIFEST_SCHEMA_VERSION = 4;
/** The version before that, which every manifest published until 4 was, and some still are. */
const EARLIEST_READ_MANIFEST_SCHEMA_VERSION = 3;
/**
 * Every version a manifest is read at: this one, and each one before it that a writer published
 * and a reader has accepted since, whose manifests are still served (above).
 */
export const READ_MANIFEST_SCHEMA_VERSIONS = [
  EARLIEST_READ_MANIFEST_SCHEMA_VERSION,
  PREVIOUS_MANIFEST_SCHEMA_VERSION,
  ONE_PASS_REFERENCES_VERSION,
  MANIFEST_SCHEMA_VERSION,
] as const;
const HTTP_OK = 200;

/**
 * The runtime cache entry a route's document is the current generation of. Present for a route
 * whose build the cache was seeded from; the edge then reads the entry's delivery record, and
 * asks the deployment's Function to regenerate it.
 */
export const routeCacheSchema = z.object({
  entryId: z.string().min(1),
  kind: z.enum(['app-page', 'pages']),
  /** `resume`: the deployment's Function completes the document; `complete`: the document is whole. */
  delivery: z.enum(['resume', 'complete']),
  /**
   * The route the build filed a class shell under, which the runtime keys the class's entry by and a
   * member's own entry beside it (`concreteUpgrade`): `/[locale]/[orgSlug]` for `/en/[orgSlug]`.
   * Absent for a route that is no class, and in a manifest from before it was named, where the
   * class's pathname stands in for it.
   */
  route: z.string().startsWith('/').optional(),
});
export type RouteCache = z.infer<typeof routeCacheSchema>;

/** The scope a manifest's cache entries belong to: one deployment, under one key schema. */
export const manifestCacheSchema = z.object({
  keySchemaVersion: z.literal(KEY_SCHEMA_VERSION),
  scopeId: z.string().min(1),
});
export type ManifestCache = z.infer<typeof manifestCacheSchema>;

/**
 * How many of a shell's render-blocking resources are worth naming on the response, and how long
 * one of those names may be.
 *
 * A `Link` header is read by every hop between here and the browser, and Cloudflare's Early Hints
 * cache replays it before the Function runs; six values of a couple of hundred characters keep it a
 * header rather than a payload. A page with more render-blocking resources than that has a problem
 * this cannot fix.
 */
export const MAX_PRELOAD_LINKS = 6;
export const MAX_PRELOAD_LINK_LENGTH = 256;

/** `Link` values, as `<href>; rel=preload; as=…`; see `shellPreloadLinks`. */
export const preloadLinksSchema = z
  .array(z.string().min(1).max(MAX_PRELOAD_LINK_LENGTH))
  .min(1)
  .max(MAX_PRELOAD_LINKS);

/**
 * One prefetch segment a host holds: the bytes the build wrote for it, and the pre-compressed
 * renderings of those bytes where the run produced them — the same pair a route's own shell
 * travels as, for the same reason. A segment is an RSC payload, which is text, and compresses
 * like one.
 *
 * `segments` held a bare `ArtifactRef` between the field being added and this, and changing its
 * shape narrows nothing: **no writer ever set it.** The field was added ahead of the host that
 * would fill it, and this is that host's shape. What the rule on `MANIFEST_SCHEMA_VERSION` forbids
 * is refusing a manifest that was served the day before — and there is no such manifest to refuse.
 */
export const routeSegmentSchema = z.object({
  artifact: artifactRefSchema,
  encodings: shellEncodingsSchema.optional(),
});
export type RouteSegment = z.infer<typeof routeSegmentSchema>;

/** One route the build prerendered: its pathname, its shell artifact and its response headers. */
export const routeEntrySchema = z.object({
  pathname: z.string().startsWith('/'),
  status: z.literal(HTTP_OK),
  shell: artifactRefSchema,
  /**
   * Pre-compressed renderings of `shell`, when the run produced them. Optional so a manifest from
   * before compression existed still parses and simply serves identity.
   */
  shellEncodings: shellEncodingsSchema.optional(),
  /**
   * The route's prefetch segments, by the value of `next-router-segment-prefetch` each answers
   * (`prefetchSegments`). A host that holds these in its own storage names them here and answers a
   * prefetch itself; one that leaves prefetches to the deployment's Function carries none, and so
   * does a build that wrote none.
   *
   * A reader that does not know the field drops it and hands every prefetch to the Function, which
   * is what every reader did before the field existed — so no schema version turns on it.
   */
  segments: z.record(z.string().startsWith('/'), routeSegmentSchema).optional(),
  /**
   * The page's whole React Server Components payload, as the build wrote it beside a document it
   * finished (`routePayloads`): what a router's request for the page — `rsc: 1`, naming no part of
   * it — is answered with. Held, like `segments`, by a host that answers such a request itself.
   *
   * Absent for a page a resume completes, whose payload is rendered for the request, and on a
   * manifest from before the field: a reader that does not know it hands every such request to the
   * Function, as every reader did, so no schema version turns on it.
   */
  payload: routeSegmentSchema.optional(),
  /**
   * A Pages Router page's props, as the build wrote them beside a document it finished
   * (`routePagesData`): what a client navigation's `<basePath>/_next/data/<buildId>/<page>.json` is
   * answered with, at the manifest's `pagesDataPrefix`. Absent on every other route and on a
   * manifest from before the field, whose reader leaves every such request to the Function, as
   * before.
   */
  pagesData: routeSegmentSchema.optional(),
  headers: z.record(z.string(), z.string()),
  /**
   * The route's policy permits any inline script, which the nonce the edge mints stops it doing.
   *
   * Absent unless it is true, so the canonical JSON the manifest id is taken over skips it and no
   * deployment whose policies say nothing of the sort publishes a different manifest for it.
   */
  cspUnsafeInline: z.literal(true).optional(),
  /**
   * The build's prerender this shell came from. The runtime holds the postponed state under this
   * id, so a resume names it rather than carrying the state over the wire.
   */
  prerenderId: z.string().min(1).optional(),
  /** The runtime cache entry the route is served from, when the deployment has a cache. */
  cache: routeCacheSchema.optional(),
  /**
   * Conditions under which Next.js would not serve the prerender at all (a Server Action, a
   * multipart body): any one holding sends the request to the deployment's Function untouched.
   */
  bypassFor: z.array(routeHasSchema).optional(),
  /**
   * The render-blocking resources this shell's own head names, as `Link` values for the response.
   *
   * Read once from the build's bytes rather than per request: the shell is content-addressed, so
   * they cannot change without a new deployment, and parsing HTML in front of a first byte is the
   * one thing this path may not do. Absent when the head named none the build had not already
   * advertised, so the canonical JSON the manifest id is taken over is unchanged there.
   */
  preloads: preloadLinksSchema.optional(),
  /**
   * The app Function the route's code is in, when the build split the routes across more than one
   * (`AppRuntime.functions`): where its resume and its regeneration go. Absent for the first
   * Function's routes, which is every route of a deployment that was not split.
   */
  function: splitFunctionNameSchema.optional(),
});
export type RouteEntry = z.infer<typeof routeEntrySchema>;

/**
 * How long the edge waits on the resume that completes a shell. There is one way to obtain the
 * dynamic suffix — ask the deployment's own Function for what the postponed state left out — so
 * what travels here is the budget, not a choice of mechanism.
 */
export const continuationConfigSchema = z.object({
  firstByteTimeoutMs: z.number().int().positive(),
  totalTimeoutMs: z.number().int().positive(),
});
export type ContinuationConfig = z.infer<typeof continuationConfigSchema>;

export const assetPathClassSchema = z.enum([
  'immutable',
  'chunks',
  'css',
  'media',
  'runtime',
  'build-manifests',
]);
export type AssetPathClass = z.infer<typeof assetPathClassSchema>;

export const assetPolicySchema = z.object({
  pathClasses: z.array(assetPathClassSchema),
  /**
   * Largest asset the edge will hold. A subrequest carries no `Content-Length`, so this bounds a
   * read rather than a comparison against a declared size: an asset past it is delivered in full
   * and left to the caches after the edge.
   */
  maxBytes: z.number().int().positive(),
});
export type AssetPolicy = z.infer<typeof assetPolicySchema>;

/** The Functions a deployment runs as. */
export const appRuntimeSchema = z.object({
  deploymentId: z.string().min(1),
  /** The user Function in the applications namespace that serves every request the edge does not. */
  scriptName: z.string().min(1),
  /** A small Function holding only the middleware, dispatched before a shell is served. */
  middlewareScriptName: z.string().min(1).optional(),
  /**
   * The app Functions after the first, by the name the bundle gives each (`app-2`, …), with the
   * name each is reached by — `scriptName` being the first's. Present only for a deployment whose
   * build split its routes across them (`functions.split`): each route is answered by the Function
   * its entrypoint is placed in, and a request no table places goes to the first, which answers it
   * or names the Function that does.
   *
   * An edge that does not know the field drops it and sends every request to the first Function,
   * which then names another for the routes it does not hold — an answer only an edge that knows
   * the field can act on. No schema version turns on it, because none would help: an edge that
   * refused the manifest would send everything to the first Function all the same. What keeps such
   * an edge from serving a split deployment is the order a host rolls out in.
   */
  functions: z.record(splitFunctionNameSchema, z.string().min(1)).optional(),
});
export type AppRuntime = z.infer<typeof appRuntimeSchema>;

/** The bytes of a static file, as storage holds them under the hash. */
const staticFileBytesSchema = z.object({
  sha256: sha256HexSchema,
  byteLength: z.number().int().nonnegative(),
  contentType: z.string().min(1),
});

/**
 * A file the edge serves from storage without asking anyone: `_next/static`, `public/`, 404 pages.
 *
 * `deploymentId` and `previous` are what the manifest keeps of the deployment served just before,
 * for the documents of that deployment still open in browsers, which ask for their own files by
 * their own `dpl`. An edge that does not know the fields drops them and answers such a request as
 * it did before they existed — with the Function's 404 — which is why they are not a schema version
 * (see `MANIFEST_SCHEMA_VERSION`).
 */
export const staticFileEntrySchema = staticFileBytesSchema
  .extend({
    /**
     * Content-addressed by the build: cacheable forever, shared across deployments, and the same
     * bytes whichever deployment asks for the name.
     */
    immutable: z.boolean(),
    /**
     * The status the file is answered with, when it is not 200: an error document's, which the
     * host reads off the file's name under the build's `basePath` — a name the edge, which does not
     * know the `basePath`, cannot tell from a `public/` file's.
     */
    status: z.number().int().positive().optional(),
    /** The deployment that built the file, when it is not the manifest's own. */
    deploymentId: z.string().min(1).optional(),
    /**
     * A kept build (`deploymentId`) that answers only a request whose `dpl` names its deployment,
     * set by whoever keeps it. Its name is one the manifest's own deployment answers itself: a file
     * under a build id both builds have — Next.js gives every build with a `deploymentId` the same
     * build id (`getBuildId`) — at a path this deployment ships nothing at, such as under a
     * `basePath` the deployment before had. A request naming no deployment is the manifest's own
     * deployment's, and its routing answers it (`staticFileBuildWithoutDpl`). A reader that does
     * not know the field answers every request with the kept build, as before the field existed.
     */
    dplOnly: z.literal(true).optional(),
    /**
     * The same name as the deployment before built it, when the name is not a content hash — a
     * build manifest under a build id that stays the same from build to build. Its documents ask
     * for the name by their deployment, and get the bytes that deployment gave it.
     */
    previous: staticFileBytesSchema.extend({ deploymentId: z.string().min(1) }).optional(),
  })
  .superRefine((entry, ctx) => {
    // On the manifest's own build, `dplOnly` would name no deployment to answer, and a reader that
    // finds no kept build answers every request with the file.
    if (entry.dplOnly === true && entry.deploymentId === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: '`dplOnly` is said of a kept build, which names its `deploymentId`',
        path: ['dplOnly'],
      });
    }
  });
export type StaticFileEntry = z.infer<typeof staticFileEntrySchema>;

/**
 * A pattern as Next.js compiled it, read as the upload that checked it to compile wrote it (see
 * `MANIFEST_SCHEMA_VERSION` on why it is not checked again here).
 */
const patternSchema = z.string().min(1);

export const middlewareMatcherSchema = z.object({
  sourceRegex: patternSchema,
  has: z.array(routeHasSchema).optional(),
  missing: z.array(routeHasSchema).optional(),
});
export type MiddlewareMatcher = z.infer<typeof middlewareMatcherSchema>;
const middlewareConfigSchema = z.object({ matchers: z.array(middlewareMatcherSchema) });
const staticFilesSchema = z.record(z.string().startsWith('/'), staticFileEntrySchema);

/**
 * What a host needs to serve a member of a dynamic route that has no class shell from the record a
 * runtime cache makes of it: the first request for the member is rendered by the deployment's
 * Function, which keeps the render — an App Router page whose unknown members block on their
 * render, or a Pages Router page with `fallback` — and every request after it may be answered from
 * that record without the Function.
 *
 * `route` and `kind` are what the record's entry is keyed by with the member's pathname
 * (`deriveEntry`): the route the build filed the class under, which is not always the template a
 * request matches (`/[locale]/blog/[slug]` for `/en/blog/[slug]`). `bypassFor` is the class's, as a
 * route's is (`routeEntrySchema`).
 *
 * A reader that does not know the field drops it and sends every member to the Function, as every
 * reader did before the field existed — so no schema version turns on it.
 */
export const memberRouteSchema = z.object({
  route: z.string().startsWith('/'),
  kind: z.enum(['app-page', 'pages']),
  bypassFor: z.array(routeHasSchema).optional(),
});
export type MemberRoute = z.infer<typeof memberRouteSchema>;

/**
 * One of the application's dynamic route matchers, as Next.js compiled and ordered them. The
 * first whose pattern and conditions match a pathname is the route Next.js would serve; `route`
 * names the entry in `routes` holding that class's shell, when the build produced one, and
 * `members` what serves a member from its record when it did not.
 */
export const dynamicRouteSchema = z.object({
  sourceRegex: patternSchema,
  has: z.array(routeHasSchema).optional(),
  missing: z.array(routeHasSchema).optional(),
  route: z.string().startsWith('/').optional(),
  members: memberRouteSchema.optional(),
  /**
   * The app Function the route's code is in, when that is not the first (`AppRuntime.functions`):
   * where a request of the class goes when nothing ahead of the dynamic routes claims it.
   */
  function: splitFunctionNameSchema.optional(),
});
export type DynamicRoute = z.infer<typeof dynamicRouteSchema>;
/**
 * A rule Next.js evaluates before its dynamic routes (a redirect, a rewrite); the edge stays out.
 * One evaluated before the filesystem as well — a redirect, a `beforeFiles` rewrite — claims a
 * shipped file's path too; an `afterFiles` rewrite does not.
 */
const reservedRouteSchema = middlewareMatcherSchema.extend({
  beforeFiles: z.literal(true).optional(),
});
export type ReservedRoute = z.infer<typeof reservedRouteSchema>;
/** Pathnames Next.js resolves exactly, ahead of its dynamic routes, that hold no shell. */
const exactPathnamesSchema = z.record(z.string().startsWith('/'), z.literal(true));
/**
 * Of the pathnames Next.js resolves exactly — `exactPathnames`, and the members of a route the build
 * prerendered without a shell — the ones an app Function other than the first answers, with its
 * name. Present only for a deployment whose routes are split (`AppRuntime.functions`).
 */
const exactFunctionsSchema = z.record(z.string().startsWith('/'), splitFunctionNameSchema);
/**
 * A `next.config` header rule, as Next.js compiled it: judged on each request, in the order the
 * rules were declared, for a shell and for a shipped file alike. An unconditional rule is folded
 * into each route's headers at deployment as well, which is what an app the edge does not
 * reproduce the routing of is left with.
 */
export const headerRuleSchema = z.object({
  sourceRegex: patternSchema,
  has: z.array(routeHasSchema).optional(),
  missing: z.array(routeHasSchema).optional(),
  headers: z.record(z.string(), z.string()),
  /**
   * What a document the edge composes takes from the rule in place of `headers`: the policy the rule
   * sets with the edge's recovery script permitted, which such a document may carry and nothing else
   * the rule matches can. Absent where the rule sets no policy it widens.
   */
  documentHeaders: z.record(z.string(), z.string()).optional(),
});
export type HeaderRule = z.infer<typeof headerRuleSchema>;

const staticFileLocalesSchema = z.object({
  basePath: z.string(),
  locales: z.array(z.string().min(1)).min(1),
});
export type StaticFileLocales = z.infer<typeof staticFileLocalesSchema>;

const staticFileAssetPrefixSchema = z.object({
  basePath: z.string(),
  assetPrefix: z.string().min(1),
});
export type StaticFileAssetPrefix = z.infer<typeof staticFileAssetPrefixSchema>;

const manifestFields = {
  projectId: z.string().min(1),
  runId: z.string().min(1),
  generatedAt: z.iso.datetime(),
  /** Where the deployment is published: its own preview host, or a hostname in front of it. */
  origin: z.object({
    scheme: z.literal('https'),
    host: z.string().min(1),
  }),
  deployment: deploymentFingerprintSchema,
  continuation: continuationConfigSchema,
  routes: z.record(z.string().startsWith('/'), routeEntrySchema),
  assetPolicy: assetPolicySchema,
};

/**
 * The provider-agnostic contract between a host and any delivery topology.
 * Nothing in here refers to particular storage, keys or strategies.
 */
export const projectManifestSchema = z.object({
  ...manifestFields,
  schemaVersion: z.literal(READ_MANIFEST_SCHEMA_VERSIONS),
  /** The Functions this deployment runs as: the application's, and its middleware's. */
  app: appRuntimeSchema,
  /** Files served straight from storage, by pathname. */
  staticFiles: staticFilesSchema.optional(),
  /** The application's middleware matchers: a document these match is not served without it. */
  middleware: middlewareConfigSchema.optional(),
  /**
   * The application's dynamic routes in Next.js's own order, so a pathname no exact route names
   * can still be served the shell of the class it belongs to — and only when Next.js itself
   * would have picked that class.
   */
  dynamicRoutes: z.array(dynamicRouteSchema).optional(),
  /**
   * The application keeps its pages behind a trailing slash (`trailingSlash`): a route is named by
   * the spelling a request asks for it by (`/about/`), and a member of a dynamic route's class is
   * asked for with the slash as well (`matchDynamicRoute`). Absent for any other application — and
   * on a manifest from before it was published, whose reader matches no member with the slash,
   * which leaves such a member to the Function as every one of its pages was left then.
   */
  trailingSlash: z.literal(true).optional(),
  reservedRoutes: z.array(reservedRouteSchema).optional(),
  exactPathnames: exactPathnamesSchema.optional(),
  exactFunctions: exactFunctionsSchema.optional(),
  headerRules: z.array(headerRuleSchema).optional(),
  /**
   * How the deployment's Functions fill a header's `$` references (`routerReferencesSchema`): the
   * edge fills a rule's headers the same way, so a response gets no value from the edge that the
   * Function would not have given it. Absent on a manifest of a deployment whose Functions route
   * with the router from before 16.4 — every manifest from before this was published among them —
   * whose headers the edge fills the way that router did.
   */
  routerReferences: routerReferencesSchema.optional(),
  /**
   * The unconditional header rules of a build whose routing the edge does not reproduce (one with
   * `i18n`, and in a manifest from before the edge routed it, one with a `basePath`), which
   * publishes no `headerRules` but the ones `next build` writes itself: judged against a route's
   * own pathname, as the deployment judged them when it folded them into the route's headers, and
   * laid over the headers of a generation the runtime cache answers with. Present, if empty, for
   * every such build; absent for any other, and on a manifest from before it was published.
   */
  foldedHeaderRules: z.array(headerRuleSchema).optional(),
  /** The application's `next/image` configuration: the edge answers `/_next/image` with it. */
  images: imagesConfigSchema.optional(),
  /**
   * The user agents the application sends blocking metadata to, as the pattern Next.js tests them
   * with (`htmlLimitedBots`) — its own list, or Next.js's, which loading the config fills in where
   * the application names none: Next.js renders a partially prerendered page whole for them, so no
   * shell is served to them. Absent where the build recorded none, and Next.js's list applies.
   * Carried as the build recorded it, a pattern the edge will not run included: whether it runs
   * one is decided where it is read (`wantsBlockingMetadata`).
   *
   * A reader that does not know the field drops it and judges every visitor by the list it has, as
   * every reader did before the field existed — so no schema version turns on it.
   */
  htmlLimitedBots: z.string().optional(),
  /**
   * Whether the build's Next.js streams a partially prerendered page to the crawlers it sends no
   * blocking metadata to: from 16.3, which renders such a page whole only for the ones it does
   * (`shouldForceDynamicPPRRender`). Next.js 16.2 renders it whole for every crawler, the ones that
   * run scripts included (`shouldWaitOnAllReady`), and no shell is served to any crawler where this
   * is absent — on a manifest of such a build, and on one from before the field existed.
   */
  crawlersStreamed: z.literal(true).optional(),
  /**
   * Where a shipped file is found as well, in an application with `i18n`: behind one of its
   * default locales — its own, and each domain's — under its base path (`findStaticFile`).
   */
  staticFileLocales: staticFileLocalesSchema.optional(),
  /**
   * Where a shipped file under `<basePath>/_next/` is found as well, in an application with an
   * `assetPrefix`: under `<assetPrefix>/_next/`, which `next build` rewrites to it before the
   * filesystem is checked (`findStaticFile`).
   */
  staticFileAssetPrefix: staticFileAssetPrefixSchema.optional(),
  /**
   * Where a shipped file whose last segment names no file is found as well, in an application with
   * `trailingSlash`: by its spelling with the slash (`/manual/` is the file `/manual`), which the
   * router finds it by whether or not the build writes the redirect to the slash
   * (`findStaticFile`). Absent for any other application, and on a manifest from before it was
   * published, whose reader leaves that spelling to the Function.
   */
  staticFileTrailingSlash: z.literal(true).optional(),
  /**
   * Where a Pages Router page's props are asked for: `<basePath>/_next/data/<buildId>`, the build's
   * own, as a request's URL spells it (`pagesDataPrefixOf`) — what a request's pathname is compared
   * with. Present where a route holds props (`RouteEntry.pagesData`), absent otherwise; a manifest
   * that names props and nowhere to ask for them is refused where it is built
   * (`buildProjectManifest`).
   */
  pagesDataPrefix: z.string().startsWith('/').optional(),
  /**
   * The base path those props are asked for under, as the build wrote it, which the page a request
   * asks the props of is named under (`pageOfPagesData`). The prefix is not taken apart for it: a
   * base path may hold `/_next/data/` itself. Present beside a prefix under a base path, absent for
   * none.
   */
  pagesDataBasePath: z.string().startsWith('/').optional(),
  /** The runtime cache the routes' entries live in. */
  cache: manifestCacheSchema.optional(),
});
export type ProjectManifest = z.infer<typeof projectManifestSchema>;
