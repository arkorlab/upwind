import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { Plugin } from 'rolldown';

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

/** The comment a build writes to name its map; the cheap test before anything is read. */
const SOURCE_MAPPING_URL = '//# sourceMappingURL=';
/** How far back the comment is looked for. It is the last line of a file, or near it. */
const TAIL_LENGTH = 512;
const DATA_URL_PREFIX = 'data:';

/** The map file a source names, or nothing — an inline map needs no reading, and is left alone. */
function mapFileOf(code: string, id: string): string | undefined {
  const tail = code.length > TAIL_LENGTH ? code.slice(-TAIL_LENGTH) : code;
  const marker = tail.lastIndexOf(SOURCE_MAPPING_URL);
  if (marker < 0) {
    return undefined;
  }
  const named =
    tail
      .slice(marker + SOURCE_MAPPING_URL.length)
      .trim()
      .split('\n')[0]
      ?.trim() ?? '';
  if (named === '' || named.startsWith(DATA_URL_PREFIX)) {
    return undefined;
  }
  // As a URL, because that is how the comment spells it: Turbopack percent-encodes the brackets
  // in a chunk named `[root-of-the-server]__….js`, and a path taken literally would not exist.
  return path.join(path.dirname(id), decodeURIComponent(named));
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
