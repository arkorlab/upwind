import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  bundleBlobs,
  type DeploymentBundle,
  type DurableObjectDeclaration,
  type CloudflareWorkflowDeclaration,
  deploymentBundleSchema,
  isNodeContainerFunction,
  ONE_PASS_BUNDLE_VERSION,
  travelsWithFunction,
} from '@stayingupwind/core/bundle';
import { STATIC_PAGES_FALLBACK_PRIVACY } from '@stayingupwind/core/cache';
import { SECURITY_RELEASE_URL, securityFloorOf } from '@stayingupwind/core/next';
import type { AdapterOutput, NextAdapter } from 'next';

import {
  type AppFunctions,
  appFunctionsOf,
  buildMiddlewareFunction,
  type FunctionsContext,
  reportSplit,
} from './app-functions.ts';
import { BlobStore } from './blobs.ts';
import {
  type BuildConfig,
  configureBuildSourceMaps,
  renderInOneProcessForStorage,
} from './build-config.ts';
import { assertBuildPaths } from './build-paths.ts';
import { bundleConfig } from './bundle-config.ts';
import { cacheHandlersModule } from './cache-handlers.ts';
import {
  type BuildContext,
  bundleRouting,
  bypassTokenOf,
  collectEntrypoints,
  deploymentId,
  edgeEntryOf,
  imagesConfig,
  isStaticExport,
  middlewareMatchers,
  middlewareOutput,
  tracedChunks,
  tracedWasm,
} from './collect.ts';
import { reserveUpwindPrefix } from './dev-prefix.ts';
import {
  checkedEdgeInstrumentationModules,
  edgeInstrumentationOf,
} from './edge-instrumentation.ts';
import type { EdgeEntry } from './edge.ts';
import { ensureStaticRoutes } from './ensure-static.ts';
import { environmentOptions } from './environment-options.ts';
import { exists } from './fs.ts';
import { dependencyRecord } from './function-report.ts';
import { type BuiltFunction, type EntryModule, middlewareManifest } from './function.ts';
import { declaredGates } from './gates.ts';
import { instrumentationOf, writeClientInstrumentation } from './instrumentation.ts';
import { readKeptMaps } from './kept-maps.ts';
import { collectManifests } from './manifests.ts';
import { publishNativeBuildTarget, runtimeTargetOf, type RuntimeTarget } from './native/target.ts';
import { checkPageBodyHost, type UnshippedPrerenderBodies } from './page-bodies.ts';
import { collectPageBodies } from './page-body-layout.ts';
import { readProjectConfig } from './project-config.ts';
import { projectDirOf } from './project-dir.ts';
import { carriesMaps, type SourceMapsOption } from './source-maps.ts';
import { buildSplitBudget, checkSplitOptions, type SplitOptions } from './split.ts';
import { collectStaticFiles, rewriteTargetFiles } from './static-files.ts';
import { staticPagesRuntimeFields } from './static-pages.ts';
import { type TracedFile, tracedFiles } from './traced-files.ts';
import { workerClassParts } from './worker-class-functions.ts';
import {
  buildWorkflowFunction,
  warnOfNoWorld,
  type WorkflowBuild,
  workflowBuildOf,
  workflowPartsOf,
} from './workflow-function.ts';
import { aliasBuiltinWorlds } from './workflow.ts';

/**
 * The upwind deployment adapter.
 *
 * `next build` calls `onBuildComplete` with a typed description of the application; this turns it
 * into a deployment bundle under `<projectDir>/.arkor/`: a `bundle.json` naming every route,
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

export const OUT_DIR_NAME = '.arkor';
export const BUNDLE_FILE = 'bundle.json';
/** What went into each Function, and what was done to it: for a diff, not for the platform. */
const DEPENDENCIES_FILE = 'dependencies.json';
const MIDDLEWARE_ENTRY_ID = '/_middleware';

/**
 * What the Node.js entries read through `node:fs`, for each Function to carry what its own entries
 * read: the app Function carries the middleware as well, and every one carries what the
 * instrumentation hook reads, since it runs before any entrypoint in each of them
 * (`instrumentationOf`). The Workflow SDK's flow route is its own Function's alone. A static export
 * runs none of the application's code, and reads nothing.
 */
function filesRead(
  ctx: BuildContext,
  build: {
    readonly workflow: WorkflowBuild;
    readonly middleware: AdapterOutput['MIDDLEWARE'] | undefined;
    readonly hookAssets: Readonly<Record<string, string>>;
    readonly exported: boolean;
  },
): {
  readonly app: readonly TracedFile[];
  readonly middleware: readonly TracedFile[];
  readonly workflow: readonly TracedFile[];
} {
  const own = build.middleware === undefined ? [] : [build.middleware];
  const hook = [{ assets: build.hookAssets }];
  const { flow, outputs } = build.workflow;
  const { appPages, appRoutes, pages, pagesApi } = outputs;
  return {
    app: build.exported
      ? []
      : tracedFiles(
          [...appPages, ...appRoutes, ...pages, ...pagesApi, ...own, ...hook],
          ctx.projectDir,
          ctx.distDir,
          ctx.repoRoot,
        ),
    middleware: tracedFiles([...own, ...hook], ctx.projectDir, ctx.distDir, ctx.repoRoot),
    workflow:
      flow === undefined
        ? []
        : tracedFiles([flow, ...hook], ctx.projectDir, ctx.distDir, ctx.repoRoot),
  };
}

/**
 * Which bundler built the server is only of interest where the Function carries the server's
 * code; a static export carries none, so the check that would refuse a webpack build is the wrong
 * question to ask of one.
 */
async function refuseOtherBundlers(distDir: string, exported: boolean): Promise<void> {
  const runtimeChunk = path.join(distDir, 'server', 'chunks', 'ssr', '[turbopack]_runtime.js');
  if (!exported && !(await exists(runtimeChunk))) {
    throw new Error(
      '@stayingupwind/adapter: only Turbopack builds are supported (no server runtime chunk found)',
    );
  }
}

/** The build's own directory, emptied: what this build writes is all that is ever in it. */
async function emptyOutDir(projectDir: string): Promise<string> {
  const outDir = path.join(projectDir, OUT_DIR_NAME);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  return outDir;
}

async function onBuildComplete(
  ctx: BuildContext,
  options: AdapterOptions,
  edgeHosts: readonly string[],
): Promise<void> {
  const exported = isStaticExport(ctx.config);
  if (!exported) {
    assertBuildPaths(ctx.projectDir, ctx.distDir, path.join(ctx.projectDir, OUT_DIR_NAME));
  }
  // Read before anything is written: a cron this platform cannot run fails the build here, where
  // the message is about the file the author wrote, rather than at the upload or never.
  const projectConfig = await readProjectConfig(ctx.projectDir, options.hostConfigFiles);
  // So are the gates the environment declares, which a build that cannot read them must not leave
  // out of what it writes.
  const gates = declaredGates();
  const outDir = await emptyOutDir(ctx.projectDir);
  const blobs = new BlobStore(outDir);
  await blobs.init();

  await refuseOtherBundlers(ctx.distDir, exported);
  // The Workflow SDK's flow route, when the project uses the SDK: built into a Function of its own,
  // and nowhere else (`workflow-function.ts`).
  const workflow = await workflowBuildOf(ctx, {
    exported,
    outDir,
    hosts: options.instrumentationModules ?? [],
    worldModule: options.workflowWorldModule,
  });
  const instrumentation = await instrumentationOf(ctx.distDir, outDir, exported, {
    hosts: workflow.hosts,
    repoRoot: ctx.repoRoot,
  });
  // Not asked of a static export, whose Function runs none of the application's code.
  const cacheHandlers = exported ? undefined : await cacheHandlersModule(ctx.distDir, outDir);
  const id = deploymentId();
  // Next.js's build manifests are what its route modules read at request time. A static export
  // has no route module in the Function, and the middleware Function has none either, so nothing
  // there would ever read one: shipping them would be bytes in a Function that never opens them.
  const manifests = exported ? [] : await collectManifests(ctx.projectDir, ctx.distDir, id);
  const collected = collectEntrypoints(workflow.outputs);
  const { entrypoints, sourcePages, edgeEntries } = collected;
  const { prerenders, ...pageBodies } = await collectPageBodies({
    outputs: ctx.outputs,
    blobs,
    basePath: ctx.config.basePath,
    rsc: ctx.routing.rsc,
    unshipped: options.unshippedOutputs ?? 'none',
    unshippedBodies: options.unshippedPrerenderBodies,
    entrypoints,
    // The host serves no segment of an edge-runtime page and the Function cannot render one, so
    // those stay shipped whatever the option says (`PrerenderCollection.edgeRuntimeRoutes`).
    edgeRuntimeRoutes: new Set(
      entrypoints.flatMap((entry) => (entry.runtime === 'edge' ? [entry.pathname] : [])),
    ),
    ensureStatic: await ensureStaticRoutes(ctx.distDir, ctx.config.basePath),
  });
  // What came through the build's `runAfterProductionCompile`, for every part of this build that
  // looks for a chunk's map (`kept-maps.ts`).
  const keptMaps = carriesMaps(options.sourceMaps) ? await readKeptMaps(ctx.distDir) : undefined;
  const { files: staticFiles, sourceMaps: clientMaps } = await collectStaticFiles(
    ctx,
    blobs,
    carriesMaps(options.sourceMaps),
    keptMaps,
  );
  const middleware = middlewareOutput(ctx.outputs);
  const middlewareParts = middlewarePlacement(middleware);
  const edgeInstrumentation = await edgeInstrumentationOf({
    distDir: ctx.distDir,
    outDir,
    hosts: edgeHosts,
    entries: [...edgeEntries, ...middlewareParts.edge],
  });

  // The edge serves every file from storage; the Function carries only what it answers itself —
  // the error documents, and small files outside `_next/static` (robots.txt, `public/`) a
  // middleware may rewrite to. Anything larger stays with the edge alone: a Function has a size
  // limit, and a public asset need not count against it.
  const shippedStatic = staticFiles.filter((file) =>
    travelsWithFunction(file, ctx.config.basePath, exported),
  );

  const bypassToken = bypassTokenOf(ctx.outputs);
  const routing = bundleRouting(ctx.routing, middleware);
  const baseRuntimeManifest = {
    // One-pass, as the bundle says below: a host that knows nothing of that refuses the version.
    v: ONE_PASS_BUNDLE_VERSION as number,
    routerReferences: 'one-pass' as const,
    resourceChanges: 1 as const,
    deploymentId: id,
    nextVersion: ctx.nextVersion,
    buildId: ctx.buildId,
    config: bundleConfig(ctx.config, await imagesConfig(ctx)),
    routing,
    ...(bypassToken !== undefined && { bypassToken }),
    entrypoints,
    ...(middleware !== undefined && { middleware: { matchers: middlewareMatchers(middleware) } }),
    prerenders,
    // What it carries, and what a rewrite may land on that it reads from the host instead.
    staticFiles: [
      ...shippedStatic,
      ...rewriteTargetFiles(
        staticFiles.filter((file) => !shippedStatic.includes(file)),
        routing,
        ctx.config.basePath,
      ),
    ],
  };
  const runtimeManifest = {
    ...baseRuntimeManifest,
    ...staticPagesRuntimeFields(baseRuntimeManifest),
  };
  const files = filesRead(ctx, {
    workflow,
    middleware,
    hookAssets: instrumentation.assets,
    exported,
  });
  const context: FunctionsContext = {
    ctx,
    outDir,
    blobs,
    cacheHostModule: options.cacheHostModule,
    sourceMaps: options.sourceMaps,
    keptMaps,
    manifests,
    hook: instrumentation,
    edgeInstrumentation,
    cacheHandlers,
    middleware: { output: middleware, ...middlewareParts },
    ...collected,
    // What the app Functions carry of the prerendered bodies, and whether a body may be missing
    // from them, as the host's `unshippedPrerenderBodies` says (`collectPageBodies`).
    ...pageBodies,
    staticBlobs: await staticBlobsOf(shippedStatic, outDir),
    files,
    workflowSdk: workflow.flow !== undefined,
    previewData: ctx.outputs.pages.length > 0 || ctx.outputs.pagesApi.length > 0,
  };
  const functions = await appFunctionsOf(
    context,
    runtimeManifest,
    exported ? undefined : buildSplitBudget(options, projectConfig),
  );
  // What the middleware's path reads and nothing more: the manifest's head alone
  // (`middlewareManifest`), and — in `buildMiddlewareFunction` — no build manifest, which only a
  // route module reads, and no cache, which nothing on that path reads or writes.
  const middlewareFunction = await buildMiddlewareFunction(
    context,
    JSON.stringify(middlewareManifest(functions.runtimeManifest)),
  );
  // The flow route's own Function, its manifest cut from the one every app Function carries.
  const workflowParts = workflowPartsOf(
    workflow,
    await buildWorkflowFunction(workflow, context, {
      runtimeManifest: functions.runtimeManifest,
      files: files.workflow,
    }),
  );
  const objects = await workerClassParts({
    projectDir: ctx.projectDir,
    outDir,
    blobs,
    options,
    split: functions.built.length > 1,
    distDir: ctx.distDir,
  });
  const sourceMaps = [
    ...clientMaps,
    ...functions.built.flatMap((each) => each.built.sourceMaps),
    ...(middlewareFunction?.sourceMaps ?? []),
    ...workflowParts.sourceMaps,
    ...objects.sourceMaps,
  ];

  // Publication adds capabilities the host needs; routing reference semantics also travel with
  // the Function so its own static admission agrees with the published bundle.
  const bundle: DeploymentBundle = deploymentBundleSchema.parse({
    ...functions.runtimeManifest,
    // How the Functions this adapter builds fill a header's `$` references: with the router the
    // runtime is built on, `@next/routing` 16.4 or later. The edge fills them that way for it.
    routerReferences: 'one-pass',
    aiInference: 1,
    // Its runtime records privacy vetoes and targeted no-transform prohibitions for route bodies.
    routeBodyPrivacy: 2,
    staticPagesPrivacy: STATIC_PAGES_FALLBACK_PRIVACY,
    ...objects.bundle,
    // Where each entrypoint's code is in the source tree. Only a reader of the build ever asks
    // (`sourcePageSchema`).
    sourcePages,
    // The cron jobs the project declared: the host schedules them, and the Function they reach
    // answers the request they make like any other.
    ...(projectConfig.crons.length > 0 && { crons: projectConfig.crons }),
    // The gates the build declares for its routes, which the host asks before it serves one; left
    // out of the Function's manifest, as nothing in the Function reads them.
    ...(gates !== undefined && { gates }),
    // Where the workflow Function takes the SDK's queue, and which SDK it was built with.
    ...workflowParts.bundle,
    projectDir: path.relative(ctx.repoRoot, ctx.projectDir).split(path.sep).join('/'),
    generatedAt: new Date().toISOString(),
    staticFiles,
    // The maps of everything this deployment carries: the browser chunks, taken out of what is
    // served, and each Function's own bundle. Left out entirely when the host asked for none, so
    // a bundle without them is a bundle without the field rather than one with an empty list.
    ...(sourceMaps.length > 0 && { sourceMaps }),
    functions: {
      ...bundleFunctions(functions.built, middlewareFunction),
      ...workflowParts.functions,
      ...objects.functions,
    },
  });
  await writeFile(path.join(outDir, BUNDLE_FILE), JSON.stringify(bundle, null, 2));
  const dependencies = {
    ...dependencyRecord(functions, middlewareFunction),
    ...workflowParts.dependencies,
    ...objects.dependencies,
  };
  await writeFile(path.join(outDir, DEPENDENCIES_FILE), JSON.stringify(dependencies, null, 2));
  await rm(path.join(outDir, 'work'), { recursive: true, force: true });
  if (
    functions.built.length > 1 ||
    functions.bodiesLeftOut !== undefined ||
    functions.built.some((each) => isNodeContainerFunction(each.built.spec))
  ) {
    // The modules of the Function the build weighed before it split, and of the Functions it laid
    // out with every page body before leaving the large ones out, are blobs nothing names.
    await blobs.prune(new Set(bundleBlobs(bundle).keys()));
  }
  console.log(
    `@stayingupwind/adapter: wrote ${OUT_DIR_NAME}/${BUNDLE_FILE} (${bundle.prerenders.length} prerenders, ${bundle.staticFiles.length} static files, ${blobs.count} blobs)`,
  );
  reportWhatTravels(bundle, edgeEntries, ctx.nextVersion, exported);
  reportSplit(functions.built);
  warnOfNoWorld(workflow, options.workflowWorldModule);
}

/**
 * The blobs of the files a Function answers itself (`travelsWithFunction`), once each, in the order
 * the files come in. Every app Function carries all of them — including one that is a prerendered
 * body byte for byte, which a Function holding none of that body's routes would otherwise lack; each
 * Function carries a digest once (`distinct`).
 */
async function staticBlobsOf(
  files: readonly { readonly blob: { readonly sha256: string } }[],
  outDir: string,
): Promise<{ sha256: string; bytes: Uint8Array }[]> {
  const blobs = new Map<string, { sha256: string; bytes: Uint8Array }>();
  for (const { blob } of files) {
    if (blobs.has(blob.sha256)) {
      continue;
    }
    const bytes = await readFile(path.join(outDir, 'blobs', blob.sha256));
    blobs.set(blob.sha256, { sha256: blob.sha256, bytes: new Uint8Array(bytes) });
  }
  return [...blobs.values()];
}

/** The bundle's Functions: the first app Function, the middleware's, and the rest of a split. */
function bundleFunctions(
  built: AppFunctions<unknown>['built'],
  middleware: BuiltFunction | undefined,
): DeploymentBundle['functions'] {
  const [first, ...rest] = built;
  if (first === undefined) {
    throw new Error('@stayingupwind/adapter: the build made no app Function');
  }
  return {
    app: first.built.spec,
    ...(middleware !== undefined && { middleware: middleware.spec }),
    ...(rest.length > 0 && {
      split: Object.fromEntries(rest.map((each) => [each.name, each.built.spec])),
    }),
  };
}

/**
 * What a reader of the build is told once it is written, rather than in the middle of it.
 *
 * A page on the edge runtime renders with no postponed state, so nothing of it can be served ahead
 * of its render the way a Node.js page's shell is.
 *
 * And a build before 16.3 classifies none of its prerenders, which is a thing worth saying once:
 * what the platform makes of such a bundle is read off the outputs themselves
 * (`@stayingupwind/core/bundle`, `documentPrerenders`), and while that answers the same as the
 * classification wherever there is one to compare it with, there is no classification here to
 * compare it with.
 *
 * And a Next.js older than the newest release that carried security fixes (`SECURITY_FLOOR`, or
 * `SECURITY_CANARY_FLOOR` for a canary numbered past it; `@stayingupwind/core/next`) is said here
 * rather than refused, because the range this adapter
 * supports is a claim about what its rewrites still find and not a judgement about advisories. A
 * static export is the one build this says nothing to: it carries no Next.js server code for a fix
 * inside Next.js to be missing from.
 */
function reportWhatTravels(
  bundle: DeploymentBundle,
  edgeEntries: readonly EdgeEntry[],
  nextVersion: string,
  exported: boolean,
): void {
  if (edgeEntries.length > 0) {
    const ids = edgeEntries.map((entry) => entry.id).join(', ');
    console.warn(
      `@stayingupwind/adapter: on the deprecated edge runtime: ${ids}. Their code travels in the Function's own edge bundle, and a page among them is answered in full — the edge serves no shell ahead of a route that cannot resume one.`,
    );
  }
  const unclassified =
    bundle.prerenders.length > 0 && bundle.prerenders.every((one) => one.routeType === undefined);
  if (unclassified) {
    console.warn(
      `@stayingupwind/adapter: Next.js ${nextVersion} does not classify its prerenders, which Next.js 16.3 is the first to do. This deployment's ${String(bundle.prerenders.length)} prerenders are read as their outputs describe them instead; \`/_next/static/immutable/*\` is off, since 16.2 does not offer it.`,
    );
  }
  const floor = exported ? undefined : securityFloorOf(nextVersion);
  if (floor !== undefined) {
    console.warn(
      `@stayingupwind/adapter: Next.js ${nextVersion} is older than ${floor.version}, the first ${floor.canary ? 'canary' : 'release'} with the newest Next.js security fixes that this adapter knows of. What answers a request is the Next.js this project installed: the React Server Components transport it vendors, which reads back what a \`use cache\` function returned and what is sent to a Server Action, travels into the Function, and nothing here stands in for it. Upgrade and build again — ${SECURITY_RELEASE_URL}`,
    );
  }
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
  /** The runtime built into this deployment; Cloudflare remains the default. */
  readonly target?: RuntimeTarget | undefined;
  /** Host registrations whose class code is built separately from every Next.js Function. */
  readonly durableObjects?: readonly DurableObjectDeclaration[] | undefined;
  /** Host-owned Cloudflare Workflow registrations, built independently of application routes. */
  readonly cloudflareWorkflows?: readonly CloudflareWorkflowDeclaration[] | undefined;
  /**
   * The module the runtime's cache reads and writes through, as an absolute path — what
   * `arkor:cache-host` resolves to, bundled into the app Function's runtime. The middleware
   * Function is built without it: nothing on its path reads or writes the cache.
   *
   * Bundled into the runtime, it is renamed with it: its functions and classes keep their names, and
   * its variables and parameters are renamed short. A module that reads its own functions'
   * parameter names, through `Function.prototype.toString()`, would read renamed ones and not work.
   *
   * Left out, the runtime is given no cache and answers every read a miss: a bundle that is
   * correct, serves what the build produced, and revalidates nothing. A host that stores
   * generations names its own module here.
   */
  readonly cacheHostModule?: string | undefined;
  /**
   * Prefetch segments whose bytes the Function does **not** carry, for a host that serves them
   * itself.
   *
   * Next.js 16.3's Partial Prefetching writes one output per prefetchable segment of every
   * prerendered page, and they are most of what a Function weighs: measured on a 1,486-module
   * build, 826 of them at **19.74 MiB — 37% of the whole Function**, against 4.4 MiB of the
   * documents it serves. A host that answers `next-router-segment-prefetch` from its own storage
   * (`prefetchSegments`) reads none of them, and the Function carries them for nothing.
   *
   * `'none'`, the default, ships every output as this adapter always has. **It is the default
   * because leaving it out is not free**: a host that does not serve segments has only the
   * Function to answer them, and then the bytes are the answer.
   *
   * `'prefetch-segments'` records every segment in the bundle exactly as before — `segmentPath`,
   * `parentOutputId`, the lot, which is what a host places them from — and ships no body for one.
   *
   * **A host that chooses this must export `createBundleBlobReader`** from its `cacheHostModule`
   * (`@stayingupwind/runtime/bundle-blobs`), which is how the Function gets the bytes of a segment
   * it was not given. Not part of the cache: a deployment the host gave no cache still has a
   * bundle, and a build that left blobs out of its Function needs them read all the same.
   *
   * That read is off every path that works — the host answers these prefetches itself, and the
   * Function sees only the ones it could not: a middleware that failed, a host with nothing to
   * serve the prefetch from, a request that reached the Worker without the host having served it at
   * all. (Not a draft request, which `bypassesPrerender` sends to the route itself, and which
   * should render rather than be handed a build's segment.) But on that path the host's reader is
   * the only source there is. Neither of the two ways of producing the segment locally exists:
   * `renderCaptured` answers `undefined` whenever the render responded instead of being captured,
   * which a segment prefetch always does, and a resume carries the *document's* postponed state,
   * which Next.js refuses for a segment it has no prerendered output for. Both were measured, both
   * 404. A host that exports no reader gets that 404 — a prefetch the client navigates through
   * instead, not a broken page, but not the bytes either.
   */
  readonly unshippedOutputs?: 'none' | 'prefetch-segments' | undefined;
  /**
   * Opt in to leave completed Node App-page HTML and whole RSC bodies in the host's bundle
   * storage when their individual byte lengths fall in this inclusive range. Every body reference
   * and uploaded blob stays unchanged; small bodies, reusable shells, postponed state, error
   * documents, Pages Router outputs and edge-runtime outputs remain in the Function.
   *
   * The default is unset: every page body is shipped. A host choosing this must name a nonempty
   * `cacheHostModule` exporting `createBundleBlobReader`, and set maxBytes to a size its reader can
   * return. A missing or blank host module is rejected when the adapter is created. The build
   * requires a named runtime ESM export, including reexports; a CommonJS host can provide an
   * ESM facade. This checks the export without executing the host or proving backend availability.
   * A Function falling back to an omitted body waits for that reader and fails if the exact body is
   * unavailable.
   * Edge delivery and shipped bodies do not make that read. This trades fallback latency for
   * a smaller Function, and does not promise an improvement in request-time memory or TTFB.
   *
   * `when: 'over-limit'` makes that trade only where a build cannot be uploaded without it. The
   * build lays its app Functions out with every body in them, as if the option were unset — and
   * a build within the size limit (`MAX_FUNCTION_BYTES`) is then exactly that build: the same
   * modules, the same runtime, no body left to the reader. Only when one of them is past the limit
   * are they laid out again from the same `next build` output, with the range applied as the
   * default `'always'` applies it to every build, and audited again: a build that is still past
   * the limit fails as it would have without the option. The build log says how many bodies, and
   * how many bytes, were left out. A split (`functions.split`) that brings every Function under
   * the limit leaves the bodies where they are. The host module is required here as well, since
   * which builds will need its reader is only known once each has been weighed.
   */
  readonly unshippedPrerenderBodies?: UnshippedPrerenderBodies | undefined;
  /**
   * Names the host reads a project's configuration under besides this adapter's own, for a host
   * that once called that file something else. Looked for after `upwind.*` and before
   * `vercel.json` (`configFileOrder`); a build that simply stopped looking would read an empty
   * configuration from a project that wrote one, and take the crons it declared as withdrawn.
   */
  readonly hostConfigFiles?: readonly string[] | undefined;
  /**
   * Modules of the host's own whose instrumentation hooks run beside the project's, as absolute
   * paths. Bundled into both Functions, and composed with the project's `instrumentation` file if
   * it wrote one (`composedInstrumentation`): the host's `register` and `onRequestError` run
   * first, inside a `try`, and the project's runs after.
   *
   * For a host that wants to see what an application does — an error as it is thrown, a request as
   * it is served. Next.js loads one hook from one file, and taking that file away from the project
   * is not an option: it is the documented way for an application to instrument itself.
   */
  readonly instrumentationModules?: readonly string[] | undefined;
  /**
   * Edge-safe host modules, as absolute paths, composed with Next.js's own Edge-compiled hook.
   * Explicitly opted into: Node `instrumentationModules`, and the generated Workflow World
   * registration, are never inherited. Host imports use the `edge-light` package condition.
   * The same host-first/error-isolation contract applies; an unknown instrumentation manifest
   * or registration shape is refused rather than silently omitting the project's hook.
   */
  readonly edgeInstrumentationModules?: readonly string[] | undefined;
  /**
   * A module of the host's own, as source, run in the browser before React hydrates.
   *
   * Written into the build's own directory and named in `instrumentationClientInject`, which
   * Next.js provides for exactly this — "primarily intended for `next.config.js` plugins… without
   * requiring every project to author or modify an `instrumentation-client` file". Source rather
   * than a path, because a host's module lives outside the project and Next.js resolves an entry
   * from the project's `node_modules` or relative to its root.
   *
   * Production builds only. A development server is the developer's own, and a module of the
   * host's running in it would be a line in their console that their project did not put there.
   */
  readonly clientInstrumentationSource?: string | undefined;
  /**
   * The module a deployment's Workflow SDK keeps its runs in, as an absolute path: one that exports
   * `createWorld()`, answering a World (`@workflow/world`) or a promise of one.
   *
   * Only a build that uses the SDK carries it. Registered from the instrumentation hook, before any
   * route of the deployment runs (`writeWorldRegistration` in `workflow.ts`); the World is the
   * host's own, since what stores a run and delivers its messages is the platform's to provide —
   * the SDK's own Worlds keep their state on a file system or reach Vercel, and a Function has
   * neither.
   */
  readonly workflowWorldModule?: string | undefined;
  /**
   * Carry the deployment's source maps, so a host can show a stack against the code it was
   * written as.
   *
   * Turns on `productionBrowserSourceMaps` and `experimental.serverSourceMaps`, builds the
   * Functions with maps, and — this is the half that matters — **moves every `.map` out of the
   * static files**. Next.js serves the browser maps it emits, and a deployment that published
   * them would publish the application's source with them; here they travel as blobs the host
   * stores and nothing serves.
   *
   * The maps are kept through the project's own `runAfterProductionCompile`, where a plugin that
   * uploads them elsewhere deletes them (`kept-maps.ts`), and carried flat: an index map, which
   * Turbopack writes when debug IDs are on, is made one list of mappings (`flattened`).
   *
   * `'project'` is the same, with each Function's map kept to the files the project wrote
   * (`projectOnly`): a frame inside a package, or inside the build's own output, reads as built,
   * and the map is a fraction of the size. A browser map describes one chunk and is kept whole.
   * Available original source text travels in a bounded private archive beside each compact map;
   * a host can read a code excerpt without loading every source or adding text to its map cache.
   */
  readonly sourceMaps?: SourceMapsOption;
  /**
   * How the application's routes are spread across app Functions.
   *
   * Left out, every route is in one Function, as it always was, and a Function past Cloudflare's
   * limit fails the build. `split` lets a large application run as several instead: the build makes
   * the one Function and weighs it, and when it is past `maxMiB` — or its code is past
   * `maxCodeMiB`, which is what a Function's start is spent compiling — it plans the routes into as
   * few Functions as fit those budgets, putting routes that share their code together, and builds
   * each with its own routes (`split.ts`, `plan.ts`). A bundle split this way is version 2, places
   * each entrypoint in its Function, and carries the Functions after the first in
   * `functions.split`.
   *
   * **Only for a host that can route between them**: it has to send each request to the Function
   * its route is in — the manifest's tables say which (`functionFor`) — and follow a Function that
   * answers `421` with another's name (`MISDIRECTED_STATUS`), sending the request on with the
   * `x-arkor-routed` it was answered with and the body it got back. A project can turn the split
   * off, or tighten the budgets, in its own configuration file (`functions.split`).
   */
  readonly functions?: { readonly split?: SplitOptions | undefined } | undefined;
}

/**
 * Name the host's browser module in the config, or refuse the build.
 *
 * `instrumentationClientInject` arrived in Next.js 16.3 and this adapter supports 16.2 as well,
 * where the field does not exist — and a config Next.js never reads is a build that completes
 * while silently shipping none of the host's instrumentation. Asked of the config rather than of
 * the version, because the config is what decides; refused rather than skipped, because a host
 * that asked for this and did not get it should hear so at the build and not from an empty
 * dashboard.
 */
async function injectClientInstrumentation(
  config: BuildConfig,
  projectDir: string,
  source: string,
): Promise<void> {
  const own = config.instrumentationClientInject as string[] | undefined;
  if (!Array.isArray(own)) {
    throw new TypeError(
      '@stayingupwind/adapter: this Next.js has no `instrumentationClientInject`, which arrived in 16.3; a host that needs `clientInstrumentationSource` needs that release',
    );
  }
  const entry = await writeClientInstrumentation({
    outDir: path.join(projectDir, OUT_DIR_NAME),
    outDirName: OUT_DIR_NAME,
    source,
  });
  // Appended, never replacing: a project may have entries of its own, and Next.js runs them in
  // array order with its own `instrumentation-client` file last.
  config.instrumentationClientInject = [...own, entry];
}

/**
 * The adapter, as a host configures it.
 *
 * `NEXT_ADAPTER_PATH` and `adapterPath` both name a module whose default export is a
 * `NextAdapter`, so a host that needs no options points either at this module and takes the
 * default export below. One that does — a cache host of its own — exports an adapter of its own
 * from a module of two lines.
 *
 * `name` is what Next.js calls this adapter in its own output, and the one string here a reader
 * outside the build can come to depend on. It is the name a user installed rather than the name of
 * anything inside: the bundle's own vocabulary is `arkor`, and a host that wants to know what wrote
 * a bundle should read the bundle.
 */
export function createAdapter(options: AdapterOptions = {}): NextAdapter {
  const target = runtimeTargetOf(options.target);
  if (target === 'node' && options.cacheHostModule !== undefined) {
    throw new Error(
      '@stayingupwind/adapter: the node target uses its persistent local cache; remove cacheHostModule or select the cloudflare target',
    );
  }
  checkSplitOptions(options.functions?.split);
  checkPageBodyHost(options.unshippedPrerenderBodies, options.cacheHostModule);
  const edgeHosts = checkedEdgeInstrumentationModules(options.edgeInstrumentationModules);
  return {
    name: 'upwind',
    async modifyConfig(config, context) {
      const { phase } = context;
      const projectDir = projectDirOf(context);
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
        // The CLI cannot inspect a custom adapter's target before loading next.config. Publish
        // the choice now so forked prerender workers skip any inherited Cloudflare preload.
        if (target === 'node') publishNativeBuildTarget();
        // Content-addressed `/_next/static/immutable/*`: shared across deployments, cached
        // forever. Asked for unconditionally. Before 16.4 Next.js refuses it for a static export,
        // turning the option off in `finalizeConfig` after this hook has run; such a build's
        // assets are recognized from the build's own `onMatch` rule instead (see
        // `immutableByBuild`).
        config.supportsImmutableAssets = true;
        if (target === 'cloudflare') renderInOneProcessForStorage(config);
        // The Workflow SDK's own Worlds stay out of the Functions: neither can run there.
        if (target === 'cloudflare') await aliasBuiltinWorlds(config, projectDir, OUT_DIR_NAME);
        configureBuildSourceMaps(config, options.sourceMaps);
        if (options.clientInstrumentationSource !== undefined) {
          await injectClientInstrumentation(
            config,
            projectDir,
            options.clientInstrumentationSource,
          );
        }
      }
      return config;
    },
    async onBuildComplete(ctx) {
      if (target === 'node') {
        const { emitNativeDeployment } = await import('./native/emit.ts');
        await emitNativeDeployment(ctx, options);
        return;
      }
      await onBuildComplete(ctx, options, edgeHosts);
    },
  };
}

// `NEXT_ADAPTER_PATH` and `adapterPath` name a module whose default export is the adapter; this
// one is configured with what the environment says, which is nothing outside `upwind deploy`.
// eslint-disable-next-line import-x/no-default-export
export default createAdapter(environmentOptions());

export { bundleDurableObjects, type BundledDurableObject } from './durable-objects.ts';
// What `upwind deploy` reads the project's configuration with: the reader its build uses.
export { type DeployConfig, readProjectConfig, type UpwindConfig } from './project-config.ts';
export type { RuntimeTarget } from './native/target.ts';

export {
  bundleCloudflareWorkflows,
  buildCloudflareWorkflowFunctions,
  type BundledCloudflareWorkflow,
} from './cloudflare-workflows.ts';
