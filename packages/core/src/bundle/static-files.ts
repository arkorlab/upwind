import type { StaticFileAssetPrefix, StaticFileLocales } from '../manifest/schema.ts';
import type { DeploymentBundle, Route, StaticFile } from './schema.ts';

/**
 * A shipped file of the build: where the edge finds it besides its own name, and whether the
 * application's Function carries it too. Pure functions of the bundle, as `serving.ts`'s are.
 */

/**
 * The documents `next build` writes for an error, which the Function answers a miss with — under
 * these exact names, which are the ones the runtime looks them up by. A `trailingSlash` export
 * writes its not-found a second time, as `404/index.html`, for a visitor who types that path; that
 * one is a file like any other page of the site, so the edge serves it from storage and the Function
 * never opens it.
 */
const ERROR_DOCUMENTS: readonly string[] = ['/404', '/500'];
const KIB = 1024;
const MAX_FUNCTION_FILE_KIB = 256;
/** The largest file, other than an error document, that is shipped with the Function as well. */
const MAX_FUNCTION_FILE_BYTES = MAX_FUNCTION_FILE_KIB * KIB;

/**
 * The default locales a shipped file is found behind as well, in an application with `i18n`: its
 * own, and each domain's, under its base path — what Next.js's filesystem check takes out of a
 * static file's path. `undefined` for an application without `i18n`.
 */
export function staticFileLocalesOf(bundle: DeploymentBundle): StaticFileLocales | undefined {
  const { basePath, i18n } = bundle.config;
  if (i18n === null || i18n === undefined) {
    return undefined;
  }
  const domains = (i18n.domains ?? []).map((domain) => domain.defaultLocale);
  return { basePath, locales: [...new Set([i18n.defaultLocale, ...domains])] };
}

/**
 * The rewrite `next build` writes, first of its `beforeFiles`, for an `assetPrefix`:
 * `<assetPrefix>/_next/:path+` to `<basePath>/_next/:path+` (`loadRewrites`, in
 * `lib/load-custom-routes.ts`). `undefined` for a build without one.
 */
export function assetPrefixRewrite(bundle: DeploymentBundle): Route | undefined {
  const { assetPrefix, basePath } = bundle.config;
  const [rule] = bundle.routing.beforeFiles;
  if (
    assetPrefix === undefined ||
    rule?.source !== `${assetPrefix}/_next/:path+` ||
    rule.destination !== `${basePath}/_next/$1` ||
    rule.status !== undefined ||
    rule.has !== undefined ||
    rule.missing !== undefined
  ) {
    return undefined;
  }
  return rule;
}

/**
 * Where a shipped file under the base path's `_next` is found as well, in an application with an
 * `assetPrefix` `next build` rewrites from: under the prefix (`assetPrefixRewrite`). `undefined`
 * for any other.
 *
 * A later `beforeFiles` rule that may claim the path a file lands on leaves that file, not every
 * file, to the router: the edge asks it of each request, as it asks its other rules (`isReserved`).
 * Decided here for the whole build, one rule that might claim one chunk had every script under
 * the prefix handed to the Function, which carries none of them.
 */
export function staticFileAssetPrefixOf(
  bundle: DeploymentBundle,
): StaticFileAssetPrefix | undefined {
  const { basePath, assetPrefix } = bundle.config;
  return assetPrefix === undefined || assetPrefixRewrite(bundle) === undefined
    ? undefined
    : { basePath, assetPrefix };
}

/**
 * Whether a file of the build is shipped inside the application's Function as well as held by the
 * edge. The error documents always are — the Function answers its own misses with them — and so is
 * anything small outside `_next/static`, which a rewrite may name. Everything else stays with the
 * edge alone: a Function has a size limit, and a public asset need not count against it.
 */
export function travelsWithFunction(file: StaticFile, basePath: string, exported = false): boolean {
  if (ERROR_DOCUMENTS.some((document) => file.pathname === `${basePath}${document}`)) {
    return true;
  }
  // A static export ships nothing else: the edge serves every file from storage in every mode the
  // pointer can be in, and the one reason the Function carries a small file — a middleware rewrite
  // that lands on it — cannot arise, since a static export has no middleware. A site's every
  // document is a file here, and a Function carrying them all would outgrow its size limit.
  if (exported) {
    return false;
  }
  return (
    !file.pathname.startsWith(`${basePath}/_next/`) &&
    file.blob.byteLength <= MAX_FUNCTION_FILE_BYTES
  );
}
