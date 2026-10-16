import {
  type DeploymentBundle,
  edgeServedRewrites,
  staticFileAssetPrefixOf,
} from '@stayingupwind/core/bundle';
import { type StaticFileEntry, staticFileStatus } from '@stayingupwind/core/manifest';

/**
 * The files a deployment's manifest serves beside its routes: this build's, and the ones of the
 * deployment served just before that its documents still open ask for.
 */

const HTTP_OK = 200;

type BundledStaticFile = DeploymentBundle['staticFiles'][number];
type StaticFileBytes = Pick<StaticFileEntry, 'byteLength' | 'contentType' | 'sha256'>;

function staticFileBytes(file: BundledStaticFile): StaticFileBytes {
  return {
    sha256: file.blob.sha256,
    byteLength: file.blob.byteLength,
    contentType: file.blob.contentType,
  };
}

/** The entry for a file, with the status an error document is answered with. */
function staticFileEntry(file: BundledStaticFile, basePath: string): StaticFileEntry {
  const status = staticFileStatus(file.pathname, basePath);
  return {
    ...staticFileBytes(file),
    immutable: file.immutable,
    ...(status !== HTTP_OK && { status }),
  };
}

/** The build's own files under `_next/static`, named by hash; nothing a visitor would type. */
const NEXT_STATIC_PREFIX = '/_next/static/';

/**
 * The asset prefix the deployment before loaded its files from, when this one does not find them
 * there as it did: another prefix, or the same one onto another base path. Its documents still
 * open ask for their files under it, and the edge takes off only the prefix the manifest names,
 * onto this deployment's base path (`staticFileKey`).
 */
function movedAssetPrefix(
  bundle: DeploymentBundle,
  previous: DeploymentBundle,
): string | undefined {
  const before = staticFileAssetPrefixOf(previous);
  const now = staticFileAssetPrefixOf(bundle);
  return before === undefined ||
    (before.assetPrefix === now?.assetPrefix && before.basePath === now.basePath)
    ? undefined
    : before.assetPrefix;
}

/**
 * A file only the deployment before built, kept for the documents of it still open, which ask for
 * it by its `dpl`. One under the build id both builds have — Next.js gives every build with a
 * deployment id the same one — answers only those (`dplOnly`): its name is this deployment's to
 * answer, with whatever its routing makes of it, for a request that names no deployment, and the
 * documents before put their `dpl` on every request for one of these.
 */
function keptEntry(
  file: BundledStaticFile,
  bundle: DeploymentBundle,
  previous: DeploymentBundle,
): StaticFileEntry {
  const underBuildId = `${previous.config.basePath}${NEXT_STATIC_PREFIX}${previous.buildId}/`;
  const ownName = bundle.buildId === previous.buildId && file.pathname.startsWith(underBuildId);
  return {
    ...staticFileEntry(file, previous.config.basePath),
    deploymentId: previous.deploymentId,
    ...(ownName && { dplOnly: true as const }),
  };
}

/** A name both builds have: this build's entry, with the previous build's bytes beside it. */
function sharedEntry(
  entry: StaticFileEntry,
  file: BundledStaticFile,
  previous: DeploymentBundle,
): StaticFileEntry {
  return entry.immutable
    ? entry
    : { ...entry, previous: { ...staticFileBytes(file), deploymentId: previous.deploymentId } };
}

/**
 * What the deployment before kept under `_next/static`, filed under the asset prefix it loaded
 * them from as well (`movedAssetPrefix`), where its documents ask for them. A name this build has
 * too, under its own base path, is this build's entry there — the same bytes under a content hash,
 * and else the previous build's beside them, as a name both builds have is anywhere — so that this
 * deployment's own documents, asking under the same prefix, get their own.
 */
function underMovedPrefix(
  files: Record<string, StaticFileEntry>,
  bundle: DeploymentBundle,
  previous: DeploymentBundle,
): void {
  const movedFrom = movedAssetPrefix(bundle, previous);
  if (movedFrom === undefined) {
    return;
  }
  const own = new Map(bundle.staticFiles.map((file) => [file.pathname, file]));
  // The prefix this deployment loads its own files from as well, onto another base path: `next
  // build` rewrites a request under it to the file under this build's base path before it looks
  // for one at the path itself (`beforeFiles`), so a file this build ships at the name answers none.
  const ownPrefix = staticFileAssetPrefixOf(bundle)?.assetPrefix === movedFrom;
  const prefix = `${previous.config.basePath}${NEXT_STATIC_PREFIX}`;
  for (const file of previous.staticFiles) {
    if (!file.pathname.startsWith(prefix)) {
      continue;
    }
    const rest = file.pathname.slice(previous.config.basePath.length);
    const key = `${movedFrom}${rest}`;
    const filed = files[key];
    if (filed !== undefined && !ownPrefix) {
      // The prefix before is this deployment's base path: the name is this build's own file, and
      // a shared one takes the bytes the documents before were built with beside its own.
      if (filed.deploymentId === undefined && filed.previous === undefined) {
        files[key] = sharedEntry(filed, file, previous);
      }
      continue;
    }
    const mine = own.get(`${bundle.config.basePath}${rest}`);
    files[key] =
      mine === undefined
        ? keptEntry(file, bundle, previous)
        : sharedEntry(staticFileEntry(mine, bundle.config.basePath), file, previous);
  }
}

/**
 * This build's files, as the manifest serves them — but none it ships under its own asset prefix's
 * `_next`, a `public/` file there. `next build` rewrites a request under that prefix to this build's
 * `_next` before it looks for a file at the path (`beforeFiles`), so such a file answers no request;
 * filed under its own name, it would be found ahead of the file the request is rewritten to, which
 * the edge finds by taking the prefix off (`staticFileKey`). The same on a first deployment as on
 * any other.
 */
function ownFiles(bundle: DeploymentBundle): Record<string, StaticFileEntry> {
  const prefix = staticFileAssetPrefixOf(bundle);
  const rewritten = prefix === undefined ? undefined : `${prefix.assetPrefix}/_next/`;
  const files: Record<string, StaticFileEntry> = {};
  for (const file of bundle.staticFiles) {
    if (rewritten === undefined || !file.pathname.startsWith(rewritten)) {
      files[file.pathname] = staticFileEntry(file, bundle.config.basePath);
    }
  }
  return files;
}

/**
 * The files the manifest serves: this build's, and under `_next/static` those of the deployment
 * served just before. A document of that deployment still open in a browser asks for the
 * scripts it was built with, by their own paths and its own `dpl`; its Workers are kept for a
 * rollback, and its files are kept for the same interval, one deployment back — never a file
 * from further back, since the previous build's files, not its manifest, are what is carried.
 * A name both builds have is one entry: the same bytes when the name is a content hash, and
 * else this build's bytes with the previous build's beside them, for the deployment that asks
 * for those. A `public/` file that disappeared is gone: that is what removing it means.
 */
export function staticFilesOf(
  bundle: DeploymentBundle,
  previous: DeploymentBundle | undefined,
): Record<string, StaticFileEntry> {
  const files = ownFiles(bundle);
  // A rewrite to a file the Worker does not carry, served here under the path it is asked for.
  for (const served of edgeServedRewrites(bundle)) {
    const entry = staticFileEntry(served.file, bundle.config.basePath);
    // Keep the destination's status explicit: the edge otherwise infers 404/500 from the alias.
    files[served.pathname] = { ...entry, status: entry.status ?? HTTP_OK };
  }
  if (previous === undefined) {
    return files;
  }
  // Named under the basePath, as Next.js names everything of a build.
  const prefix = `${previous.config.basePath}${NEXT_STATIC_PREFIX}`;
  for (const file of previous.staticFiles) {
    if (!file.pathname.startsWith(prefix)) {
      continue;
    }
    const current = files[file.pathname];
    if (current === undefined) {
      files[file.pathname] = keptEntry(file, bundle, previous);
    } else if (!current.immutable) {
      files[file.pathname] = {
        ...current,
        previous: { ...staticFileBytes(file), deploymentId: previous.deploymentId },
      };
    }
  }
  underMovedPrefix(files, bundle, previous);
  return files;
}
