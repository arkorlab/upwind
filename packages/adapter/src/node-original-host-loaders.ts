import { createHash } from 'node:crypto';

import type { OutputChunk, Plugin } from 'rolldown';
import { parseAst } from 'rolldown/parseAst';

import { AuditError } from './dependencies.ts';
import { identifier, stringOf, walk } from './native-ast.ts';
import {
  ORIGINAL_HOST_MARKER_PREFIX as MARKER_PREFIX,
  originalNodeHostLoaderSites,
  type OriginalNodeHostLoaderSite,
} from './node-original-host-proof.ts';

const MARKER = `${MARKER_PREFIX}LOADER__`;
const MARKER_ARGUMENTS = 2;
const BYTES_PER_MEBIBYTE = 1_048_576;
const MAX_SOURCE_MEBIBYTES = 128;
const MAX_SOURCE_BYTES = MAX_SOURCE_MEBIBYTES * BYTES_PER_MEBIBYTE;
const SOURCE_SHA = /^[a-f0-9]{64}$/u;

interface OriginalSource {
  readonly file: string;
  readonly sha256: string;
}
export interface RetainedOriginalHostLoader {
  readonly importer: string;
  readonly file: string;
  readonly sha256: string;
  readonly analysisSha256: string;
  readonly start: number;
  readonly end: number;
}
interface MarkedSite {
  readonly id: string;
  readonly identity: RetainedOriginalHostLoader;
  readonly expressionStart: number;
  readonly expressionEnd: number;
}
interface Boundary {
  readonly open: MarkedSite[];
  readonly close: MarkedSite[];
}

function digest(source: string): string {
  return createHash('sha256').update(source).digest('hex');
}

function markedSite(
  importer: string,
  original: OriginalSource,
  analysisSha256: string,
  site: OriginalNodeHostLoaderSite,
): MarkedSite {
  const identity = {
    importer,
    ...original,
    analysisSha256,
    start: site.start,
    end: site.end,
  };
  return {
    id: digest(JSON.stringify({ ...identity, ...site })),
    identity,
    expressionStart: site.expressionStart,
    expressionEnd: site.expressionEnd,
  };
}

function boundaryAt(boundaries: Map<number, Boundary>, position: number): Boundary {
  let boundary = boundaries.get(position);
  if (boundary === undefined) {
    boundary = { open: [], close: [] };
    boundaries.set(position, boundary);
  }
  return boundary;
}

function instrument(source: string, sites: readonly MarkedSite[]): string {
  const boundaries = new Map<number, Boundary>();
  for (const site of sites) {
    boundaryAt(boundaries, site.expressionStart).open.push(site);
    boundaryAt(boundaries, site.expressionEnd).close.push(site);
  }
  let code = '';
  let previous = 0;
  const positions = [...boundaries.keys()].toSorted((left, right) => left - right);
  for (const position of positions) {
    const boundary = boundaries.get(position);
    if (boundary === undefined) throw new AuditError('Missing original host marker boundary');
    code += source.slice(previous, position) + ')'.repeat(boundary.close.length);
    const openings = boundary.open.toSorted(
      (left, right) => right.expressionEnd - left.expressionEnd,
    );
    for (const site of openings) code += `${MARKER}(${JSON.stringify(site.id)},`;
    previous = position;
  }
  return code + source.slice(previous);
}

function sourceSites(source: string, importer: string): readonly OriginalNodeHostLoaderSite[] {
  // Match the original graph loader's executable suffixes; unsupported syntax still refuses.
  if (!/\.[cm]?[jt]sx?$/u.test(importer)) return [];
  if (source.includes(MARKER_PREFIX))
    throw new AuditError('Reserved original host analysis marker appears in application source');
  if (Buffer.byteLength(source) > MAX_SOURCE_BYTES)
    throw new AuditError('Original host analysis source exceeds its limit');
  return originalNodeHostLoaderSites(importer, source);
}

/** Analysis-only wrappers are compressed with the source and never enter the physical artifact. */
export function originalHostLoadersPlugin(sources: ReadonlyMap<string, OriginalSource>): {
  readonly plugin: Plugin;
  retained(chunk: Pick<OutputChunk, 'code'>): readonly RetainedOriginalHostLoader[];
} {
  const markers = new Map<string, RetainedOriginalHostLoader>();
  return {
    plugin: {
      name: 'upwind-original-host-loaders',
      transform(source, importer) {
        const sites = sourceSites(source, importer);
        if (sites.length === 0) return null;
        const original = sources.get(importer);
        if (original === undefined || !SOURCE_SHA.test(original.sha256))
          throw new AuditError('Original host operation has no physical source identity');
        const sha256 = digest(source);
        const registered = sites.map((site) => markedSite(importer, original, sha256, site));
        for (const site of registered) markers.set(site.id, site.identity);
        return { code: instrument(source, registered), moduleType: 'js' };
      },
    },
    retained(chunk) {
      const retained = new Map<string, RetainedOriginalHostLoader>();
      const tree = walk(parseAst(chunk.code));
      const callees = new Set<unknown>();
      for (const node of tree) {
        if (node.type !== 'CallExpression' || !identifier(node.callee, MARKER)) continue;
        const id = stringOf(node.arguments[0]);
        const site = id === undefined ? undefined : markers.get(id);
        if (site === undefined || node.arguments.length !== MARKER_ARGUMENTS || node.optional)
          throw new AuditError('Malformed or unregistered original host analysis marker');
        callees.add(node.callee);
        retained.set(id, site);
      }
      for (const node of tree) {
        if (node.type === 'Identifier' && node.name.startsWith(MARKER_PREFIX) && !callees.has(node))
          throw new AuditError('Malformed or unregistered original host analysis marker');
      }
      return [...retained.values()];
    },
  };
}
