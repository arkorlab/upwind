import type { FunctionSpec, SourceMapRef, WorkflowSpec } from '@stayingupwind/core/bundle';
import type { AdapterOutput } from 'next';

import { type FunctionsContext, patchFor } from './app-functions.ts';
import { type BuildContext, collectEntrypoints } from './collect.ts';
import type { FunctionDependencies } from './dependencies.ts';
import { buildFunction, type BuiltFunction } from './function.ts';
import { carriesMaps } from './source-maps.ts';
import type { TracedFile } from './traced-files.ts';
import { collectWasm } from './wasm.ts';
import { flowRouteOf, workflowSdkVersion, writeWorldRegistration } from './workflow.ts';

/**
 * A build that uses the Workflow SDK, as the adapter splits it: the SDK's flow route taken out of
 * the application's routes and built into a Function of its own (`buildWorkflowFunction`), and the
 * host's World registered where the SDK looks for one (`workflow.ts`).
 */

/** What a build is, as far as the Workflow SDK goes: nothing at all for one that does not use it. */
export interface WorkflowBuild {
  /** The SDK's flow route, which the workflow Function answers and the application does not. */
  readonly flow: AdapterOutput['APP_ROUTE'] | undefined;
  /** The SDK's version, for the bundle to record. */
  readonly sdk: string | undefined;
  /** The build's outputs without the flow route: what the application's Functions are built from. */
  readonly outputs: BuildContext['outputs'];
  /** The instrumentation hosts, the World's registration among them where the host named one. */
  readonly hosts: readonly string[];
}

export async function workflowBuildOf(
  ctx: BuildContext,
  input: {
    readonly exported: boolean;
    readonly outDir: string;
    readonly hosts: readonly string[];
    readonly worldModule: string | undefined;
  },
): Promise<WorkflowBuild> {
  // A static export runs none of the application's code.
  const flow = input.exported ? undefined : flowRouteOf(ctx.outputs.appRoutes, ctx.config.basePath);
  if (flow === undefined) {
    return { flow, sdk: undefined, outputs: ctx.outputs, hosts: input.hosts };
  }
  const outputs = {
    ...ctx.outputs,
    appRoutes: ctx.outputs.appRoutes.filter((output) => output.pathname !== flow.pathname),
  };
  const registration =
    input.worldModule === undefined
      ? []
      : [await writeWorldRegistration(input.outDir, input.worldModule)];
  return {
    flow,
    sdk: await workflowSdkVersion(ctx.projectDir),
    outputs,
    hosts: [...input.hosts, ...registration],
  };
}

/** What the bundle carries of a build that uses the SDK, and nothing for one that does not. */
export interface WorkflowParts {
  /** Where the workflow Function takes the SDK's queue, and which SDK it was built with. */
  readonly bundle: { readonly workflow?: WorkflowSpec };
  readonly functions: { readonly workflow?: FunctionSpec };
  readonly dependencies: { readonly workflow?: FunctionDependencies };
  readonly sourceMaps: readonly SourceMapRef[];
}

export function workflowPartsOf(
  build: WorkflowBuild,
  built: BuiltFunction | undefined,
): WorkflowParts {
  if (built === undefined || build.flow === undefined || build.sdk === undefined) {
    return { bundle: {}, functions: {}, dependencies: {}, sourceMaps: [] };
  }
  return {
    bundle: { workflow: { route: build.flow.pathname, sdk: build.sdk } },
    functions: { workflow: built.spec },
    dependencies: { workflow: built.dependencies },
    sourceMaps: built.sourceMaps,
  };
}

/** Said once a build that uses the SDK is written, when the host named no World for it. */
export function warnOfNoWorld(build: WorkflowBuild, worldModule: string | undefined): void {
  if (worldModule !== undefined || build.flow === undefined) {
    return;
  }
  console.warn(
    `@stayingupwind/adapter: this build uses the Workflow SDK (${build.sdk ?? 'workflow'}), and the host named no World for it (\`workflowWorldModule\`). Unless the project's own instrumentation hook calls \`setWorld()\`, every run fails where it starts: the SDK's own Worlds keep their state on a file system or reach Vercel, and a Function has neither.`,
  );
}

export interface WorkflowFunctionInput {
  /** The deployment's runtime manifest, which this Function's is cut from. */
  readonly runtimeManifest: Readonly<Record<string, unknown>> & {
    readonly routing: Readonly<Record<string, unknown>>;
  };
  /** What the flow route and the instrumentation hook read through `node:fs` (`filesRead`). */
  readonly files: readonly TracedFile[];
}

/**
 * The routing a delivery goes through, which is none: every table of rules a visitor's request is
 * matched against, empty. A delivery is the host's own request to the flow route, as Vercel's queue
 * invokes the function itself, so a redirect or rewrite the application wrote for its pages — a
 * catch-all one included — must not send it anywhere else, and a header rule has no one to tell.
 * What is left is the match of the one route this Function has.
 */
const DELIVERY_ROUTING = {
  beforeMiddleware: [],
  middlewareMatchers: [],
  beforeFiles: [],
  afterFiles: [],
  dynamicRoutes: [],
  onMatch: [],
  fallback: [],
  shouldNormalizeNextData: false,
} as const;

/**
 * The workflow Function: the SDK's flow route, and nothing else of the application's — every run's
 * messages are delivered to it, its steps run in it, and no visitor's request reaches it.
 *
 * Its manifest is the deployment's with that one route in it and nothing to serve besides: no
 * prerender, no file, no middleware and no routing rules (`DELIVERY_ROUTING`). Nor a route placed
 * in another Function, where the build split its routes: the one route it has is its own.
 */
export async function buildWorkflowFunction(
  build: WorkflowBuild,
  context: FunctionsContext,
  input: WorkflowFunctionInput,
): Promise<BuiltFunction | undefined> {
  const { flow } = build;
  if (flow === undefined) {
    return undefined;
  }
  const { ctx } = context;
  if (flow.runtime === 'edge') {
    throw new Error(
      "@stayingupwind/adapter: the Workflow SDK's flow route was built for the edge runtime, which cannot run its steps",
    );
  }
  const entry = collectEntrypoints({
    ...ctx.outputs,
    appPages: [],
    appRoutes: [flow],
    pages: [],
    pagesApi: [],
  });
  // Everything of the deployment's manifest but its middleware, which this Function never runs.
  const shared = Object.fromEntries(
    Object.entries(input.runtimeManifest).filter(([key]) => key !== 'middleware'),
  );
  const manifest = {
    ...shared,
    routing: { ...input.runtimeManifest.routing, ...DELIVERY_ROUTING },
    entrypoints: entry.entrypoints,
    prerenders: [],
    staticFiles: [],
  };
  const wasm = await collectWasm(ctx.distDir, [...entry.wasm, ...context.hook.wasm], []);
  return buildFunction({
    kind: 'workflow',
    projectDir: ctx.projectDir,
    outDir: context.outDir,
    patch: await patchFor(context, entry.chunks, wasm),
    entries: entry.modules,
    edgeEntries: [],
    wasm: wasm.collector,
    manifests: context.manifests,
    runtimeManifest: JSON.stringify(manifest),
    cacheHostModule: context.cacheHostModule,
    ...(carriesMaps(context.sourceMaps) && {
      sourceMaps: context.sourceMaps,
      keptMaps: context.keptMaps,
    }),
    blobs: [],
    files: input.files,
    blobStore: context.blobs,
    workflowSdk: true,
  });
}
