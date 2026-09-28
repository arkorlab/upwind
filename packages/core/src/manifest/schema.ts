import { z } from 'zod';

import { artifactRefSchema, sha256HexSchema, shellEncodingsSchema } from '../artifact/artifact.ts';
import { routeHasSchema } from '../bundle/schema.ts';
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
 */
export const MANIFEST_SCHEMA_VERSION = 3;
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
  segments: z.record(z.string().startsWith('/'), artifactRefSchema).optional(),
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
export const staticFileEntrySchema = staticFileBytesSchema.extend({
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
   * The same name as the deployment before built it, when the name is not a content hash — a
   * build manifest under a build id that stays the same from build to build. Its documents ask
   * for the name by their deployment, and get the bytes that deployment gave it.
   */
  previous: staticFileBytesSchema.extend({ deploymentId: z.string().min(1) }).optional(),
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
 * One of the application's dynamic route matchers, as Next.js compiled and ordered them. The
 * first whose pattern and conditions match a pathname is the route Next.js would serve; `route`
 * names the entry in `routes` holding that class's shell, when the build produced one.
 */
export const dynamicRouteSchema = z.object({
  sourceRegex: patternSchema,
  has: z.array(routeHasSchema).optional(),
  missing: z.array(routeHasSchema).optional(),
  route: z.string().startsWith('/').optional(),
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
  schemaVersion: z.literal(MANIFEST_SCHEMA_VERSION),
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
  headerRules: z.array(headerRuleSchema).optional(),
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
  /** The runtime cache the routes' entries live in. */
  cache: manifestCacheSchema.optional(),
});
export type ProjectManifest = z.infer<typeof projectManifestSchema>;
