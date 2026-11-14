import path from 'node:path';

import { cacheHandlersPatch } from './cache-handlers.ts';
import { cacheSignalTimersPatch } from './cache-signal-timers.ts';
import { externalPagesApiDistPatch } from './external-pages-api-dist.ts';
import { fastImmediatesPatch } from './fast-immediates.ts';
import { fetchCacheWaitUntilPatch } from './fetch-cache-wait-until.ts';
import { graphManifestsPatch } from './graph-manifests.ts';
import { hangingInputAbortPatch } from './hanging-input-abort.ts';
import { instrumentationPatch } from './instrumentation.ts';
import { lazySourceMapPatch } from './lazy-source-map.ts';
import { loadManifestPatch } from './load-manifest.ts';
import { resourceCacheBridgePatch } from './resource-cache-bridge.ts';
import { resumeCacheLimitPatch } from './resume-cache-limit.ts';
import { patchSource } from './rolldown.ts';
import { taskTimersPatch } from './task-timers.ts';
import { turbopackRootPatch } from './turbopack-root.ts';
import { turbopackRuntimePatch } from './turbopack-runtime.ts';
import type { Patch, PatchContext } from './types.ts';
import { useCacheCrossRequestPatch } from './use-cache-cross-request.ts';
import { vercelOgFontPatch, vercelOgImageResponsePatch, vercelOgPatch } from './vercel-og.ts';
import { runtimeWasmLoaderPatch, wasmLoaderPatch } from './wasm-loader.ts';
import { webSocketResponsePatch } from './websocket-response.ts';
import { workflowQuickjsWasmPatch } from './workflow-quickjs.ts';

export { FUNCTION_BANNER } from './banner.ts';
export {
  type AppliedPatch,
  externalsPlugin,
  patchesPlugin,
  stubPlugin,
  sharedRuntimePlugin,
  styledJsxPlugin,
  vendoredOtelPlugin,
  wasmModulePlugin,
} from './rolldown.ts';
export type { Copy, Patch, PatchContext } from './types.ts';

/** Every rewrite of Next.js's output the Function build applies. */
export const PATCHES: readonly Patch[] = [
  webSocketResponsePatch,
  externalPagesApiDistPatch,
  turbopackRuntimePatch,
  turbopackRootPatch,
  wasmLoaderPatch,
  runtimeWasmLoaderPatch,
  vercelOgPatch,
  vercelOgImageResponsePatch,
  vercelOgFontPatch,
  cacheSignalTimersPatch,
  fetchCacheWaitUntilPatch,
  hangingInputAbortPatch,
  useCacheCrossRequestPatch,
  instrumentationPatch,
  cacheHandlersPatch,
  loadManifestPatch,
  resumeCacheLimitPatch,
  resourceCacheBridgePatch,
  taskTimersPatch,
  fastImmediatesPatch,
  graphManifestsPatch,
  lazySourceMapPatch,
  workflowQuickjsWasmPatch,
];

/** These rewrites of server chunks depend only on the source, not on the copy table or bindings. */
const CONTEXT_FREE_CHUNK_PATCHES: ReadonlySet<Patch> = new Set([
  graphManifestsPatch,
  hangingInputAbortPatch,
]);

/**
 * What the actual patch loader will return for a chunk claimed only by context-free rewrites.
 * A claimed file never reaches the later source-map loader, so its original map is not carried.
 * Any additional claim keeps map comparison strict; an invalid rewrite still fails the build.
 */
export function rewrittenChunk(
  source: string,
  file: string,
  ctx: PatchContext,
): string | undefined {
  // Rolldown presents forward-slash ids to the actual loader on every platform.
  return patchSource(PATCHES, ctx, {
    source,
    file: file.split(path.sep).join('/'),
    only: CONTEXT_FREE_CHUNK_PATCHES,
  });
}

export { OG_FONT_FILE, OG_FONT_MODULE } from './vercel-og.ts';
