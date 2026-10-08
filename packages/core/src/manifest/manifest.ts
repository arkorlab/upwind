import { canonicalJson, sha256HexOfText } from '../artifact/hash.ts';
import { MAX_IMMUTABLE_ASSET_BYTES } from '../assets/admission.ts';
import type { RouterReferences } from '../bundle/schema.ts';
import type { DeploymentFingerprint } from '../deployment/fingerprint.ts';
import type { ImagesConfig } from '../images/config.ts';
import { compareCodeUnits } from '../util/bytes.ts';
import {
  type AppRuntime,
  type AssetPolicy,
  type HeaderRule,
  type ContinuationConfig,
  type DynamicRoute,
  MANIFEST_SCHEMA_VERSION,
  type ManifestCache,
  type MiddlewareMatcher,
  type ReservedRoute,
  type RouteEntry,
  type ProjectManifest,
  projectManifestSchema,
  type StaticFileAssetPrefix,
  type StaticFileEntry,
  type StaticFileLocales,
} from './schema.ts';

const DEFAULT_FIRST_BYTE_TIMEOUT_MS = 15_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 300_000;

export const DEFAULT_CONTINUATION_CONFIG: ContinuationConfig = {
  firstByteTimeoutMs: DEFAULT_FIRST_BYTE_TIMEOUT_MS,
  totalTimeoutMs: DEFAULT_TOTAL_TIMEOUT_MS,
};

export const DEFAULT_ASSET_POLICY: AssetPolicy = {
  pathClasses: ['immutable', 'chunks', 'css', 'media', 'runtime', 'build-manifests'],
  maxBytes: MAX_IMMUTABLE_ASSET_BYTES,
};

export interface BuildProjectManifestInput {
  readonly projectId: string;
  readonly runId: string;
  readonly generatedAt: string;
  readonly originHost: string;
  readonly deployment: DeploymentFingerprint;
  readonly routes: readonly RouteEntry[];
  readonly continuation?: Partial<ContinuationConfig> | undefined;
  readonly assetPolicy?: Partial<AssetPolicy> | undefined;
  readonly app: AppRuntime;
  readonly staticFiles?: Record<string, StaticFileEntry> | undefined;
  readonly middleware?: { readonly matchers: readonly MiddlewareMatcher[] } | undefined;
  readonly dynamicRoutes?: readonly DynamicRoute[] | undefined;
  readonly trailingSlash?: boolean | undefined;
  readonly reservedRoutes?: readonly ReservedRoute[] | undefined;
  readonly exactPathnames?: readonly string[] | undefined;
  /** Exact pathnames an app Function other than the first answers, with its name. */
  readonly exactFunctions?: Readonly<Record<string, string>> | undefined;
  readonly headerRules?: readonly HeaderRule[] | undefined;
  /** How the deployment's Functions fill a header's `$` references, as its bundle says. */
  readonly routerReferences?: RouterReferences | undefined;
  readonly foldedHeaderRules?: readonly HeaderRule[] | undefined;
  readonly images?: ImagesConfig | undefined;
  /** The application's `htmlLimitedBots`, as the build recorded it. */
  readonly htmlLimitedBots?: string | undefined;
  /** Whether the build's Next.js streams a partially prerendered page to crawlers it lists not. */
  readonly crawlersStreamed?: boolean | undefined;
  readonly staticFileLocales?: StaticFileLocales | undefined;
  readonly staticFileAssetPrefix?: StaticFileAssetPrefix | undefined;
  readonly staticFileTrailingSlash?: boolean | undefined;
  readonly cache?: ManifestCache | undefined;
}

/** Who the application sends blocking metadata to, and whether its Next.js streams to the rest. */
function crawlerFields(
  input: BuildProjectManifestInput,
): Pick<ProjectManifest, 'htmlLimitedBots' | 'crawlersStreamed'> {
  return {
    ...(input.htmlLimitedBots !== undefined && { htmlLimitedBots: input.htmlLimitedBots }),
    ...(input.crawlersStreamed === true && { crawlersStreamed: true as const }),
  };
}

/** Where a shipped file is found besides its own name: behind a locale, a prefix, a slash. */
function staticFileFields(
  input: BuildProjectManifestInput,
): Pick<
  ProjectManifest,
  'staticFileLocales' | 'staticFileAssetPrefix' | 'staticFileTrailingSlash'
> {
  return {
    ...(input.staticFileLocales !== undefined && { staticFileLocales: input.staticFileLocales }),
    ...(input.staticFileAssetPrefix !== undefined && {
      staticFileAssetPrefix: input.staticFileAssetPrefix,
    }),
    ...(input.staticFileTrailingSlash === true && { staticFileTrailingSlash: true as const }),
  };
}

/**
 * The app Functions the routes are placed in that `app` gives no name to reach by. An edge could
 * send such a route nowhere, so a manifest naming one is refused where it is built rather than where
 * it is read: the edge reads a manifest on a request's way in, and a check there would cost every
 * deployment, split or not, for what only the host that built it could get wrong.
 */
function unreachableFunctions(input: BuildProjectManifestInput): string[] {
  const reachable = input.app.functions ?? {};
  const unreachable = new Set<string>();
  const check = (name: string | undefined): void => {
    if (name !== undefined && !Object.hasOwn(reachable, name)) {
      unreachable.add(name);
    }
  };
  for (const route of input.routes) {
    check(route.function);
  }
  if (input.dynamicRoutes !== undefined) {
    for (const route of input.dynamicRoutes) {
      check(route.function);
    }
  }
  if (input.exactFunctions !== undefined) {
    const named = Object.values(input.exactFunctions);
    for (const name of named) {
      check(name);
    }
  }
  return [...unreachable].toSorted(compareCodeUnits);
}

/** Assemble a manifest from a build's routes; validates the result against the schema. */
export function buildProjectManifest(input: BuildProjectManifestInput): ProjectManifest {
  const unreachable = unreachableFunctions(input);
  if (unreachable.length > 0) {
    throw new Error(
      `routes are placed in ${unreachable.join(', ')}, which the manifest's app gives no name to reach by (app.functions)`,
    );
  }
  const routes: Record<string, RouteEntry> = {};
  for (const entry of input.routes) {
    routes[entry.pathname] = entry;
  }
  return projectManifestSchema.parse({
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    projectId: input.projectId,
    runId: input.runId,
    generatedAt: input.generatedAt,
    origin: { scheme: 'https', host: input.originHost },
    deployment: input.deployment,
    continuation: { ...DEFAULT_CONTINUATION_CONFIG, ...input.continuation },
    routes,
    assetPolicy: { ...DEFAULT_ASSET_POLICY, ...input.assetPolicy },
    app: input.app,
    ...(input.staticFiles !== undefined && { staticFiles: input.staticFiles }),
    ...(input.middleware !== undefined && { middleware: input.middleware }),
    ...(input.dynamicRoutes !== undefined && { dynamicRoutes: input.dynamicRoutes }),
    ...(input.trailingSlash === true && { trailingSlash: true }),
    ...(input.reservedRoutes !== undefined && { reservedRoutes: input.reservedRoutes }),
    ...(input.exactPathnames !== undefined && {
      exactPathnames: Object.fromEntries(input.exactPathnames.map((pathname) => [pathname, true])),
    }),
    ...(input.exactFunctions !== undefined && { exactFunctions: input.exactFunctions }),
    ...(input.headerRules !== undefined && { headerRules: input.headerRules }),
    ...(input.routerReferences !== undefined && { routerReferences: input.routerReferences }),
    ...(input.foldedHeaderRules !== undefined && { foldedHeaderRules: input.foldedHeaderRules }),
    ...(input.images !== undefined && { images: input.images }),
    ...crawlerFields(input),
    ...staticFileFields(input),
    ...(input.cache !== undefined && { cache: input.cache }),
  });
}

/** Content address of a manifest: SHA-256 of its canonical JSON. */
export async function computeManifestId(manifest: ProjectManifest): Promise<string> {
  return sha256HexOfText(canonicalJson(manifest));
}

/** Serialize a manifest deterministically (the bytes that `computeManifestId` hashes). */
export function serializeManifest(manifest: ProjectManifest): string {
  return canonicalJson(manifest);
}

const KIB = 1024;
const MIB = KIB * KIB;
const MANIFEST_MIB = 8;
/**
 * The largest manifest a deployment may publish, serialized. The edge holds one parsed for
 * every deployment it serves, within a budget of its own, so a manifest is only as large as that
 * budget can hold two of. A large application's runs to a couple of hundred kilobytes; this is
 * some forty times that.
 */
export const MAX_MANIFEST_BYTES = MANIFEST_MIB * MIB;

/** Parse and validate a manifest document (throws on schema violations). */
export function parseProjectManifest(json: string): ProjectManifest {
  return projectManifestSchema.parse(JSON.parse(json));
}

/** The documents `next build` writes for an error, by the name they are shipped under. */
const ERROR_DOCUMENT_STATUS: Readonly<Record<string, number>> = { '/404': 404, '/500': 500 };
const HTTP_OK = 200;

/**
 * The status a shipped file is served with. Next.js writes its error documents as files named
 * `/404` and `/500` — under the `basePath`, as it names everything of a build — and answers a
 * request for either with the status it stands for, never 200.
 *
 * A `trailingSlash` build writes the same document twice, the second time as `404/index.html`, and
 * that is the one a visitor who types the path is served. It is the same error page, so it goes out
 * under the same status: Next.js's own server answers either spelling with it, and a page that says
 * "not found" under a 200 is a soft 404 to everything that reads statuses.
 */
export function staticFileStatus(pathname: string, basePath = ''): number {
  if (!pathname.startsWith(basePath)) {
    return HTTP_OK;
  }
  const name = pathname.slice(basePath.length);
  const named = name.length > 1 && name.endsWith('/') ? name.slice(0, -1) : name;
  return ERROR_DOCUMENT_STATUS[named] ?? HTTP_OK;
}

/**
 * The key a record holds a pathname under: as the request spelled it, and then decoded. Next.js
 * names what it builds by the characters a path reads as (`/sticks & stones`, `/記事`), escaping
 * only a delimiter, and a request carries them escaped; its filesystem check looks a path up both
 * ways (`getItem`, `server/lib/router-utils/filesystem.ts`). A pathname with nothing to decode
 * costs the one lookup it always did.
 */
export function keyOf(
  record: Readonly<Record<string, unknown>>,
  pathname: string,
): string | undefined {
  if (Object.hasOwn(record, pathname)) {
    return pathname;
  }
  if (!pathname.includes('%')) {
    return undefined;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  return Object.hasOwn(record, decoded) ? decoded : undefined;
}

/** What a record holds under a pathname (`keyOf`). */
function byPathname<T>(record: Readonly<Record<string, T>>, pathname: string): T | undefined {
  const key = keyOf(record, pathname);
  return key === undefined ? undefined : record[key];
}

/**
 * The path with one of the application's default locales taken out from behind its base path, as
 * Next.js's filesystem check takes it out of a static file's path ("legacy behavior allows
 * visiting static assets under default locale but no other locale", `getItem`,
 * `server/lib/router-utils/filesystem.ts`); `undefined` when no default locale is there.
 */
function withoutDefaultLocale(locales: StaticFileLocales, pathname: string): string | undefined {
  const { basePath } = locales;
  if (basePath !== '' && !pathname.startsWith(`${basePath}/`)) {
    return undefined;
  }
  const rest = pathname.slice(basePath.length);
  const end = rest.indexOf('/', 1);
  if (end === -1) {
    return undefined;
  }
  const segment = rest.slice(1, end).toLowerCase();
  return locales.locales.some((locale) => locale.toLowerCase() === segment)
    ? `${basePath}${rest.slice(end)}`
    : undefined;
}

/**
 * The path a request under the application's asset prefix names a file by: `<assetPrefix>/_next/…`
 * as `<basePath>/_next/…`, the rewrite `next build` writes for an `assetPrefix` (`loadRewrites`,
 * `lib/load-custom-routes.ts`); `undefined` for a path not under the prefix.
 */
export function withoutAssetPrefix(
  prefix: StaticFileAssetPrefix,
  pathname: string,
): string | undefined {
  const under = `${prefix.assetPrefix}/_next/`;
  return pathname.startsWith(under)
    ? `${prefix.basePath}/_next/${pathname.slice(under.length)}`
    : undefined;
}

/**
 * The pathname the manifest ships a file under, for a pathname a request names: as spelled or
 * decoded (`keyOf`), by the slash the router finds it by too (`slashedFileKey`), and in an
 * application with `i18n` behind a default locale as well (`withoutDefaultLocale`) — by the slash
 * there too, which Next.js takes off before the locale (`getItem`). Next.js's middleware puts the
 * locale in front of every path it rewrites to (`forceLocale`), a file's among them, so the rewrite
 * a middleware makes of `/_next/static/…` to itself names `/en/_next/static/…`, which Next.js serves
 * as the file. In an application with an `assetPrefix`, a file under `_next` is found under the
 * prefix as well (`withoutAssetPrefix`): its pages load their scripts from there. Behind a default
 * locale too, in one with both: the same rewrite of `/assets/_next/static/…` names
 * `/en/assets/_next/static/…`, and Next.js takes the default locale off before it matches the
 * prefix's rewrite.
 */
export function staticFileKey(manifest: ProjectManifest, pathname: string): string | undefined {
  const { staticFiles, staticFileLocales, staticFileAssetPrefix } = manifest;
  if (staticFiles === undefined) {
    return undefined;
  }
  const named = namedFileKey(manifest, staticFiles, pathname);
  if (named !== undefined) {
    return named;
  }
  const unlocalized =
    staticFileLocales === undefined ? undefined : withoutDefaultLocale(staticFileLocales, pathname);
  const localized =
    unlocalized === undefined ? undefined : namedFileKey(manifest, staticFiles, unlocalized);
  if (localized !== undefined) {
    return localized;
  }
  if (staticFileAssetPrefix === undefined) {
    return undefined;
  }
  const unprefixed =
    withoutAssetPrefix(staticFileAssetPrefix, pathname) ??
    (unlocalized === undefined
      ? undefined
      : withoutAssetPrefix(staticFileAssetPrefix, unlocalized));
  return unprefixed === undefined ? undefined : keyOf(staticFiles, unprefixed);
}

/**
 * Whether a pathname's last segment names no file: nothing in it Next.js reads as an extension. A
 * dynamic segment's own brackets and dots (`[...slug]`) say nothing of the member it stands for.
 */
export function namesNoFile(pathname: string): boolean {
  const last = pathname.slice(pathname.lastIndexOf('/') + 1);
  return last !== '' && !last.replaceAll(/\[[^[\]]*\]/gu, '').includes('.');
}

/** The file a pathname names as spelled or decoded (`keyOf`), or by the slash (`slashedFileKey`). */
function namedFileKey(
  manifest: ProjectManifest,
  staticFiles: Record<string, StaticFileEntry>,
  pathname: string,
): string | undefined {
  return keyOf(staticFiles, pathname) ?? slashedFileKey(manifest, staticFiles, pathname);
}

/**
 * A file whose last segment names no file, in an application with `trailingSlash`, by the spelling
 * the router finds it by (`staticFileTrailingSlash`): Next.js redirects `/manual` to `/manual/`
 * and answers the file there, so `/manual/` is the file `/manual` (`routerSpellings`) — and where
 * `skipTrailingSlashRedirect` leaves the redirect out, the router still finds the file so. A name
 * with an extension has no such spelling: the redirect takes the slash off it.
 */
function slashedFileKey(
  manifest: ProjectManifest,
  staticFiles: Record<string, StaticFileEntry>,
  pathname: string,
): string | undefined {
  if (manifest.staticFileTrailingSlash !== true || pathname.length < 2 || !pathname.endsWith('/')) {
    return undefined;
  }
  // Judged on the file's own name, which the runtime makes the alias of: a request may escape the
  // dot that makes a name a file's (`/manual%2Etxt/`), and the file it decodes to takes no slash.
  // Nor does one whose name has a bracket in it, which the runtime reads as a template's.
  const key = keyOf(staticFiles, pathname.slice(0, -1));
  return key !== undefined && namesNoFile(key) && !key.includes('[') ? key : undefined;
}

/** The file shipped under a pathname a request names (`staticFileKey`). */
export function findStaticFile(
  manifest: ProjectManifest,
  pathname: string,
): StaticFileEntry | undefined {
  const key = staticFileKey(manifest, pathname);
  return key === undefined ? undefined : manifest.staticFiles?.[key];
}

/**
 * The build of a shipped file that a request naming no deployment (no `dpl`) is answered with:
 * the manifest's own, or one kept from the deployment before. `undefined` for a kept build that
 * answers only its own deployment's `dpl` (`dplOnly`): its name is the manifest's own deployment's
 * to answer, with whatever its routing makes of the path.
 */
export function staticFileBuildWithoutDpl(
  file: StaticFileEntry,
  activeDplId: string | undefined,
): StaticFileEntry | undefined {
  const kept = file.deploymentId !== undefined && file.deploymentId !== activeDplId;
  return kept && file.dplOnly === true ? undefined : file;
}

/**
 * Exact-match route lookup (case-sensitive, no trailing-slash normalization), of the pathname as
 * the request spelled it and then decoded (`byPathname`). A route is named by the spelling a
 * request asks for it by — behind the slash, for an application that keeps its pages there — so
 * the other spelling finds nothing, and is Next.js's to redirect.
 */
export function findRouteEntry(
  manifest: ProjectManifest,
  pathname: string,
): RouteEntry | undefined {
  return byPathname(manifest.routes, pathname);
}
