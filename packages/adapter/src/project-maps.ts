import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { decode, encode, type SourceMapSegment } from '@jridgewell/sourcemap-codec';

import { isUnder } from './fs.ts';

/**
 * A Function's map, kept to the files the project wrote (`sourceMaps: 'project'`).
 *
 * A Function's map is one map for the whole server, and a host reads all of it to place a single
 * frame. Most of it describes code nobody reading a stack is looking for — the packages the
 * application imports, which in an application of any size are most of what it bundles — and kept
 * to the project's own files the same map is a fraction of the size, with every frame in the
 * project's code still reading as written.
 *
 * What goes: a mapping into a package (`node_modules`), into the build's output (`distDir`, the
 * chunks of a map composed only part of the way), into the modules Turbopack generates and never
 * writes (`.next-internal`), into the modules this adapter generates (its own output directory),
 * and into anything that is not a path at all — a bundler's virtual module, named with a scheme of
 * its own. A file of the repository's outside the project — a workspace package of a monorepo —
 * stays: it is the project's own code, imported by path.
 *
 * What a frame in the code that went resolves to is nothing, not the line before it. A position
 * reads as the last mapping at or before it on its line, so taking a mapping out would leave the
 * one before it to answer for code it does not describe; each run of dropped mappings is replaced
 * by one that names no source (a segment of a generated column alone, which the specification
 * defines as exactly that), and the frame reads as built.
 */

/** Where the maps a host keeps are allowed to lead, and where they are not. */
export interface ProjectBounds {
  readonly projectDir: string;
  readonly distDir: string;
  /** The adapter's own output directory, where the modules it generates are written. */
  readonly outDir: string;
}

/**
 * Turbopack's own directory for the modules it generates — a page's server actions loader, among
 * others — named as if it were under the project, and never written to disk.
 */
const TURBOPACK_GENERATED = '.next-internal';
const NODE_MODULES = 'node_modules';
const FILE_URL = 'file://';
/**
 * A source named by a scheme rather than a path: `turbopack:`, `webpack:`, a plugin's `name:id`.
 * Two characters at least, so a Windows drive letter is still a path.
 */
const SCHEME = /^[a-z][\w+.-]+:/iu;
const LEADING_RELATIVE = /^(?:\.{1,2}\/)+/u;
/** The fields of a segment that names a source and a name, the last of them the name's index. */
const NAMED_SEGMENT = 5;

interface RawMap {
  readonly version?: number;
  readonly file?: string;
  readonly sourceRoot?: string;
  readonly sources: readonly (string | null)[];
  readonly names?: readonly string[];
  readonly mappings: string;
}

/** A source as a file, or nothing when it names a bundler's module rather than a path. */
function sourceFile(source: string, base: string): string | undefined {
  let decoded: string;
  try {
    // A source is a URL, and a dynamic segment's brackets are written escaped (`%5Bslug%5D`).
    decoded = decodeURIComponent(source);
  } catch {
    decoded = source;
  }
  if (decoded.includes('\0')) {
    return undefined;
  }
  if (decoded.startsWith(FILE_URL)) {
    try {
      return fileURLToPath(decoded);
    } catch {
      return undefined;
    }
  }
  if (SCHEME.test(decoded.replace(LEADING_RELATIVE, ''))) {
    return undefined;
  }
  return path.resolve(base, decoded);
}

/**
 * A source as its map names it, `sourceRoot` and all: the specification prepends the root to every
 * source, so a root that is a URL makes every source one — classified as such rather than as a
 * path made up from it.
 */
function withRoot(sourceRoot: string | undefined, source: string): string {
  if (sourceRoot === undefined || sourceRoot === '') {
    return source;
  }
  return sourceRoot.endsWith('/') ? `${sourceRoot}${source}` : `${sourceRoot}/${source}`;
}

function isProjectFile(file: string, bounds: ProjectBounds): boolean {
  // Relative to the project, so a project that itself sits somewhere below a `node_modules` is
  // not taken for a package.
  const segments = path.relative(bounds.projectDir, file).split(path.sep);
  return (
    !segments.includes(NODE_MODULES) &&
    !isUnder(bounds.distDir, file) &&
    !isUnder(path.join(bounds.projectDir, TURBOPACK_GENERATED), file) &&
    !isUnder(bounds.outDir, file)
  );
}

/** The new index of an entry of `from`, adding it to `to` the first time it is asked for. */
function reindexed(
  index: Map<number, number>,
  to: string[],
  from: readonly (string | null)[],
  at: number,
): number {
  const known = index.get(at);
  if (known !== undefined) {
    return known;
  }
  const next = to.length;
  to.push(from[at] ?? '');
  index.set(at, next);
  return next;
}

/**
 * The map in `text`, written at `mapFile`, with only the mappings into the project's own files.
 *
 * `sourcesContent` is not carried (a Function's map is built without it, `sourcemapOutput`), and
 * neither is an `ignoreList`, whose indices would name other sources once these are renumbered.
 */
export function projectOnly(text: string, mapFile: string, bounds: ProjectBounds): string {
  const map = JSON.parse(text) as RawMap;
  const base = path.dirname(mapFile);
  const kept = map.sources.map((source) => {
    const file = source === null ? undefined : sourceFile(withRoot(map.sourceRoot, source), base);
    return file !== undefined && isProjectFile(file, bounds);
  });
  const sources: string[] = [];
  const names: string[] = [];
  const sourceIndex = new Map<number, number>();
  const nameIndex = new Map<number, number>();
  const mappings = decode(map.mappings).map((line) => {
    const out: SourceMapSegment[] = [];
    // Whether the last segment written already says "nothing from here", so a run of dropped
    // mappings costs one segment and not one each.
    let unmapped = false;
    for (const segment of line) {
      if (segment.length === 1 || kept[segment[1]] !== true) {
        if (!unmapped) {
          out.push([segment[0]]);
          unmapped = true;
        }
        continue;
      }
      unmapped = false;
      const source = reindexed(sourceIndex, sources, map.sources, segment[1]);
      out.push(
        segment.length === NAMED_SEGMENT
          ? [
              segment[0],
              source,
              segment[2],
              segment[3],
              reindexed(nameIndex, names, map.names ?? [], segment[4]),
            ]
          : [segment[0], source, segment[2], segment[3]],
      );
    }
    return out;
  });
  return JSON.stringify({
    version: 3,
    ...(map.file !== undefined && { file: map.file }),
    ...(map.sourceRoot !== undefined && { sourceRoot: map.sourceRoot }),
    sources,
    names,
    mappings: encode(mappings),
  });
}
