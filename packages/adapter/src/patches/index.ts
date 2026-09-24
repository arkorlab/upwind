import { cacheSignalTimersPatch } from './cache-signal-timers.ts';
import { graphManifestsPatch } from './graph-manifests.ts';
import { instrumentationPatch } from './instrumentation.ts';
import { loadManifestPatch } from './load-manifest.ts';
import { resumeCacheLimitPatch } from './resume-cache-limit.ts';
import { taskTimersPatch } from './task-timers.ts';
import { turbopackRuntimePatch } from './turbopack-runtime.ts';
import type { Patch } from './types.ts';
import { vercelOgFontPatch, vercelOgPatch } from './vercel-og.ts';
import { wasmLoaderPatch } from './wasm-loader.ts';

export { WORKER_BANNER } from './banner.ts';
export {
  type AppliedPatch,
  externalsPlugin,
  patchesPlugin,
  stubPlugin,
  vendoredOtelPlugin,
  wasmModulePlugin,
} from './rolldown.ts';
export type { PatchContext } from './types.ts';

/** Every rewrite of Next.js's output the Worker build applies. */
export const PATCHES: readonly Patch[] = [
  turbopackRuntimePatch,
  wasmLoaderPatch,
  vercelOgPatch,
  vercelOgFontPatch,
  cacheSignalTimersPatch,
  instrumentationPatch,
  loadManifestPatch,
  resumeCacheLimitPatch,
  taskTimersPatch,
  graphManifestsPatch,
];

export { OG_FONT_FILE, OG_FONT_MODULE } from './vercel-og.ts';
