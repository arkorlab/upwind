import type { Node } from './lexical-scope.ts';
import { nodeJwtGlobalRecoverySite } from './node-jwt-compiler-sites.ts';
import { nodeFastJwtBindingSite } from './node-jwt-fast-sites.ts';
import type { NativeNextRelease } from './node-next-release.ts';
import type { NodeNextRequireHookSites } from './node-next-require-hook-sites.ts';

/** The one site of a qualified source the ordinary closure walker refuses, and how it reads it. */
export interface NodeJwtCompilerSite {
  /** A code compiler call, or a Node loader read. */
  readonly kind: 'compiler' | 'loader';
  readonly node: Node;
}

/** The JWT library a release of Next.js compiles in, by its exact published bytes. */
export interface NodeJwtCompilerProfile {
  readonly name: 'next-16.4.3-jsonwebtoken-ncc-v1' | 'next-16.4.4-fast-jwt-ncc-v1';
  /** The releases that publish it, byte for byte. */
  readonly releases: readonly NativeNextRelease['version'][];
  readonly suffix: string;
  readonly sha256: string;
  readonly bytes: number;
  /** The builtins it loads, each by the exact specifier it writes. */
  readonly builtins: readonly string[];
  /** The no-op module Next.js substitutes for its `semver`, where it has one. */
  readonly semverSha256?: string;
  site(program: unknown): NodeJwtCompilerSite | undefined;
}

/** The require hook's exempt loader operations, with a qualified source's own loader read. */
export function withNodeJwtLoader(
  hooks: NodeNextRequireHookSites,
  site: NodeJwtCompilerSite | undefined,
): NodeNextRequireHookSites {
  if (site?.kind !== 'loader') return hooks;
  return { ...hooks, operations: new Set([...hooks.operations, site.node]) };
}

function siteOf(kind: NodeJwtCompilerSite['kind'], node: Node | undefined) {
  return node === undefined ? undefined : Object.freeze({ kind, node });
}

export const NODE_JWT_COMPILER_PROFILES: readonly NodeJwtCompilerProfile[] = Object.freeze([
  Object.freeze({
    name: 'next-16.4.3-jsonwebtoken-ncc-v1',
    releases: Object.freeze(['16.4.3'] as const),
    suffix: '/dist/compiled/jsonwebtoken/index.js',
    sha256: '056c2dddba96faa35f4dc0740228a241990561290ff3bd5456c7c7dbc5a7a6b9',
    bytes: 121_051,
    builtins: Object.freeze(['buffer', 'crypto', 'stream', 'util']),
    semverSha256: '34c5853dd094229baa28a8b15b86e2143eeb0de0360530798ef3e9a7890942b6',
    site: (program: unknown) => siteOf('compiler', nodeJwtGlobalRecoverySite(program)),
  }),
  Object.freeze({
    name: 'next-16.4.4-fast-jwt-ncc-v1',
    releases: Object.freeze(['16.4.4', '16.4.5', '16.4.6'] as const),
    suffix: '/dist/compiled/fast-jwt/index.js',
    sha256: '8cc4cea3ed6b85a6771a2546bbb88dcd1ca21e6061d89057728d3da4ecccfabf',
    bytes: 131_737,
    builtins: Object.freeze(['buffer', 'node:crypto', 'node:util', 'util']),
    site: (program: unknown) => siteOf('loader', nodeFastJwtBindingSite(program)),
  }),
]);
