import { cacheSignalTimersPatch } from './cache-signal-timers.ts';
import { fetchCacheWaitUntilPatch } from './fetch-cache-wait-until.ts';
import { graphManifestsPatch } from './graph-manifests.ts';
import { hangingInputAbortPatch } from './hanging-input-abort.ts';
import { instrumentationPatch } from './instrumentation.ts';
import { loadManifestPatch } from './load-manifest.ts';
import { resumeCacheLimitPatch } from './resume-cache-limit.ts';
import { taskTimersPatch } from './task-timers.ts';
import { turbopackRuntimePatch } from './turbopack-runtime.ts';
import type { Patch } from './types.ts';
import { vercelOgFontPatch, vercelOgImageResponsePatch, vercelOgPatch } from './vercel-og.ts';
import { wasmLoaderPatch } from './wasm-loader.ts';

export { FUNCTION_BANNER } from './banner.ts';
export {
  type AppliedPatch,
  externalsPlugin,
  patchesPlugin,
  stubPlugin,
  vendoredOtelPlugin,
  wasmModulePlugin,
} from './rolldown.ts';
export type { PatchContext } from './types.ts';

/** Every rewrite of Next.js's output the Function build applies. */
export const PATCHES: readonly Patch[] = [
  turbopackRuntimePatch,
  wasmLoaderPatch,
  vercelOgPatch,
  vercelOgImageResponsePatch,
  vercelOgFontPatch,
  cacheSignalTimersPatch,
  fetchCacheWaitUntilPatch,
  hangingInputAbortPatch,
  instrumentationPatch,
  loadManifestPatch,
  resumeCacheLimitPatch,
  taskTimersPatch,
  graphManifestsPatch,
];

export { OG_FONT_FILE, OG_FONT_MODULE } from './vercel-og.ts';
