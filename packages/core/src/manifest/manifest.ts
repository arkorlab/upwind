import { canonicalJson, sha256HexOfText } from '../artifact/hash.ts';
import { MAX_IMMUTABLE_ASSET_BYTES } from '../assets/admission.ts';
import type { DeploymentFingerprint } from '../deployment/fingerprint.ts';
import type { ImagesConfig } from '../images/config.ts';
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
  type StaticFileEntry,
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
  readonly reservedRoutes?: readonly ReservedRoute[] | undefined;
  readonly exactPathnames?: readonly string[] | undefined;
  readonly headerRules?: readonly HeaderRule[] | undefined;
  readonly images?: ImagesConfig | undefined;
  readonly cache?: ManifestCache | undefined;
}

/** Assemble a manifest from a build's routes; validates the result against the schema. */
export function buildProjectManifest(input: BuildProjectManifestInput): ProjectManifest {
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
    ...(input.reservedRoutes !== undefined && { reservedRoutes: input.reservedRoutes }),
    ...(input.exactPathnames !== undefined && {
      exactPathnames: Object.fromEntries(input.exactPathnames.map((pathname) => [pathname, true])),
    }),
    ...(input.headerRules !== undefined && { headerRules: input.headerRules }),
    ...(input.images !== undefined && { images: input.images }),
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

export function findStaticFile(
  manifest: ProjectManifest,
  pathname: string,
): StaticFileEntry | undefined {
  if (manifest.staticFiles === undefined) {
    return undefined;
  }
  return Object.hasOwn(manifest.staticFiles, pathname) ? manifest.staticFiles[pathname] : undefined;
}

/** Exact-match route lookup (case-sensitive, no trailing-slash normalization). */
export function findRouteEntry(
  manifest: ProjectManifest,
  pathname: string,
): RouteEntry | undefined {
  return Object.hasOwn(manifest.routes, pathname) ? manifest.routes[pathname] : undefined;
}
