import {
  type Entrypoint,
  PRIMARY_FUNCTION,
  SPLIT_BUNDLE_VERSION,
} from '@stayingupwind/core/bundle';
import type { AdapterOutput } from 'next';

import type { BlobStore } from './blobs.ts';
import type { BuildContext, RouteCode, ShippedBlob } from './collect.ts';
import { auditFunctionSize } from './dependencies.ts';
import type { EdgeEntry } from './edge.ts';
import { buildFunction, type BuiltFunction, type EntryModule } from './function.ts';
import type { KeptMaps } from './kept-maps.ts';
import type { TextModule } from './manifests.ts';
import type { PatchContext } from './patches/index.ts';
import type { PlanBudget } from './plan.ts';
import { sameChunks } from './same-chunks.ts';
import { carriesMaps, type SourceMapsOption } from './source-maps.ts';
import {
  carriesBlob,
  everyFunction,
  overBudget,
  placedEntrypoints,
  placementsOf,
  planRecord,
  planSplit,
  routesOf,
  weighs,
} from './split.ts';
import { inlineAssetFiles, type TracedFile, tracedFiles } from './traced-files.ts';
import { collectWasm, type WasmChunk, type WasmCollector } from './wasm.ts';
import { offerEmbeddedWasm } from './workflow.ts';

/**
 * Building a deployment's Functions out of what the build collected: the app Function holding every
 * route, an app Function holding some of them, and the middleware's. (The Workflow SDK's own is
 * built from the same, in `workflow-function.ts`.)
 *
 * One way of building, whichever it is, so that a Function holding every route is built exactly as
 * it was before any could hold fewer: given no set of routes, every input below is the one the
 * build collected, in the order it was collected in.
 */

/** Where the middleware's code goes (`middlewarePlacement`), and what it reaches. */
export interface MiddlewareParts {
  readonly output: AdapterOutput['MIDDLEWARE'] | undefined;
  readonly node: readonly EntryModule[];
  readonly edge: readonly EdgeEntry[];
  readonly chunks: readonly string[];
  readonly wasm: readonly string[];
}

/** The instrumentation hook and what it reaches (`instrumentationOf`): every Function runs it. */
export interface HookParts {
  readonly file: string | undefined;
  readonly chunks: readonly string[];
  readonly wasm: readonly string[];
  readonly assets: Readonly<Record<string, string>>;
}

/** Everything a Function of this build is built from, whichever routes it holds. */
export interface FunctionsContext {
  readonly ctx: BuildContext;
  readonly outDir: string;
  readonly blobs: BlobStore;
  readonly cacheHostModule: string | undefined;
  readonly sourceMaps: SourceMapsOption;
  /** The maps that came through the build's `runAfterProductionCompile` (`kept-maps.ts`). */
  readonly keptMaps: KeptMaps | undefined;
  readonly manifests: readonly TextModule[];
  readonly hook: HookParts;
  readonly middleware: MiddlewareParts;
  /** What `collectEntrypoints` collected: the merged lists, and each route's own. */
  readonly modules: readonly EntryModule[];
  readonly chunks: readonly string[];
  readonly wasm: readonly string[];
  readonly edgeEntries: readonly EdgeEntry[];
  readonly routes: readonly RouteCode[];
  /** The prerendered bodies the Function carries, then the files it answers itself (`travelsWithFunction`). */
  readonly shipped: readonly ShippedBlob[];
  readonly staticBlobs: readonly { readonly sha256: string; readonly bytes: Uint8Array }[];
  /** What the entries read through `node:fs`, for the Function holding every route and the middleware's. */
  readonly files: {
    readonly app: readonly TracedFile[];
    readonly middleware: readonly TracedFile[];
  };
  /** Whether the build carries the Workflow SDK, which every one of its Functions is told. */
  readonly workflowSdk: boolean;
}

/**
 * Each Function's chunk table names only what its entries can reach: the table is what Rolldown
 * bundles, so the middleware Function stays small and an app Function carries no other's routes.
 * A chunk whose code another chunk of the table has is loaded from that one's file, so the code is
 * bundled once (`same-chunks.ts`). The WebAssembly a chunk of the table embeds in its own source is
 * offered to the Function's `wasm`, for the patch that takes it out to read it from there
 * (`offerEmbeddedWasm`).
 */
export async function patchFor(
  context: FunctionsContext,
  own: readonly string[],
  wasm: { readonly collector: WasmCollector; readonly chunks: readonly WasmChunk[] },
): Promise<PatchContext> {
  const table = new Set(own);
  for (const chunk of context.hook.chunks) {
    table.add(chunk);
  }
  const chunks = [...table];
  return {
    projectDir: context.ctx.projectDir,
    distDir: context.ctx.distDir,
    chunks,
    copies: await sameChunks(chunks, {
      carried: carriesMaps(context.sourceMaps),
      kept: context.keptMaps,
      ...(context.sourceMaps === 'project' && {
        project: {
          projectDir: context.ctx.projectDir,
          distDir: context.ctx.distDir,
          outDir: context.outDir,
        },
      }),
    }),
    instrumentation: context.hook.file,
    wasm: wasm.chunks,
    embeddedWasm: await offerEmbeddedWasm(chunks, wasm.collector),
  };
}

/** One app Function of a split: its name, and the routes it holds (`routesOf`). */
export interface HeldRoutes {
  readonly name: string;
  readonly routes: ReadonlySet<string>;
}

/** The runtime a route's code is built for, as `tracedFiles` asks it. */
function runtimeOf(route: RouteCode): 'edge' | 'nodejs' {
  return route.edge === undefined ? 'nodejs' : 'edge';
}

/**
 * Each blob once, the first of a digest kept: a file the Function answers itself can be a
 * prerendered body byte for byte, and one module name cannot be uploaded twice.
 */
function distinct<B extends { readonly sha256: string }>(blobs: readonly B[]): B[] {
  const seen = new Set<string>();
  const once: B[] = [];
  for (const blob of blobs) {
    if (!seen.has(blob.sha256)) {
      seen.add(blob.sha256);
      once.push(blob);
    }
  }
  return once;
}

/** What an app Function holding `held` — or every route — is made of. */
function partsOf(
  context: FunctionsContext,
  held: HeldRoutes | undefined,
): {
  modules: readonly EntryModule[];
  edge: readonly EdgeEntry[];
  chunks: readonly string[];
  wasm: readonly string[];
  blobs: readonly { readonly sha256: string; readonly bytes: Uint8Array }[];
  files: readonly TracedFile[];
} {
  if (held === undefined) {
    return {
      modules: context.modules,
      edge: context.edgeEntries,
      chunks: context.chunks,
      wasm: context.wasm,
      blobs: distinct([...context.shipped, ...context.staticBlobs]),
      files: context.files.app,
    };
  }
  const own = context.routes.filter((route) => held.routes.has(route.id));
  const known = new Set(context.routes.map((route) => route.id));
  const { output } = context.middleware;
  return {
    modules: own.flatMap((route) => (route.module === undefined ? [] : [route.module])),
    edge: own.flatMap((route) => (route.edge === undefined ? [] : [route.edge])),
    chunks: [...new Set(own.flatMap((route) => route.chunks))],
    wasm: [...new Set(own.flatMap((route) => route.wasm))],
    blobs: distinct([
      ...context.shipped.filter((blob) => carriesBlob(blob, held.routes, known)),
      ...context.staticBlobs,
    ]),
    files: tracedFiles(
      [
        ...own.map((route) => ({ runtime: runtimeOf(route), assets: route.assets })),
        ...(output === undefined ? [] : [output]),
        { assets: context.hook.assets },
      ],
      context.ctx.projectDir,
      context.ctx.distDir,
    ),
  };
}

/**
 * An app Function: every route's, or — for a build that split its routes — the ones `held` names,
 * with the middleware's code, which every app Function carries to run whenever the edge did not.
 */
export async function buildAppFunction(
  context: FunctionsContext,
  runtimeManifest: string,
  held: HeldRoutes | undefined,
  deferSizeAudit: boolean,
): Promise<BuiltFunction> {
  const { ctx, middleware, hook } = context;
  const parts = partsOf(context, held);
  const edgeEntries = [...parts.edge, ...middleware.edge];
  const wasm = await collectWasm(
    ctx.distDir,
    [...parts.wasm, ...middleware.wasm, ...hook.wasm],
    edgeEntries,
  );
  return buildFunction({
    kind: 'app',
    ...(held !== undefined && held.name !== PRIMARY_FUNCTION && { name: held.name }),
    projectDir: ctx.projectDir,
    outDir: context.outDir,
    patch: await patchFor(context, [...parts.chunks, ...middleware.chunks], wasm),
    entries: [...parts.modules, ...middleware.node],
    edgeEntries,
    wasm: wasm.collector,
    manifests: context.manifests,
    runtimeManifest,
    cacheHostModule: context.cacheHostModule,
    ...(carriesMaps(context.sourceMaps) && {
      sourceMaps: context.sourceMaps,
      keptMaps: context.keptMaps,
    }),
    blobs: parts.blobs,
    files: [...parts.files, ...inlineAssetFiles(edgeEntries, ctx.projectDir)],
    blobStore: context.blobs,
    deferSizeAudit,
    workflowSdk: context.workflowSdk,
  });
}

/**
 * The middleware's own Function, when the project has a middleware: what its path reads and nothing
 * more — `runtimeManifest` is the trimmed one (`middlewareManifest`), there is no build manifest,
 * which only a route module reads, and no cache, which nothing on that path reads or writes; the
 * cache handlers are installed in the app Functions alone.
 */
export async function buildMiddlewareFunction(
  context: FunctionsContext,
  runtimeManifest: string,
): Promise<BuiltFunction | undefined> {
  const { ctx, middleware, hook } = context;
  if (middleware.output === undefined) {
    return undefined;
  }
  const wasm = await collectWasm(ctx.distDir, [...middleware.wasm, ...hook.wasm], middleware.edge);
  return buildFunction({
    kind: 'middleware',
    projectDir: ctx.projectDir,
    outDir: context.outDir,
    patch: await patchFor(context, middleware.chunks, wasm),
    entries: middleware.node,
    edgeEntries: middleware.edge,
    wasm: wasm.collector,
    manifests: [],
    runtimeManifest,
    cacheHostModule: undefined,
    // Its own maps all the same: a middleware frame is only resolvable where they were built.
    ...(carriesMaps(context.sourceMaps) && {
      sourceMaps: context.sourceMaps,
      keptMaps: context.keptMaps,
    }),
    blobs: [],
    files: [...context.files.middleware, ...inlineAssetFiles(middleware.edge, ctx.projectDir)],
    blobStore: context.blobs,
    workflowSdk: context.workflowSdk,
  });
}

/** The app Functions a build made, by name, the first (`app`) first. */
export interface AppFunctions<M> {
  /** What every Function's `runtime.json` holds: the build's, with each route placed where split. */
  readonly runtimeManifest: M;
  readonly built: readonly { readonly name: string; readonly built: BuiltFunction }[];
  /** The plan, as the build's record keeps it, when the routes were split. */
  readonly plan: Record<string, unknown> | undefined;
}

/** A Function the build will upload as it is: held to Cloudflare's limit, which nothing raises. */
function finalSize(name: string, built: BuiltFunction): void {
  auditFunctionSize(name, { modules: built.spec.modules, size: built.dependencies.size });
}

/**
 * The application's app Functions: one, as it always was, unless the host splits (`budget`) and
 * that one is past the budgets — then as many as the plan makes, each with its own routes.
 *
 * The one Function is built first either way. Within the budgets it is the build; past them, what it
 * measured is what the plan is weighed with, and it is set aside for the Functions the plan makes.
 */
export async function appFunctionsOf<
  M extends { readonly v: number; readonly entrypoints: readonly Entrypoint[] },
>(
  context: FunctionsContext,
  runtimeManifest: M,
  budget: PlanBudget | undefined,
): Promise<AppFunctions<M>> {
  const single = await buildAppFunction(
    context,
    JSON.stringify(runtimeManifest),
    undefined,
    budget !== undefined,
  );
  const whole: AppFunctions<M> = {
    runtimeManifest,
    built: [{ name: PRIMARY_FUNCTION, built: single }],
    plan: undefined,
  };
  if (budget === undefined) {
    return whole;
  }
  if (!overBudget(single, budget)) {
    finalSize(PRIMARY_FUNCTION, single);
    return whole;
  }
  const { middleware, hook, ctx } = context;
  const every = everyFunction(ctx.config.basePath);
  const plan = await planSplit({
    routes: context.routes,
    shipped: context.shipped,
    staticDigests: new Set(context.staticBlobs.map((blob) => blob.sha256)),
    single,
    every,
    base: [
      ...(middleware.output === undefined
        ? []
        : [{ assets: middleware.output.assets, wasm: middleware.wasm, edge: middleware.edge[0] }]),
      { assets: hook.assets, wasm: hook.wasm },
    ],
    projectDir: ctx.projectDir,
    distDir: ctx.distDir,
    budget,
  });
  if (plan.length < 2) {
    console.warn(
      '@stayingupwind/adapter: this application is past the budgets for one Function, and its routes cannot be split any further: they stay in one',
    );
    finalSize(PRIMARY_FUNCTION, single);
    return whole;
  }
  const placements = placementsOf(plan);
  const split: M = {
    ...runtimeManifest,
    v: SPLIT_BUNDLE_VERSION,
    entrypoints: placedEntrypoints(runtimeManifest.entrypoints, placements),
  };
  const json = JSON.stringify(split);
  const built: { name: string; built: BuiltFunction }[] = [];
  for (const planned of plan) {
    const routes = routesOf(planned, context.routes, placements, every);
    built.push({
      name: planned.name,
      built: await buildAppFunction(context, json, { name: planned.name, routes }, false),
    });
  }
  return { runtimeManifest: split, built, plan: planRecord(plan, budget) };
}

const KIB = 1024;
const MIB = KIB * KIB;

function mib(bytes: number): string {
  return `${(bytes / MIB).toFixed(1)} MiB`;
}

/** Said once a split build is written: which Functions, and what each came to. */
export function reportSplit(built: AppFunctions<unknown>['built']): void {
  if (built.length < 2) {
    return;
  }
  const each = built.map(({ name, built: one }) => {
    const { bytes, codeBytes } = weighs(one);
    return `${name} (${mib(bytes)}, ${mib(codeBytes)} of code)`;
  });
  console.log(
    `@stayingupwind/adapter: the routes are split across ${String(built.length)} app Functions: ${each.join(', ')}`,
  );
}
