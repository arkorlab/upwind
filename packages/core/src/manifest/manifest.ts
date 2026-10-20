import { canonicalJson, sha256HexOfText } from '../artifact/hash.ts';
import { MAX_IMMUTABLE_ASSET_BYTES } from '../assets/admission.ts';
import type { RouteGates, RouterReferences } from '../bundle/carried.ts';
import type { DeploymentFingerprint } from '../deployment/fingerprint.ts';
import type { ImagesConfig } from '../images/config.ts';
import { compareCodeUnits } from '../util/bytes.ts';
import {
  escapedPathOf,
  memberValuesOf,
  type Reading,
  readablePathOf,
  requestPathOf,
  spellingReaching,
} from './built-names.ts';
import { pageKeyOf } from './page-keys.ts';
import { namesPagesDataPrefix, pagesDataPrefixOf } from './pages-data-prefix.ts';
import { routeBodyFields } from './route-bodies.ts';
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
  type RouteBodyEntry,
  type StaticPageEntry,
  type RouteEntry,
  type ProjectManifest,
  projectManifestSchema,
  REQUEST_FILE_KEYS_SCHEMA_VERSION,
  type SpelledPrefix,
  type StaticFileAssetPrefix,
  type StaticFileEntry,
  type StaticFileLocales,
} from './schema.ts';
import { spellsPrefixOf } from './spelled-prefix.ts';
import { staticPageFields } from './static-pages.ts';
import { fromStoredManifest, toStoredManifest } from './stored.ts';

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
  readonly routeBodies?: readonly RouteBodyEntry[] | undefined;
  readonly staticPages?: readonly StaticPageEntry[] | undefined;
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
  /** The pages of their own a dynamic route's pattern also matches (`filesystemPagesSchema`). */
  readonly filesystemPages?: readonly string[] | undefined;
  /** What the router reads of a path as written: the base path, and the locales behind it. */
  readonly spelledPrefix?: SpelledPrefix | undefined;
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
  readonly staticFileRequestKeys?: boolean | undefined;
  readonly staticFileTrailingSlash?: boolean | undefined;
  /**
   * The base path and the build id a Pages Router page's props are asked for under, where a route
   * holds them: the manifest names where (`pagesDataPrefix`, `pagesDataBasePath`) from these.
   */
  readonly pagesDataUnder?: { readonly basePath: string; readonly buildId: string } | undefined;
  /** The routes the build declared a gate for, each with the name of its gate. */
  readonly gates?: RouteGates | undefined;
  /** The pathnames Next.js resolves exactly that are of a gated route, each with that route. */
  readonly gatedPathnames?: Readonly<Record<string, string>> | undefined;
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

/** Pathnames as a manifest lists them: each by its name. */
function listed(pathnames: readonly string[]): Record<string, true> {
  return Object.fromEntries(pathnames.map((pathname) => [pathname, true]));
}

/**
 * The pathnames the edge looks a page up among, each listed by its name, and what of a path the
 * router reads as written in front of them.
 */
function pathnameFields(
  input: BuildProjectManifestInput,
): Pick<ProjectManifest, 'exactPathnames' | 'filesystemPages' | 'spelledPrefix'> {
  return {
    ...(input.exactPathnames !== undefined && { exactPathnames: listed(input.exactPathnames) }),
    ...(input.filesystemPages !== undefined && { filesystemPages: listed(input.filesystemPages) }),
    ...(input.spelledPrefix !== undefined && { spelledPrefix: input.spelledPrefix }),
  };
}

/** Where a shipped file is found besides its own name: behind a locale, a prefix, a slash. */
function staticFileFields(
  input: BuildProjectManifestInput,
): Pick<
  ProjectManifest,
  | 'staticFileLocales'
  | 'staticFileAssetPrefix'
  | 'staticFileRequestKeys'
  | 'staticFileTrailingSlash'
> {
  return {
    ...(input.staticFileLocales !== undefined && { staticFileLocales: input.staticFileLocales }),
    ...(input.staticFileAssetPrefix !== undefined && {
      staticFileAssetPrefix: input.staticFileAssetPrefix,
    }),
    ...(input.staticFileRequestKeys === true && { staticFileRequestKeys: true as const }),
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
  const routeTables = [input.routes, input.routeBodies, input.staticPages, input.dynamicRoutes];
  for (const entries of routeTables) {
    if (entries !== undefined) {
      for (const entry of entries) check(entry.function);
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

/**
 * What is wrong with where the manifest says a client asks for a page's props, if anything. Props
 * no prefix names are asked for at no URL, and a base path or a build id a prefix cannot carry, or a
 * request cannot spell as written, names no request: either way every data request would go to the
 * Function, and nothing would say why. So a manifest like that is refused where it is built, as one
 * naming an unreachable Function is.
 */
function unaddressedProps(input: BuildProjectManifestInput): string | undefined {
  const under = input.pagesDataUnder;
  if (under !== undefined && !namesPagesDataPrefix(under.basePath, under.buildId)) {
    return `pagesDataUnder names no prefix: base path ${under.basePath}, build ${under.buildId}`;
  }
  if (under === undefined && input.routes.some((route) => route.pagesData !== undefined)) {
    return "routes hold a page's props (pagesData), and no pagesDataUnder says where a client asks for them";
  }
  return undefined;
}

/**
 * Where a client asks for props, where a route holds some (`RouteEntry.pagesData`): the prefix as a
 * request spells it, and the base path it is under, as the build wrote it, for naming the page a
 * request asks for; neither where no route's props sit under them, so that the fields say what
 * they say.
 */
function pagesDataFields(
  input: BuildProjectManifestInput,
): Pick<ProjectManifest, 'pagesDataBasePath' | 'pagesDataPrefix'> {
  const under = input.pagesDataUnder;
  if (under === undefined || input.routes.every((route) => route.pagesData === undefined)) {
    return {};
  }
  return {
    pagesDataPrefix: pagesDataPrefixOf(under.buildId, under.basePath),
    ...(under.basePath !== '' && { pagesDataBasePath: under.basePath }),
  };
}

/** The routes the manifest finds a request of by its exact pathname, and by a dynamic route. */
function gatedBy(input: BuildProjectManifestInput): {
  readonly exact: readonly string[];
  readonly dynamic: readonly string[];
} {
  return {
    exact: Object.values(input.gatedPathnames ?? {}),
    dynamic: (input.dynamicRoutes ?? []).flatMap((route) =>
      route.gated === undefined ? [] : [route.gated],
    ),
  };
}

/**
 * What is wrong with what the manifest says of gates, if anything: a `gates` that declares none; a
 * gate beside a middleware, whose rewrites the Function runs for every request the edge hands on,
 * onto a gated route among them, with no gate asked (`gateIssues` refuses the bundle so); a route a
 * pathname or a dynamic route is said to be of (`gatedPathnames`, `DynamicRoute.gated`) that
 * `gates` declares no gate for, whose requests the edge would find a route and no gate to ask of;
 * and a declared gate nothing finds a request of the route by — a route's own pathname, or for a
 * class of them, a dynamic route — whose every request the edge would serve as one with no gate.
 * A manifest like that is refused where it is built, as one naming an unreachable Function is.
 */
function ungatedRoutes(input: BuildProjectManifestInput): string | undefined {
  const { gates } = input;
  if (gates !== undefined && Object.keys(gates).length === 0) {
    return 'gates declares no gate; a manifest that declares none leaves it out';
  }
  if (gates !== undefined && input.middleware !== undefined) {
    return 'gates declares a gate beside a middleware, whose rewrites reach a gated route with no gate asked';
  }
  const { exact, dynamic } = gatedBy(input);
  const ungated = [
    ...new Set(
      [...exact, ...dynamic].filter((route) => gates === undefined || !Object.hasOwn(gates, route)),
    ),
  ].toSorted(compareCodeUnits);
  if (ungated.length > 0) {
    return `routes are said to be gated that gates declares no gate for: ${ungated.join(', ')}`;
  }
  // A route's own name in brackets (`/[slug]`) is a class of pathnames, found by its dynamic route.
  const unfound = Object.keys(gates ?? {}).filter((route) =>
    route.includes('[') ? !dynamic.includes(route) : !exact.includes(route),
  );
  return unfound.length === 0
    ? undefined
    : `gates declares ${unfound.toSorted(compareCodeUnits).join(', ')}, which no pathname or dynamic route of the manifest finds a request of (gatedPathnames, DynamicRoute.gated): each would be served with no gate asked`;
}

/** The gates, and the pathnames found to be of a gated route beside them, where there are gates. */
function gateFields(
  input: BuildProjectManifestInput,
): Pick<ProjectManifest, 'gates' | 'gatedPathnames'> {
  const { gates, gatedPathnames } = input;
  if (gates === undefined) {
    return {};
  }
  return { gates, ...(gatedPathnames !== undefined && { gatedPathnames }) };
}

/** Assemble a manifest from a build's routes; validates the result against the schema. */
export function buildProjectManifest(input: BuildProjectManifestInput): ProjectManifest {
  const unreachable = unreachableFunctions(input);
  if (unreachable.length > 0) {
    throw new Error(
      `routes are placed in ${unreachable.join(', ')}, which the manifest's app gives no name to reach by (app.functions)`,
    );
  }
  const refused = unaddressedProps(input) ?? ungatedRoutes(input);
  if (refused !== undefined) {
    throw new Error(refused);
  }
  const routes: Record<string, RouteEntry> = {};
  for (const entry of input.routes) {
    routes[entry.pathname] = entry;
  }
  return projectManifestSchema.parse({
    schemaVersion:
      input.staticFileRequestKeys === true
        ? REQUEST_FILE_KEYS_SCHEMA_VERSION
        : MANIFEST_SCHEMA_VERSION,
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
    ...pathnameFields(input),
    ...routeBodyFields(input, routes),
    ...staticPageFields(input, routes),
    ...(input.exactFunctions !== undefined && { exactFunctions: input.exactFunctions }),
    ...(input.headerRules !== undefined && { headerRules: input.headerRules }),
    ...(input.routerReferences !== undefined && { routerReferences: input.routerReferences }),
    ...(input.foldedHeaderRules !== undefined && { foldedHeaderRules: input.foldedHeaderRules }),
    ...(input.images !== undefined && { images: input.images }),
    ...crawlerFields(input),
    ...staticFileFields(input),
    ...pagesDataFields(input),
    ...gateFields(input),
    ...(input.cache !== undefined && { cache: input.cache }),
  });
}

/** Content address of a manifest: SHA-256 of its stored bytes (`serializeManifest`). */
export async function computeManifestId(manifest: ProjectManifest): Promise<string> {
  return sha256HexOfText(serializeManifest(manifest));
}

/**
 * Serialize a manifest deterministically, as it is stored (`toStoredManifest`): the bytes that
 * `computeManifestId` hashes.
 */
export function serializeManifest(manifest: ProjectManifest): string {
  return canonicalJson(toStoredManifest(manifest));
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

/** Parse and validate a manifest document, as stored or not (throws on schema violations). */
export function parseProjectManifest(json: string): ProjectManifest {
  return projectManifestSchema.parse(fromStoredManifest(JSON.parse(json)));
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
 * The key a record of files holds a pathname under: as the request spelled it, and then decoded
 * whole, as Next.js's filesystem check looks a file up both ways (`getItem`,
 * `server/lib/router-utils/filesystem.ts`) — decoded, where the path writes the base path and a
 * locale in front of the file as the router reads them, as written (`spellsPrefixOf`): the check
 * finds no file under the base path for `/b%61se/logo.png`. A pathname with nothing to decode costs
 * the one lookup it always did. A page Next.js built is looked up as Next.js finds it
 * (`pageKeyOf`).
 */
function keyOf(
  record: Readonly<Record<string, unknown>>,
  pathname: string,
  prefix: SpelledPrefix | undefined,
  manifest?: FileLookup,
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
  if (!Object.hasOwn(record, decoded) || !spellsPrefixOf(prefix, pathname, decoded)) {
    return undefined;
  }
  // Request-key aliases may sit outside the base path. Only the decoded-hit branch needs to
  // verify the literal asset prefix too; raw hits and ordinary misses never read this flag.
  const assetPrefix = manifest?.staticFileAssetPrefix;
  if (
    assetPrefix !== undefined &&
    manifest?.staticFileRequestKeys === true &&
    manifest.schemaVersion === REQUEST_FILE_KEYS_SCHEMA_VERSION &&
    decoded.startsWith(`${assetPrefix.assetPrefix}/_next/`) &&
    !spellsPrefixOf({ basePath: assetPrefix.assetPrefix }, pathname, decoded)
  ) {
    return undefined;
  }
  return decoded;
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

/** What of a manifest finds a file the build shipped (`staticFileKey`). */
type FileLookup = Pick<
  ProjectManifest,
  | 'staticFiles'
  | 'staticFileLocales'
  | 'staticFileAssetPrefix'
  | 'staticFileRequestKeys'
  | 'staticFileTrailingSlash'
  | 'spelledPrefix'
> & { readonly schemaVersion?: ProjectManifest['schemaVersion'] };

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
export function staticFileKey(manifest: FileLookup, pathname: string): string | undefined {
  const { staticFiles, staticFileLocales, staticFileAssetPrefix } = manifest;
  if (staticFiles === undefined) {
    return undefined;
  }
  // The prefix the router reads as written is asked of the path the request spelled; a path made
  // of it here — a default locale taken out, the asset prefix put back as the base path — writes
  // it as the configuration does, as the rewrite Next.js makes of it does.
  const named = namedFileKey(manifest, staticFiles, pathname, manifest.spelledPrefix);
  if (named !== undefined) {
    return named;
  }
  const unlocalized =
    staticFileLocales === undefined ? undefined : withoutDefaultLocale(staticFileLocales, pathname);
  const localized =
    unlocalized === undefined
      ? undefined
      : namedFileKey(manifest, staticFiles, unlocalized, undefined);
  if (localized !== undefined) {
    return localized;
  }
  if (staticFileAssetPrefix === undefined) {
    return undefined;
  }
  if (
    manifest.staticFileRequestKeys === true &&
    manifest.schemaVersion === REQUEST_FILE_KEYS_SCHEMA_VERSION
  ) {
    return undefined;
  }
  const unprefixed =
    withoutAssetPrefix(staticFileAssetPrefix, pathname) ??
    (unlocalized === undefined
      ? undefined
      : withoutAssetPrefix(staticFileAssetPrefix, unlocalized));
  return unprefixed === undefined ? undefined : keyOf(staticFiles, unprefixed, undefined);
}

/**
 * The path a request asks for the file `key` of `manifest` by, at `spelling` — its own name, or a
 * spelling the edge finds it by besides, behind a default locale or under the asset prefix: the
 * spelling escaped as a request names a file (`escapedPathOf`), or — where another file is named as
 * that spells it, which the edge finds as spelled first (`/a%252F.txt` beside `/a%2F.txt`, `/a%20b`
 * beside `/a b`) — another spelling of it, one byte after another escaped, an escape's letters in
 * either case, the name's last byte first, until one no file is named as (`spellingReaching`). A
 * locale or the asset prefix ahead of the name, which the edge reads as it is, is the last to
 * change. `undefined` where none finds the file: no request reaches it at that spelling.
 */
export function fileRequestPathOf(
  manifest: FileLookup,
  spelling: string,
  key = spelling,
): string | undefined {
  const readable = escapedPathOf(spelling);
  if (readable === undefined) {
    return undefined;
  }
  const read = (pathname: string): string | undefined => staticFileKey(manifest, pathname);
  return spellingReaching(key, read, [{ readable, values: spelling.split('/') }]);
}

/** What of a manifest finds what a request asks for: a file it ships, and then a route. */
type RouteLookup = FileLookup &
  Pick<ProjectManifest, 'dynamicRoutes' | 'filesystemPages'> & {
    readonly routes: Readonly<Record<string, unknown>>;
  };

/**
 * The file the edge serves a request that names no deployment (no `dpl`) at `pathname` with, ahead
 * of every route (`classifyStaticFile`): one the manifest ships, but for a kept build — the
 * deployment before's — that answers only its own deployment's `dpl`.
 */
function fileServedAt(manifest: FileLookup, pathname: string): string | undefined {
  const key = staticFileKey(manifest, pathname);
  const file = key === undefined ? undefined : manifest.staticFiles?.[key];
  return file === undefined || staticFileBuildWithoutDpl(file, undefined) === undefined
    ? undefined
    : key;
}

/** What a request served a file reads as: no route's name, each of which starts with `/`. */
const FILE_READING = 'file ';

/**
 * The readings a request reaches the route `key` by (`spellingReaching`): as a member, by the
 * values its name was built from — each escaped escape read back first (`requestPathOf`), and then
 * each other way (`memberValuesOf`) — and as a page of its own, by its name as it is
 * (`escapedPathOf`), after the first. A reading of a member reaches no route only where a name the
 * manifest holds stands in its way — a page of its own, or a file, named as it decodes, or a route
 * named as each of its spellings — so no more of the others are tried than the manifest holds
 * names. A manifest from before the pages of their own were listed finds a member by its path
 * decoded whole (`pageKeyOf`), which none of the others decodes to.
 */
function* routeReadings(
  manifest: RouteLookup,
  key: string,
  readable: { readonly member: string; readonly own: string },
): Generator<Reading, void, undefined> {
  const segments = key.split('/');
  const members = memberValuesOf(segments);
  const first = members.next();
  if (first.done !== true) {
    yield { readable: readable.member, values: first.value };
  }
  yield { readable: readable.own, values: segments };
  let names: number | undefined;
  let tried = 0;
  for (const values of members) {
    names ??= Object.keys(manifest.routes).length + Object.keys(manifest.staticFiles ?? {}).length;
    if (tried > names) {
      return;
    }
    tried += 1;
    yield { readable: readablePathOf(values), values };
  }
}

/**
 * The path a request asks for the route `key` of `manifest` by, as the edge finds what a request
 * asks for: a file the manifest ships ahead of every route (`fileServedAt`), and then the route
 * (`pageKeyOf`) — its name read as a member's, escaped as a request names one (`requestPathOf`),
 * or as a page of its own's, escaped whole (`escapedPathOf`), whichever the edge reads back as
 * `key`. A page of its own's name is its path as it is: a `%2F` in it is a `%` and a `2F`, and
 * asked for as a member's escaped `/`, it is another page. Where a file or another route is named
 * as one of those spells it (`/docs/100%25` beside `/docs/100%`, the file `/docs/a%20b` beside the
 * route `/docs/a b`), the edge finds that one first, and the name is asked by another spelling of
 * it, read the same way: one byte after another escaped, an escape's letters in either case, until
 * one none is named as (`spellingReaching`) — or by another reading of it (`routeReadings`).
 *
 * `undefined` where none is: no request reaches the route. A member a page of its own shadows
 * (`/docs/a%2Fb` beside the page `/docs/a/b`) is never served — Next.js, and the edge, find the page
 * first, for every path that names the member — nor is a route a file is found ahead of at every
 * spelling, and a name no path names reaches nothing at all.
 */
export function routeRequestPathOf(manifest: RouteLookup, key: string): string | undefined {
  const member = requestPathOf(key);
  const own = escapedPathOf(key);
  if (member === undefined || own === undefined) {
    return undefined;
  }
  const read = (pathname: string): string | undefined => {
    const file = fileServedAt(manifest, pathname);
    return file === undefined
      ? pageKeyOf(manifest.routes, pathname, manifest)
      : `${FILE_READING}${file}`;
  };
  return spellingReaching(key, read, routeReadings(manifest, key, { member, own }));
}

/**
 * Whether a pathname's last segment names no file: nothing in it Next.js reads as an extension. A
 * dynamic segment's own brackets and dots (`[...slug]`) say nothing of the member it stands for.
 */
export function namesNoFile(pathname: string): boolean {
  const last = pathname.slice(pathname.lastIndexOf('/') + 1);
  return last !== '' && !last.replaceAll(/\[[^[\]]*\]/gu, '').includes('.');
}

/**
 * The file a pathname names as spelled or decoded (`keyOf`), or by the slash (`slashedFileKey`):
 * decoded, where it writes `prefix` as the router reads it.
 */
function namedFileKey(
  manifest: FileLookup,
  staticFiles: Record<string, StaticFileEntry>,
  pathname: string,
  prefix: SpelledPrefix | undefined,
): string | undefined {
  return (
    keyOf(staticFiles, pathname, prefix, manifest) ??
    slashedFileKey(manifest, staticFiles, pathname, prefix)
  );
}

/**
 * A file whose last segment names no file, in an application with `trailingSlash`, by the spelling
 * the router finds it by (`staticFileTrailingSlash`): Next.js redirects `/manual` to `/manual/`
 * and answers the file there, so `/manual/` is the file `/manual` (`routerSpellings`) — and where
 * `skipTrailingSlashRedirect` leaves the redirect out, the router still finds the file so. A name
 * with an extension has no such spelling: the redirect takes the slash off it.
 */
function slashedFileKey(
  manifest: FileLookup,
  staticFiles: Record<string, StaticFileEntry>,
  pathname: string,
  prefix: SpelledPrefix | undefined,
): string | undefined {
  if (manifest.staticFileTrailingSlash !== true || pathname.length < 2 || !pathname.endsWith('/')) {
    return undefined;
  }
  // Judged on the file's own name, which the runtime makes the alias of: a request may escape the
  // dot that makes a name a file's (`/manual%2Etxt/`), and the file it decodes to takes no slash.
  // Nor does one whose name has a bracket in it, which the runtime reads as a template's.
  const key = keyOf(staticFiles, pathname.slice(0, -1), prefix, manifest);
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
 * the request spelled it and then as Next.js finds the page it asks for (`pageKeyOf`). A route is
 * named by the spelling a request asks for it by — behind the slash, for an application that
 * keeps its pages there — so the other spelling finds nothing, and is Next.js's to redirect.
 */
export function findRouteEntry(
  manifest: ProjectManifest,
  pathname: string,
): RouteEntry | undefined {
  const named =
    manifest.routeBodies === undefined && manifest.staticPages === undefined
      ? manifest.routes
      : manifest.exactPathnames;
  const key = named === undefined ? undefined : pageKeyOf(named, pathname, manifest);
  return key === undefined ? undefined : manifest.routes[key];
}
