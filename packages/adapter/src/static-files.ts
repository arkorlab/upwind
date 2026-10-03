import path from 'node:path';

import type { Routing, SourceMapRef, StaticFile } from '@stayingupwind/core/bundle';
import type { AdapterOutput } from 'next';

import { type BlobStore, contentTypeFor } from './blobs.ts';
import {
  aliasPathname,
  type BuildContext,
  exportedPathname,
  immutableByBuild,
  isStaticExport,
  orDefault,
  staticFileContentType,
  walk,
} from './collect.ts';
import { exists } from './fs.ts';
import type { KeptMaps } from './kept-maps.ts';
import { withBasePath } from './segments.ts';
import { linkClientMaps, SOURCE_MAP_SUFFIX } from './source-maps.ts';

/**
 * What a deployment serves as files, and the maps of the ones that have them.
 *
 * Its own module because the two belong together: which outputs are served is decided here, and
 * which are taken out of serving because they describe another file is the same decision.
 */

/**
 * `_next/static` from the build output, plus everything under `public/`. Next.js names its own
 * outputs under the `basePath`; a public file is requested under it too (`/docs/manual.pdf`),
 * and is named so here.
 *
 * A static export is the whole site instead: `next build` hands over everything it wrote to
 * `out/`, `public/` copied in and all, so the directory is not walked a second time, and each file
 * is named where a static host would serve it (`exportedPathname`).
 */
export interface CollectedStaticFiles {
  readonly files: StaticFile[];
  /**
   * The browser maps, taken out of what is served. Next.js emits one beside every client chunk
   * when `productionBrowserSourceMaps` is on and serves them; a deployment that published them
   * would publish the application's source, so they are carried as blobs and served to nobody.
   * Empty unless the host asked for maps.
   */
  readonly sourceMaps: SourceMapRef[];
}

/**
 * What `public/` holds, each named as a URL names it: the edge and the runtime look a file up by
 * the request's own pathname. A static export needs none of this — `next build` copied the
 * directory into `out/` and handed every file over already.
 */
async function publicFiles(
  projectDir: string,
  basePath: string,
  blobs: BlobStore,
): Promise<StaticFile[]> {
  const publicDir = path.join(projectDir, 'public');
  if (!(await exists(publicDir))) {
    return [];
  }
  const collected: StaticFile[] = [];
  const found = await walk(publicDir);
  for (const file of found) {
    const pathname = `/${path
      .relative(publicDir, file)
      .split(path.sep)
      .map((segment) => encodeURIComponent(segment))
      .join('/')}`;
    collected.push({
      pathname: withBasePath(basePath, pathname),
      blob: await blobs.putFile(file, contentTypeFor(file)),
      immutable: false,
    });
  }
  return collected;
}

/**
 * A map put aside, or a script noted for the pass that ties the two together.
 *
 * Answers whether this output was a map, which is the one case the caller stops on: a map is not
 * a file the deployment serves. It is put aside as the file, not yet as a blob: only a map some
 * chunk names is carried, and it is carried as `linkClientMaps` writes it.
 */
function sorted(
  output: AdapterOutput['STATIC_FILE'],
  maps: Map<string, string>,
  scripts: { pathname: string; filePath: string }[],
): boolean {
  if (output.pathname.endsWith(SOURCE_MAP_SUFFIX)) {
    maps.set(output.pathname, output.filePath);
    return true;
  }
  if (output.pathname.endsWith('.js')) {
    scripts.push({ pathname: output.pathname, filePath: output.filePath });
  }
  return false;
}

export async function collectStaticFiles(
  ctx: BuildContext,
  blobs: BlobStore,
  /**
   * Whether the host asked for the maps. Off, a `.map` is a file like any other and is served as
   * it always was — a project may have turned `productionBrowserSourceMaps` on itself, and a
   * static export ships whatever `public/` held.
   */
  carryMaps = false,
  /** The maps that came through the build's `runAfterProductionCompile` (`kept-maps.ts`). */
  kept?: KeptMaps,
): Promise<CollectedStaticFiles> {
  const basePath = orDefault(ctx.config.basePath, '');
  const exported = isStaticExport(ctx.config);
  const naming = { basePath, trailingSlash: orDefault(ctx.config.trailingSlash, false) };
  const files: StaticFile[] = [];
  /** Map files by their own served pathname, until `linkClientMaps` says which file each describes. */
  const maps = new Map<string, string>();
  /** The built JavaScript, for the same pass: only these carry a `sourceMappingURL`. */
  const scripts: { pathname: string; filePath: string }[] = [];
  for (const output of ctx.outputs.staticFiles) {
    if (carryMaps && sorted(output, maps, scripts)) {
      continue;
    }
    const blob = await blobs.putFile(output.filePath, staticFileContentType(output));
    // The name the file is served under, which is the name a rule is judged against: a document
    // moves from `/index` to `/` and from `/about/index` to `/about/`, and the edge matches the
    // header rules on the request's own pathname, not on the one the build handed over.
    const pathname = exported ? exportedPathname(output, naming) : output.pathname;
    const immutable = exported
      ? immutableByBuild(ctx.routing.onMatch, pathname)
      : output.immutableHash !== undefined;
    files.push({ pathname, blob, immutable });
    // A Pages Router page written as `/index` answers the application's root under both names. An
    // export needs no alias: every document of one is already named where a static host serves it,
    // and a rewrite — the reason the build's own name is kept — is not followed for one anyway.
    const alias = exported ? undefined : aliasPathname(output.pathname, basePath);
    if (alias !== undefined) {
      files.push({ pathname: alias, blob, immutable });
    }
  }
  files.push(...(exported ? [] : await publicFiles(ctx.projectDir, basePath, blobs)));
  return {
    files,
    sourceMaps: carryMaps ? await linkClientMaps(scripts, maps, blobs, kept) : [],
  };
}

/** Where the build's own files are served from, under the base path. */
const BUILD_FILES = '/_next/static';
/** Where a destination names a value the request supplies: a pattern's group or a parameter. */
const FROM_REQUEST = /^[$:]/u;

/**
 * Whether a rewrite of the build's may land a request on a file under `_next/static`: a
 * destination that names one, or one whose first segment the request supplies — `/:path*`, which
 * `next build` writes `/$1`. A catch-all that mounts the application under another path
 * (`/docs/:path*` → `/:path*`) is the case: its `/docs/_next/static/…` is the build's own file.
 * An absolute destination is another origin's, and a redirect sends the client elsewhere.
 */
function mayRewriteToBuildFiles(routing: Routing, basePath: string): boolean {
  return [...routing.beforeFiles, ...routing.afterFiles, ...routing.fallback].some((route) => {
    const destination = route.destination?.split('?', 1)[0];
    if (destination === undefined || route.status !== undefined || !destination.startsWith('/')) {
      return false;
    }
    const inApp =
      basePath !== '' && destination.startsWith(`${basePath}/`)
        ? destination.slice(basePath.length)
        : destination;
    return inApp.startsWith(`${BUILD_FILES}/`) || FROM_REQUEST.test(inApp.slice(1));
  });
}

/**
 * The files under `_next/static` the Function answers itself, though it does not carry them: what
 * a rewrite of the build's may land on (`mayRewriteToBuildFiles`), read from the host that keeps
 * every file of the build when one is asked for. The edge serves these files by their own names;
 * under a rewrite's source name a request reaches the Function, which routes it, and before this
 * found no file there and answered the not-found page. None for a build with no such rewrite: each
 * is a line of the manifest the Function parses before its first response.
 */
export function rewriteTargetFiles(
  files: readonly StaticFile[],
  routing: Routing,
  basePath: string,
): StaticFile[] {
  if (!mayRewriteToBuildFiles(routing, basePath)) {
    return [];
  }
  const prefix = `${basePath}${BUILD_FILES}/`;
  return files.filter((file) => file.pathname.startsWith(prefix));
}
