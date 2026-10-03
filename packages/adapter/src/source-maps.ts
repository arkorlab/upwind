import { open, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { BlobRef, SourceMapRef } from '@stayingupwind/core/bundle';
import type { Plugin } from 'rolldown';

import type { BlobStore } from './blobs.ts';
import { EDGE_MODULE } from './edge.ts';
import { exists } from './fs.ts';

/** The module the application's own code is in, as `buildFunction` names it. */
const APP_MODULE = 'app.cjs';

/**
 * The maps a build wrote, and the two things that have to be done with them: given to the bundler
 * as it loads a file, and tied to the file each one describes.
 */

/**
 * Hands Rolldown the maps the build it is bundling already wrote.
 *
 * Without this, a map of the Function's bundle points at the chunks Next.js emitted rather than at
 * the files the project wrote: `sourcemap: true` alone maps output back to *input*, and the input
 * here is `.next/server/chunks/ssr/…_.js`. Those chunks carry `sourceMappingURL` comments and
 * their maps sit beside them, and a bundler composes an input map through to its own output when a
 * plugin gives it one — measured on a fixture, which is the only way to know a bundler's own
 * behaviour here.
 *
 * Ordered after the patches plugin deliberately. A patch rewrites a file's contents, which makes
 * any map of that file wrong; Rolldown takes the first `load` that answers, so a patched file is
 * the patch plugin's and never reaches this one. Those files are Next.js's own internals — a frame
 * inside one maps as far as the chunk and no further, which is honest, and no file the project
 * wrote is among them.
 */

/** What Next.js names a browser map: a file name, plus this. */
export const SOURCE_MAP_SUFFIX = '.map';
/** The comment a build writes to name its map; the only thing that ties a file to one. */
const SOURCE_MAPPING_URL = '//# sourceMappingURL=';
/** How far back the comment is looked for. It is the last line of a file, or near it. */
const TAIL_LENGTH = 512;
const DATA_URL_PREFIX = 'data:';

/** The map file a source names, or nothing — an inline map needs no reading, and is left alone. */
function mapFileOf(code: string, id: string): string | undefined {
  const tail = code.length > TAIL_LENGTH ? code.slice(-TAIL_LENGTH) : code;
  const marker = tail.lastIndexOf(SOURCE_MAPPING_URL);
  if (marker === -1) {
    return undefined;
  }
  const named =
    tail
      .slice(marker + SOURCE_MAPPING_URL.length)
      .trim()
      .split('\n', 1)[0]
      ?.trim() ?? '';
  if (named === '' || named.startsWith(DATA_URL_PREFIX)) {
    return undefined;
  }
  // As a URL, because that is how the comment spells it: Turbopack percent-encodes the brackets
  // in a chunk named `[root-of-the-server]__….js`, and a path taken literally would not exist.
  return path.join(path.dirname(id), decodeURIComponent(named));
}

/**
 * What a bundle is written with when the host asked for maps, and when it did not.
 *
 * `hidden`: a separate file, and no `sourceMappingURL` comment in the output — nothing inside a
 * Worker could load one, and a comment naming a file that is not there only ever misleads.
 *
 * `sourcemapExcludeSources` leaves the sources out. A map that carried them would carry the whole
 * application a second time, and what a stack needs is the name of a file and a line in it, not
 * the line's text. A build with no maps asked for pays none of it.
 */
export function sourcemapOutput(carry: boolean): {
  readonly sourcemap: 'hidden' | false;
  readonly sourcemapExcludeSources?: true;
} {
  return carry ? { sourcemap: 'hidden', sourcemapExcludeSources: true } : { sourcemap: false };
}

export function sourceMapsPlugin(): Plugin {
  return {
    name: 'arkor-source-maps',
    load: {
      // Only what a build emits. A `.ts` of this repository's own is compiled by Rolldown itself,
      // which knows where it came from without being told.
      filter: { id: /\.(?:js|cjs|mjs)$/u },
      async handler(id) {
        let code: string;
        try {
          code = await readFile(id, 'utf8');
        } catch {
          // Not a file on disk: a virtual module another plugin resolved, which has no map.
          return null;
        }
        const mapFile = mapFileOf(code, id);
        if (mapFile === undefined) {
          return null;
        }
        try {
          return { code, map: await readFile(mapFile, 'utf8'), moduleType: 'js' as const };
        } catch {
          // The comment names a map the build did not write. The file is still the file.
          return { code, moduleType: 'js' as const };
        }
      },
    },
  };
}

/**
 * The map a built file names, by the map's own served pathname, or nothing.
 *
 * The only thing that ties a chunk to its map. With content-addressed assets the two are named
 * independently — `01giaql8az_p-.js` names `11yysmhf277n1.js.map` — so a map cannot be found by
 * taking `.map` off a chunk's name, and a name arrived at that way belongs to no file at all.
 */
async function mapNamedBy(file: string, pathname: string): Promise<string | undefined> {
  let tail: string;
  try {
    await using handle = await open(file, 'r');
    const size = (await handle.stat()).size;
    const length = Math.min(size, TAIL_LENGTH);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    tail = buffer.toString('utf8');
  } catch {
    return undefined;
  }
  const marker = tail.lastIndexOf(SOURCE_MAPPING_URL);
  if (marker === -1) {
    return undefined;
  }
  const named =
    tail
      .slice(marker + SOURCE_MAPPING_URL.length)
      .trim()
      .split('\n', 1)[0]
      ?.trim() ?? '';
  if (named === '' || named.includes('/') || named.startsWith(DATA_URL_PREFIX)) {
    // A map beside the file it describes is the only shape a build here writes; anything else is
    // one this cannot place, and a wrong association would be worse than none.
    return undefined;
  }
  return `${pathname.slice(0, pathname.lastIndexOf('/') + 1)}${named}`;
}

/**
 * Each map under the name of the file it describes, which is what a browser's stack frame says.
 *
 * A map nothing names is dropped: nothing could ever look it up, and carrying it would be bytes
 * in every deployment for no reader.
 */
export async function linkClientMaps(
  built: readonly { readonly pathname: string; readonly filePath: string }[],
  maps: ReadonlyMap<string, BlobRef>,
): Promise<SourceMapRef[]> {
  if (maps.size === 0) {
    return [];
  }
  const linked: SourceMapRef[] = [];
  for (const file of built) {
    const named = await mapNamedBy(file.filePath, file.pathname);
    const blob = named === undefined ? undefined : maps.get(named);
    if (blob !== undefined) {
      linked.push({ kind: 'client', name: file.pathname, blob });
    }
  }
  return linked;
}

/**
 * The names a Function's code is uploaded under: `app.cjs` and `edge.cjs`, as they always were, and
 * `app-2.cjs` and `edge-2.cjs` for the Function `app-2`. A server's stack frame names the module,
 * so a frame from one app Function is not read against another's map.
 */
export function codeModules(name: string): { readonly app: string; readonly edge: string } {
  const suffix = /^app(-\d+)$/u.exec(name)?.[1];
  return suffix === undefined
    ? { app: APP_MODULE, edge: EDGE_MODULE }
    : { app: `app${suffix}.cjs`, edge: `edge${suffix}.cjs` };
}

/**
 * The maps of this Function's own modules.
 *
 * The two that hold the application's code — `app.cjs`, and `edge.cjs` for the entrypoints Next.js
 * built for its edge runtime; `app-2.cjs` and `edge-2.cjs` in the app Function `app-2` of a split
 * build (`codeModules`). The runtime's `index.mjs` is this package's own source, built without a
 * map on purpose: a host debugging the runtime has the sources.
 *
 * Named `<function>/<module>`, the way the bundle already names a Function: the app and the
 * middleware Function of one deployment both hold an `app.cjs`, and a map that named only the
 * module would be two different maps under one name.
 */
export async function functionSourceMaps(
  blobs: BlobStore,
  kind: string,
  built: { readonly app: string; readonly edge: string | undefined },
): Promise<SourceMapRef[]> {
  const names = codeModules(kind);
  const modules = [
    { module: names.app, file: built.app },
    ...(built.edge === undefined ? [] : [{ module: names.edge, file: built.edge }]),
  ];
  const maps: SourceMapRef[] = [];
  for (const { module, file } of modules) {
    const mapFile = `${file}.map`;
    if (await exists(mapFile)) {
      maps.push({
        kind: 'function',
        name: `${kind}/${module}`,
        blob: await blobs.putFile(mapFile, 'application/json'),
      });
    }
  }
  return maps;
}
