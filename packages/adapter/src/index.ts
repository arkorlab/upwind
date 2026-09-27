import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  BUNDLE_VERSION,
  type DeploymentBundle,
  deploymentBundleSchema,
  travelsWithFunction,
} from '@stayingupwind/core/bundle';
import { UPWIND_LOCAL_RESOURCES_ENV } from '@stayingupwind/core/paas';
import type { AdapterOutput, NextAdapter } from 'next';

import { BlobStore } from './blobs.ts';
import { bundleConfig, customCacheHandlerPaths } from './bundle-config.ts';
import {
  type BuildContext,
  bypassTokenOf,
  collectEntrypoints,
  collectPrerenders,
  collectStaticFiles,
  deploymentId,
  edgeEntryOf,
  exists,
  imagesConfig,
  isStaticExport,
  middlewareMatchers,
  middlewareOutput,
  nftAssets,
  nftChunks,
  nftWasm,
  tracedChunks,
  tracedWasm,
} from './collect.ts';
import { reserveUpwindPrefix } from './dev-prefix.ts';
import type { EdgeEntry } from './edge.ts';
import { buildFunction, type EntryModule } from './function.ts';
import { collectManifests } from './manifests.ts';
import type { PatchContext } from './patches/index.ts';
import { readProjectConfig } from './project-config.ts';
import { inlineAssetFiles, type TracedFile, tracedFiles } from './traced-files.ts';
import { arkorWasmGlobal, WasmCollector, type WasmChunk, wasmChunks } from './wasm.ts';

/**
 * The ppr-cdn deployment adapter.
 *
 * `next build` calls `onBuildComplete` with a typed description of the application; this turns it
 * into a deployment bundle under `<projectDir>/.ppr-cdn/`: a `bundle.json` naming every route,
 * prerender and static file by content, the blobs themselves, and the Function modules that run the
 * application's code. Nothing here talks to Cloudflare — uploading is the host's job,
 * so a build needs no credentials and can run anywhere `next build` runs.
 *
 * A static export (`output: 'export'`) is the same bundle with the server parts empty: no
 * entrypoint, no prerender, no middleware, and every document among the static files, named where
 * a static host would serve it. The Function is still built, with no route to run, so that what is
 * not a file — a miss, a redirect from `next.config`, the trailing-slash normalization — is
 * answered by Next.js's own router rather than by a rule reinvented here.
 */

export const OUT_DIR_NAME = '.ppr-cdn';
export const BUNDLE_FILE = 'bundle.json';
/** What went into each Function, and what was done to it: for a diff, not for the platform. */
const DEPENDENCIES_FILE = 'dependencies.json';
const MIDDLEWARE_ENTRY_ID = '/_middleware';

/**
 * A custom cache handler is refused when the config is loaded for a build (before anything is
 * compiled) and again at the end, since a standalone config skips `modifyConfig`. The Function
 * cannot load a module by path, and the platform installs its own ISR and `use cache` handlers.
 * Neither refusal is made of a static export, whose Function runs none of the application's code:
 * nothing there loads the module, and no handler of the platform's is there to conflict with it.
 */
function refuseCustomCacheHandlers(config: BuildContext['config']): void {
  const customHandlers = customCacheHandlerPaths(config);
  if (customHandlers.length > 0) {
    throw new Error(
      `@stayingupwind/adapter: a custom cacheHandler / cacheHandlers module cannot run on this platform's Function (${customHandlers.join(', ')}); remove it — the platform provides the ISR and "use cache" handlers itself`,
    );
  }
}

/**
 * The instrumentation hook and what it reaches, for a build that has one to run.
 *
 * A static export is not asked: the hook runs before an entrypoint, and such a build has none —
 * nothing of the application's code travels, so there is nothing for it to run before.
 */
async function instrumentationOf(
  distDir: string,
  exported: boolean,
): Promise<{
  readonly file: string | undefined;
  readonly chunks: readonly string[];
  readonly wasm: readonly string[];
  readonly assets: Readonly<Record<string, string>>;
}> {
  const file = path.join(distDir, 'server', 'instrumentation.js');
  if (exported || !(await exists(file))) {
    return { file: undefined, chunks: [], wasm: [], assets: {} };
  }
  // All of these go into both Functions: the hook runs before any entrypoint, in each of them.
  return {
    file,
    chunks: await nftChunks(file),
    wasm: await nftWasm(file),
    assets: await nftAssets(file),
  };
}

/**
 * What the Node.js entries read through `node:fs`, for each Function to carry what its own entries
 * read: the app Function carries the middleware as well, and both carry what the instrumentation
 * hook reads, since it runs before any entrypoint in each of them (`instrumentationOf`). A static
 * export runs none of the application's code, and reads nothing.
 */
function filesRead(
  ctx: BuildContext,
  middleware: AdapterOutput['MIDDLEWARE'] | undefined,
  hookAssets: Readonly<Record<string, string>>,
  exported: boolean,
): { readonly app: readonly TracedFile[]; readonly middleware: readonly TracedFile[] } {
  const own = middleware === undefined ? [] : [middleware];
  const hook = [{ assets: hookAssets }];
  const { appPages, appRoutes, pages, pagesApi } = ctx.outputs;
  return {
    app: exported
      ? []
      : tracedFiles(
          [...appPages, ...appRoutes, ...pages, ...pagesApi, ...own, ...hook],
          ctx.projectDir,
          ctx.distDir,
        ),
    middleware: tracedFiles([...own, ...hook], ctx.projectDir, ctx.distDir),
  };
}

async function onBuildComplete(ctx: BuildContext, options: AdapterOptions): Promise<void> {
  const exported = isStaticExport(ctx.config);
  // A custom handler is refused because the platform runs its own in the Function and two cannot
  // both be the cache. A static export has no handler at all — nothing loads the module, and
  // there is nothing for it to conflict with — so the option is unused there rather than unsupported.
  if (!exported) {
    refuseCustomCacheHandlers(ctx.config);
  }
  // Read before anything is written: a cron this platform cannot run fails the build here, where
  // the message is about the file the author wrote, rather than at the upload or never.
  const projectConfig = await readProjectConfig(ctx.projectDir, options.hostConfigFiles);
  const outDir = path.join(ctx.projectDir, OUT_DIR_NAME);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const blobs = new BlobStore(outDir);
  await blobs.init();

  // Which bundler built the server is only of interest where the Function carries the server's
  // code; a static export carries none, so the check that would refuse a webpack build is the
  // wrong question to ask of one.
  const runtimeChunk = path.join(ctx.distDir, 'server', 'chunks', 'ssr', '[turbopack]_runtime.js');
  if (!exported && !(await exists(runtimeChunk))) {
    throw new Error(
      '@stayingupwind/adapter: only Turbopack builds are supported (no server runtime chunk found)',
    );
  }
  const instrumentation = await instrumentationOf(ctx.distDir, exported);
  const id = deploymentId();
  // Next.js's build manifests are what its route modules read at request time. A static export
  // has no route module in the Function, so nothing would ever read one: shipping them would be
  // bytes in a Function that never opens them.
  const manifests = exported ? [] : await collectManifests(ctx.projectDir, ctx.distDir, id);
  const {
    entrypoints,
    sourcePages,
    modules,
    chunks,
    wasm: nodeWasm,
    edgeEntries,
  } = collectEntrypoints(ctx.outputs);
  const { prerenders, shipped } = await collectPrerenders(ctx.outputs, blobs, ctx.config.basePath);
  const staticFiles = await collectStaticFiles(ctx, blobs);
  const middleware = middlewareOutput(ctx.outputs);
  const {
    node: nodeMiddleware,
    edge: middlewareEdgeEntries,
    chunks: middlewareChunks,
    wasm: middlewareWasm,
  } = middlewarePlacement(middleware);
  const files = filesRead(ctx, middleware, instrumentation.assets, exported);
  // Each Function's chunk table names only what its entries can reach: the table is what Rolldown
  // bundles, so the middleware Function stays small and the app Function carries no middleware.
  const patchFor = (own: readonly string[], wasm: readonly WasmChunk[]): PatchContext => {
    const table = new Set(own);
    for (const chunk of instrumentation.chunks) {
      table.add(chunk);
    }
    return {
      distDir: ctx.distDir,
      chunks: [...table],
      instrumentation: instrumentation.file,
      wasm,
    };
  };

  // The edge serves every file from storage; the Function carries only what it answers itself —
  // the error documents, and small files outside `_next/static` (robots.txt, `public/`) a
  // middleware may rewrite to. Anything larger stays with the edge alone: a Function has a size
  // limit, and a public asset need not count against it.
  const shippedStatic = staticFiles.filter((file) =>
    travelsWithFunction(file, ctx.config.basePath, exported),
  );
  const shippedBlobs = new Map(shipped.map((blob) => [blob.sha256, blob]));
  for (const file of shippedStatic) {
    if (shippedBlobs.has(file.blob.sha256)) {
      continue;
    }

    const bytes = await readFile(path.join(outDir, 'blobs', file.blob.sha256));
    shippedBlobs.set(file.blob.sha256, { sha256: file.blob.sha256, bytes: new Uint8Array(bytes) });
  }

  const bypassToken = bypassTokenOf(ctx.outputs);
  const runtimeManifest = {
    v: BUNDLE_VERSION,
    deploymentId: id,
    nextVersion: ctx.nextVersion,
    buildId: ctx.buildId,
    config: bundleConfig(ctx.config, await imagesConfig(ctx)),
    routing: ctx.routing,
    ...(bypassToken !== undefined && { bypassToken }),
    entrypoints,
    ...(middleware !== undefined && { middleware: { matchers: middlewareMatchers(middleware) } }),
    prerenders,
    staticFiles: shippedStatic,
  };
  const runtimeManifestJson = JSON.stringify(runtimeManifest);

  const appWasm = await collectWasm(
    ctx.distDir,
    [...nodeWasm, ...middlewareWasm, ...instrumentation.wasm],
    [...edgeEntries, ...middlewareEdgeEntries],
  );
  const app = await buildFunction({
    kind: 'app',
    projectDir: ctx.projectDir,
    outDir,
    patch: patchFor([...chunks, ...middlewareChunks], appWasm.chunks),
    entries: [...modules, ...nodeMiddleware],
    edgeEntries: [...edgeEntries, ...middlewareEdgeEntries],
    wasm: appWasm.collector,
    manifests,
    runtimeManifest: runtimeManifestJson,
    cacheHostModule: options.cacheHostModule,
    blobs: [...shippedBlobs.values()],
    files: [
      ...files.app,
      ...inlineAssetFiles([...edgeEntries, ...middlewareEdgeEntries], ctx.projectDir),
    ],
    blobStore: blobs,
  });
  let middlewareFunction;
  if (middleware !== undefined) {
    const wasm = await collectWasm(
      ctx.distDir,
      [...middlewareWasm, ...instrumentation.wasm],
      middlewareEdgeEntries,
    );
    middlewareFunction = await buildFunction({
      kind: 'middleware',
      projectDir: ctx.projectDir,
      outDir,
      patch: patchFor(middlewareChunks, wasm.chunks),
      entries: nodeMiddleware,
      edgeEntries: middlewareEdgeEntries,
      wasm: wasm.collector,
      manifests,
      runtimeManifest: runtimeManifestJson,
      cacheHostModule: options.cacheHostModule,
      blobs: [],
      files: [...files.middleware, ...inlineAssetFiles(middlewareEdgeEntries, ctx.projectDir)],
      blobStore: blobs,
    });
  }

  // Two things the bundle carries and `runtimeManifest` does not, for the same reason: nothing in
  // the Function reads either, and every byte of its manifest is parsed before its first response.
  const bundle: DeploymentBundle = deploymentBundleSchema.parse({
    ...runtimeManifest,
    // Where each entrypoint's code is in the source tree. Only a reader of the build ever asks
    // (`sourcePageSchema`).
    sourcePages,
    // The cron jobs the project declared: the host schedules them, and the Function they reach
    // answers the request they make like any other.
    ...(projectConfig.crons.length > 0 && { crons: projectConfig.crons }),
    projectDir: path.relative(ctx.repoRoot, ctx.projectDir).split(path.sep).join('/'),
    generatedAt: new Date().toISOString(),
    staticFiles,
    functions: {
      app: app.spec,
      ...(middlewareFunction !== undefined && { middleware: middlewareFunction.spec }),
    },
  });
  await writeFile(path.join(outDir, BUNDLE_FILE), JSON.stringify(bundle, null, 2));
  const dependencies = {
    app: app.dependencies,
    ...(middlewareFunction !== undefined && { middleware: middlewareFunction.dependencies }),
  };
  await writeFile(path.join(outDir, DEPENDENCIES_FILE), JSON.stringify(dependencies, null, 2));
  await rm(path.join(outDir, 'work'), { recursive: true, force: true });
  console.log(
    `@stayingupwind/adapter: wrote ${OUT_DIR_NAME}/${BUNDLE_FILE} (${bundle.prerenders.length} prerenders, ${bundle.staticFiles.length} static files, ${blobs.count} blobs)`,
  );
  if (edgeEntries.length > 0) {
    // A hint, for whoever reads the build: a page on the edge runtime renders with no postponed
    // state, so nothing of it can be served ahead of its render the way a Node.js page's shell is.
    const ids = edgeEntries.map((entry) => entry.id).join(', ');
    console.warn(
      `@stayingupwind/adapter: on the deprecated edge runtime: ${ids}. Their code travels in the Function's own edge bundle, and a page among them is answered in full — the edge serves no shell ahead of a route that cannot resume one.`,
    );
  }
}

/**
 * Is `file` a file `next build` itself wrote, rather than one a trace found in a package?
 *
 * `..` has to be a segment of its own to mean "above": a sibling directory named `..next` is a
 * path that starts with `..` and is not outside anything.
 */
function inside(dir: string, file: string): boolean {
  const relative = path.relative(dir, file);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/**
 * The WebAssembly one Function carries, and what Turbopack's Node.js loader asks for it under.
 *
 * Two sources, because Next.js describes the two runtimes differently. An entrypoint on the edge
 * runtime has `wasmAssets`, keyed by the global its chunks read the module from. An entrypoint on
 * the Node.js runtime has nothing: its WebAssembly is a `.wasm` among the traced `assets`, and
 * the loader Turbopack bundled reads it off disk by a path relative to `distDir` — which is what
 * the table here names, for the `wasm-loader` patch to switch on. A `.wasm` a trace found outside
 * `distDir` is not one `next build` emitted for that loader (`@vercel/og`'s two are the case in
 * point); it is reached by a `?module` import the app bundler resolves, and needs no table entry,
 * only a module and a name.
 */
async function collectWasm(
  distDir: string,
  nodeFiles: readonly string[],
  edgeEntries: readonly EdgeEntry[],
): Promise<{ collector: WasmCollector; chunks: WasmChunk[] }> {
  const collector = new WasmCollector();
  // By file, because a `.wasm` a route and the middleware both reach arrives twice: two lists,
  // each without repeats of its own. A table with the same path in it twice would say the Function
  // carries more than it does, and would put a dead `case` in the code the patch generates.
  const emitted = new Map<string, { filePath: string; sha256: string }>();
  for (const filePath of nodeFiles) {
    const sha256 = await collector.offer(filePath);
    if (inside(distDir, filePath)) {
      collector.publish(sha256, arkorWasmGlobal(sha256));
      emitted.set(path.resolve(filePath), { filePath, sha256 });
    }
  }
  for (const entry of edgeEntries) {
    for (const asset of entry.wasm) {
      collector.publish(await collector.offer(asset.filePath), asset.global);
    }
  }
  return { collector, chunks: wasmChunks(distDir, [...emitted.values()]) };
}

/**
 * Which of a Function's two bundles the middleware goes into, and the chunks the Node.js one needs.
 *
 * `proxy.ts` is a module the Function requires; the deprecated `middleware.ts` is built for the edge
 * runtime and is loaded as every other edge entrypoint is. Both export the same Web handler, so
 * this is the whole of the difference.
 */
function middlewarePlacement(middleware: AdapterOutput['MIDDLEWARE'] | undefined): {
  node: EntryModule[];
  edge: EdgeEntry[];
  chunks: string[];
  wasm: string[];
} {
  if (middleware === undefined) {
    return { node: [], edge: [], chunks: [], wasm: [] };
  }
  if (middleware.runtime === 'edge') {
    return {
      node: [],
      edge: [edgeEntryOf(middleware, MIDDLEWARE_ENTRY_ID)],
      chunks: [],
      wasm: [],
    };
  }
  return {
    node: [{ id: MIDDLEWARE_ENTRY_ID, filePath: middleware.filePath }],
    edge: [],
    chunks: tracedChunks(middleware.assets),
    wasm: tracedWasm(middleware.assets),
  };
}

/** What a host configures the adapter with; a build given none produces a bundle with no cache. */
export interface AdapterOptions {
  /**
   * The module the runtime's cache reads and writes through, as an absolute path — what
   * `ppr-cdn:cache-host` resolves to, bundled into the Function's runtime.
   *
   * Left out, the runtime is given no cache and answers every read a miss: a bundle that is
   * correct, serves what the build produced, and revalidates nothing. A host that stores
   * generations names its own module here.
   */
  readonly cacheHostModule?: string | undefined;
  /**
   * Names the host reads a project's configuration under besides this adapter's own, for a host
   * that once called that file something else. Looked for after `upwind.*` and before
   * `vercel.json` (`configFileOrder`); a build that simply stopped looking would read an empty
   * configuration from a project that wrote one, and take the crons it declared as withdrawn.
   */
  readonly hostConfigFiles?: readonly string[] | undefined;
}

/**
 * The adapter, as a host configures it.
 *
 * `NEXT_ADAPTER_PATH` and `adapterPath` both name a module whose default export is a
 * `NextAdapter`, so a host that needs no options points either at this module and takes the
 * default export below. One that does — a cache host of its own — exports an adapter of its own
 * from a module of two lines.
 */
/** The config `modifyConfig` is handed, as Next.js declares it. */
type BuildConfig = Parameters<NonNullable<NextAdapter['modifyConfig']>>[0];

/**
 * Next.js's own default for `experimental.cpus`, which is always set by the time a config is handed
 * over — so "the project chose this" means "not this".
 *
 * The same expression `defaultConfig` uses (`server/config-shared`), and the same test Next.js
 * makes of it when it decides whether a count is a user override (`getNumberOfWorkers` in
 * `build/index`). Read from a copy of Next.js rather than computed here it would be an import into
 * internals; computed here it is one line that is wrong only if Next.js changes the default, and
 * then the worst of it is a build that leaves the count alone.
 */
function defaultCpus(): number {
  return Math.max(1, (Number(process.env['CIRCLE_NODE_TOTAL']) || os.cpus().length) - 1);
}

/**
 * Render this build's pages in one process, because its storage can only be in one.
 *
 * Only for a build that has local storage in it, which is `upwind build` and nothing else
 * (`UPWIND_LOCAL_RESOURCES_ENV` says why one process). It is a real cost — page data is collected
 * by one worker rather than several — so it is said out loud rather than done quietly, and a
 * project that has asked for a worker count of its own keeps it: whoever wrote that line knows
 * something this does not, and a build that overrode it would only be a build that hangs.
 */
/**
 * That this has been said already, where the next process to say it can see.
 *
 * A build loads its config more than once and in more than one process, and this is a line worth
 * reading exactly once. The environment is what those processes share.
 */
const SAID_ENV = 'UPWIND_LOCAL_RESOURCES_SAID';

function renderInOneProcessForStorage(config: BuildConfig): void {
  const chosen = config.experimental.cpus;
  if (
    process.env[UPWIND_LOCAL_RESOURCES_ENV] !== '1' ||
    (chosen !== undefined && chosen !== defaultCpus())
  ) {
    return;
  }
  config.experimental.cpus = 1;
  if (process.env[SAID_ENV] === '1') {
    return;
  }
  process.env[SAID_ENV] = '1';
  console.log(
    "@stayingupwind/adapter: this build has the project's local storage in it, so its pages are rendered in one process. Set `experimental.cpus` yourself to decide otherwise — a page that reads storage while it prerenders then fails in every process but one.",
  );
}

export function createAdapter(options: AdapterOptions = {}): NextAdapter {
  return {
    name: 'ppr-cdn',
    modifyConfig(config, { phase }) {
      if (phase === 'phase-development-server') {
        // `/__upwind` belongs to `upwind dev`, which is in front of this server. See `dev-prefix.ts`
        // for why a front door that already holds the path still wants the reservation, and why
        // this does nothing when no such server is there. Assigned only when there is something to
        // assign: a project that declares no rewrites must keep declaring none.
        const reserved = reserveUpwindPrefix({
          rewrites: config.rewrites,
          basePath: config.basePath,
          i18n: config.i18n,
        });
        if (reserved !== undefined) {
          config.rewrites = reserved;
        }
      } else if (phase === 'phase-production-build') {
        // The same exception `onBuildComplete` makes, made here too, since this runs first and
        // would otherwise stop a static export before the build that has nothing to load the
        // module.
        if (!isStaticExport(config)) {
          refuseCustomCacheHandlers(config);
        }
        // Content-addressed `/_next/static/immutable/*`: shared across deployments, cached
        // forever. Asked for unconditionally, and refused for a static export by Next.js itself,
        // which turns the option off in `finalizeConfig` after this hook has run; such a build's
        // assets are recognized from the build's own `onMatch` rule instead (see
        // `immutableByBuild`).
        config.supportsImmutableAssets = true;
        renderInOneProcessForStorage(config);
      }
      return config;
    },
    onBuildComplete: (ctx) => onBuildComplete(ctx, options),
  };
}

// `NEXT_ADAPTER_PATH` and `adapterPath` name a module whose default export is the adapter; this
// one is configured with nothing, and its bundle has no runtime cache.
// eslint-disable-next-line import-x/no-default-export
export default createAdapter();
