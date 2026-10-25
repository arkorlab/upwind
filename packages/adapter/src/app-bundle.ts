import type { InputOptions, Plugin as RolldownPlugin } from 'rolldown';

import { constExportSettersPlugin } from './const-export-setters.ts';
import type { KeptMaps } from './kept-maps.ts';
import { linkedImportsPlugin } from './linked-externals.ts';
import { manglePackagesPlugin } from './mangle-packages.ts';
import { otelChunksPlugin } from './otel-chunks.ts';
import { type PageRuntimeRequire, pageRuntimeReactPlugin } from './page-runtime-react.ts';
import {
  type AppliedPatch,
  externalsPlugin,
  type PatchContext,
  PATCHES,
  patchesPlugin,
  sharedRuntimePlugin,
  stubPlugin,
  styledJsxPlugin,
  vendoredOtelPlugin,
  wasmModulePlugin,
} from './patches/index.ts';
import { sourceMapsPlugin } from './source-maps.ts';
import { GLOBAL_OBJECT, globalObjectPlugin, THROWING_GLOBALS } from './throwing-globals.ts';
import type { WasmCollector } from './wasm.ts';

/** What the app bundle is built against: the rewrites it applies, and what it may resolve. */
export interface AppBundleContext {
  /** Analysis-only native markers; never present in a published Worker. */
  readonly nativeCapabilities?: RolldownPlugin | undefined;
  readonly patch: PatchContext;
  readonly wasm: WasmCollector;
  /** Compose the maps the build already wrote through into this bundle's own. */
  readonly sourceMaps?: boolean | undefined;
  /** Where to find a chunk's map that a hook took away (`kept-maps.ts`). */
  readonly keptMaps?: KeptMaps | undefined;
  /**
   * Whether this is the workflow Function: the one Function the Workflow SDK's engine is in, and the
   * one whose `node:vm` import is stubbed (`workflow.ts`). Anywhere else the audit refuses it.
   */
  readonly workflowFunction?: boolean | undefined;
  /** Whether a request may carry preview data this build signed (`StubOptions.previewData`). */
  readonly previewData?: boolean | undefined;
  /**
   * Where each require of Next.js's page runtime goes when the runtime is to be React alone — the
   * middleware's Function's, until what its chunks read of it says otherwise
   * (`page-runtime-react.ts`). Absent, the runtime is bundled as it is.
   */
  readonly pageRuntime?: PageRuntimeRequire[] | undefined;
}

/** What `bundleApp` collects as Rolldown runs, for the dependency record. */
export interface AppBundleSinks {
  readonly patches: AppliedPatch[];
  readonly stubs: string[];
  readonly externals: Set<string>;
  /** `.wasm` files the bundler resolved itself, as `<file> -> <global>`. */
  readonly wasm: string[];
  /** The names the chunks import packages linked under `.next/node_modules` by (`linked-externals.ts`). */
  readonly linked: Set<string>;
}

/**
 * Every plugin an app bundle is built with, named in one place.
 *
 * Each of these is the reason something that would otherwise fail the build or the Function does
 * not, or the reason the audit knows what it knows: a Next.js file rewritten, a module-loader
 * hook emptied, an optional package resolved to the copy Next.js ships, and the built-ins left
 * to the Function reported as they resolve. Dropping one is silent — the bundle still builds, and
 * what it broke shows up in a customer's build or in their running Function — so the set is
 * asserted by name. (The loads the bundler could not follow are read off what it rendered, not
 * collected as it runs: see `dynamicLoadsInChunk`.)
 */
export function appBundlePlugins(
  context: AppBundleContext,
  sinks: AppBundleSinks,
): RolldownPlugin[] {
  return [
    ...(context.nativeCapabilities === undefined ? [] : [context.nativeCapabilities]),
    globalObjectPlugin(),
    ...(context.pageRuntime === undefined ? [] : [pageRuntimeReactPlugin(context.pageRuntime)]),
    patchesPlugin(PATCHES, context.patch, (applied) => {
      sinks.patches.push(applied);
    }),
    // After the patches, so a file a patch rewrote is never given a map that no longer describes
    // it; see `sourceMapsPlugin`. Left out entirely for a build carrying no maps: it would read
    // the tail of every file the bundle loads for a comment nothing would use.
    ...(context.sourceMaps === true ? [sourceMapsPlugin(context.keptMaps)] : []),
    constExportSettersPlugin(),
    stubPlugin(
      (specifier) => {
        sinks.stubs.push(specifier);
      },
      {
        workflowFunction: context.workflowFunction === true,
        previewData: context.previewData !== false,
      },
    ),
    wasmModulePlugin(context.wasm, (file, global) => {
      sinks.wasm.push(`${file} -> ${global}`);
    }),
    otelChunksPlugin(context.patch.chunks),
    vendoredOtelPlugin(),
    sharedRuntimePlugin(),
    styledJsxPlugin(context.patch.projectDir),
    externalsPlugin((specifier) => sinks.externals.add(specifier)),
    linkedImportsPlugin((id) => sinks.linked.add(id)),
    // Last, so that every plugin above reads a module as it was written (`manglePackagesPlugin`).
    manglePackagesPlugin(context.patch.distDir),
  ];
}

/**
 * How the app Function's code is bundled: with the plugins above, and everything left to the
 * Function's own resolver reported — a module Rolldown cannot resolve, which it leaves to the
 * Function as it would a built-in, with a log, is recorded as an external too, for the audit to
 * refuse, which is what esbuild's refusal to build came to. Nothing else Rolldown has to say
 * reaches the build's output.
 */
export function appBundleOptions(
  projectDir: string,
  entryFile: string,
  context: AppBundleContext,
  sinks: AppBundleSinks,
): InputOptions {
  return {
    cwd: projectDir,
    input: entryFile,
    // Node built-ins, with or without the `node:` prefix, are the Function's own to resolve.
    platform: 'node',
    plugins: appBundlePlugins(context, sinks),
    transform: {
      inject: GLOBAL_OBJECT,
      define: {
        ...THROWING_GLOBALS,
        'process.env.NEXT_RUNTIME': '"nodejs"',
        'process.env.NODE_ENV': '"production"',
      },
    },
    onLog(_level, log) {
      if (log.code === 'UNRESOLVED_IMPORT' && log.exporter !== undefined) {
        sinks.externals.add(log.exporter);
      }
    },
  };
}
