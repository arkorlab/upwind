import { cacheHandlersPatch } from './cache-handlers.ts';
import { cacheSignalTimersPatch } from './cache-signal-timers.ts';
import { fastImmediatesPatch } from './fast-immediates.ts';
import { fetchCacheWaitUntilPatch } from './fetch-cache-wait-until.ts';
import { graphManifestsPatch } from './graph-manifests.ts';
import { hangingInputAbortPatch } from './hanging-input-abort.ts';
import { instrumentationPatch } from './instrumentation.ts';
import { lazySourceMapPatch } from './lazy-source-map.ts';
import { loadManifestPatch } from './load-manifest.ts';
import { resourceCacheBridgePatch } from './resource-cache-bridge.ts';
import { resumeCacheLimitPatch } from './resume-cache-limit.ts';
import { taskTimersPatch } from './task-timers.ts';
import { turbopackRootPatch } from './turbopack-root.ts';
import { turbopackRuntimePatch } from './turbopack-runtime.ts';
import type { Patch } from './types.ts';
import { vercelOgFontPatch, vercelOgImageResponsePatch, vercelOgPatch } from './vercel-og.ts';
import { runtimeWasmLoaderPatch, wasmLoaderPatch } from './wasm-loader.ts';
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

export { OG_FONT_FILE, OG_FONT_MODULE } from './vercel-og.ts';
