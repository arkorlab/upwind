import path from 'node:path';

import type { Route, Routing, SourceMapRef, StaticFile } from '@stayingupwind/core/bundle';
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
 * Whether a file of a static export is one Next.js wrote under the build id,
 * `_next/static/<buildId>/`: a name the build id gives it, not its bytes. Every build with a
 * `deploymentId` has the same build id (`getBuildId`) and writes its own manifests there, so the
 * name is not the same bytes for every deployment, whatever the rule says of the response
 * (`immutableByBuild`). A build that is not an export says the same by giving these files no
 * `immutableHash`.
 */
function underBuildId(pathname: string, basePath: string, buildId: string): boolean {
  return pathname.startsWith(`${basePath}/_next/static/${buildId}/`);
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
      ? immutableByBuild(ctx.routing.onMatch, pathname) &&
        !underBuildId(pathname, basePath, ctx.buildId)
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

/** A value a destination is filled in with: `$1` for a parameter of the source, `$name` otherwise. */
const REFERENCE = /\$(?:(\d+)|[A-Za-z_]\w*)|:[A-Za-z_]\w*[*+?]?/gu;
/** What a source pattern's parameter name is made of (`path-to-regexp`). */
const NAME_CHARACTER = /\w/u;
/** The modifiers that repeat a parameter, its slashes with it. */
const REPEATING = new Set(['*', '+']);

/** Where the pattern that opens at `source[open]` ends — past its `)`, groups within it and all. */
function patternEnd(source: string, open: number): number {
  let depth = 0;
  for (let at = open; at < source.length; at += 1) {
    switch (source.charAt(at)) {
      case '\\': {
        at += 1;
        break;
      }
      case '(': {
        depth += 1;
        break;
      }
      case ')': {
        depth -= 1;
        if (depth === 0) {
          return at + 1;
        }
        break;
      }
      default:
    }
  }
  return source.length;
}

/**
 * Where the parameter at `source[at]` — `:name`, `:name(…)` or `(…)` — ends, and whether it may
 * stand for more than one segment, as one that brings its own pattern or repeats may.
 */
function parameterAt(source: string, at: number): { end: number; spans: boolean } {
  let end = at;
  if (source.charAt(end) === ':') {
    end += 1;
    while (NAME_CHARACTER.test(source.charAt(end))) {
      end += 1;
    }
  }
  const ownPattern = source.charAt(end) === '(';
  if (ownPattern) {
    end = patternEnd(source, end);
  }
  return { end, spans: ownPattern || REPEATING.has(source.charAt(end)) };
}

/**
 * Whether each parameter of a rewrite's source, in order, may stand for more than one segment —
 * read as `next build` reads it (`path-to-regexp`, the delimiter `/`): one that repeats (`:path*`,
 * `:path+`, a group that does) or that brings its own pattern (`:path(.*)`, `(.*)`) may; a bare
 * `:name` is one segment. Its position is the number a destination fills it in with (`$1`).
 */
function parameterSpans(source: string): boolean[] {
  const spans: boolean[] = [];
  let group: boolean[] | undefined;
  let at = 0;
  while (at < source.length) {
    switch (source.charAt(at)) {
      case '\\': {
        at += 2;
        break;
      }
      case '{': {
        group = [];
        at += 1;
        break;
      }
      case '}': {
        at += 1;
        // A group's modifier follows the brace, and repeats whatever parameter the group holds.
        const repeats = REPEATING.has(source.charAt(at));
        spans.push(...(group ?? []).map((span) => span || repeats));
        group = undefined;
        break;
      }
      case ':':
      case '(': {
        const parameter = parameterAt(source, at);
        (group ?? spans).push(parameter.spans);
        at = parameter.end;
        break;
      }
      default: {
        at += 1;
      }
    }
  }
  return spans;
}

/**
 * What a rewrite of the build's may land a request on, as a pattern of pathnames: its destination,
 * with each value the request fills it in with matched as what that value may be — one segment for
 * a source's bare parameter, anything for the rest (a repeating one, one with its own pattern, a
 * value a `has` condition captured). `undefined` for a route that lands nowhere in the build: a
 * redirect, which sends the client elsewhere, and an absolute destination, another origin's.
 */
function landingOf(route: Route): RegExp | undefined {
  const destination = route.destination?.split('?', 1)[0];
  if (destination === undefined || route.status !== undefined || !destination.startsWith('/')) {
    return undefined;
  }
  const spans = route.source === undefined ? [] : parameterSpans(route.source);
  let pattern = '';
  let last = 0;
  for (const reference of destination.matchAll(REFERENCE)) {
    const position = reference[1] === undefined ? undefined : Number(reference[1]) - 1;
    const oneSegment = position !== undefined && spans[position] === false;
    pattern += `${escapeRegExp(destination.slice(last, reference.index))}${oneSegment ? '[^/]*' : '.*'}`;
    last = reference.index + reference[0].length;
  }
  pattern += escapeRegExp(destination.slice(last));
  // Made of the build's own configuration, at build time, its literal text escaped.
  // eslint-disable-next-line security/detect-non-literal-regexp
  return new RegExp(`^${pattern}$`, 'u');
}

function escapeRegExp(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
}

/**
 * The files under `_next/static` the Function answers itself, though it does not carry them: each
 * a rewrite of the build's may land a request on (`landingOf`), read from the host that keeps every
 * file of the build when one is asked for. A catch-all that mounts the application under another
 * path (`/docs/:path*` → `/:path*`) is the case: its `/docs/_next/static/…` is the build's own file.
 * The edge serves these files by their own names; under a rewrite's source name a request reaches
 * the Function, which routes it, and before this found no file there and answered the not-found
 * page. Only those a rewrite can reach — none for a build with no such rewrite, and none for one
 * whose destinations fill in a segment at a time (`/:slug` → `/$1`): each is a line of the manifest
 * the Function parses before its first response.
 */
export function rewriteTargetFiles(
  files: readonly StaticFile[],
  routing: Routing,
  basePath: string,
): StaticFile[] {
  const landings = [...routing.beforeFiles, ...routing.afterFiles, ...routing.fallback]
    .map((route) => landingOf(route))
    .filter((landing) => landing !== undefined);
  const prefix = `${basePath}${BUILD_FILES}/`;
  const buildFiles = files.filter((file) => file.pathname.startsWith(prefix));
  return buildFiles.filter((file) => landings.some((landing) => landing.test(file.pathname)));
}
