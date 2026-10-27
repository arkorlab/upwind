import type { NodeNextCacheWriteProof } from './node-next-cache-write-proof.ts';
import type { NodeNextRequireHookProof } from './node-next-require-hook-proof.ts';
import type { NodeWsLoaderProof } from './node-ws-loader-proof.ts';

/** Module loader entrypoints and mutable resolution state cannot escape the original graph. */
export const NODE_MODULE_LOADERS = new Set([
  '_cache',
  '_compile',
  '_extensions',
  '_findPath',
  '_initPaths',
  '_load',
  '_nodeModulePaths',
  '_pathCache',
  '_readPackage',
  '_resolveFilename',
  '_resolveLookupPaths',
  '_stat',
  'constructor',
  'createRequire',
  'createRequireFromPath',
  'load',
  'Module',
  'prototype',
  'register',
  'registerHooks',
  'runMain',
  'wrap',
  'wrapper',
]);
export interface NodeClosureLoaders {
  readonly ws?: NodeWsLoaderProof | undefined;
  readonly nextRequireHook?: NodeNextRequireHookProof | undefined;
  readonly nextCacheWrite?: NodeNextCacheWriteProof | undefined;
}
