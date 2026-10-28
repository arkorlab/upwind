import {
  type Entrypoint,
  type Prerender,
  PRIMARY_FUNCTION,
  MAX_APP_FUNCTIONS,
  NATIVE_FUNCTION_BUNDLE_VERSION,
  NATIVE_FUNCTION_SPLIT_BUNDLE_VERSION,
} from '@stayingupwind/core/bundle';

import {
  appFunctionInput,
  buildAppFunction,
  layOutAppFunctions,
  runtimeManifestJson,
  partsOf,
  type AppFunctions,
  type FunctionsContext,
} from './app-functions.ts';
import type { RouteCode } from './collect.ts';
import { AuditError } from './dependencies.ts';
import { INSTRUMENTATION_NATIVE_OWNER } from './native-addon-entries.ts';
import type { NativeLoad } from './native-loads.ts';
import { buildNodeFunction, type NodeFunctionFiles } from './node-function.ts';
import type { PlanBudget } from './plan.ts';
import { carriesBlob, everyFunction, placedEntrypoints } from './split.ts';

/** Preserve the existing module and Pages Router units, including shared middleware/error hooks. */
export function nativeRouteOwners(
  routes: readonly RouteCode[],
  loads: readonly NativeLoad[],
  every: ReadonlySet<string>,
): ReadonlySet<string> {
  const ids = new Set(routes.map((route) => route.id));
  const native = new Set(loads.flatMap((load) => load.owners));
  if (
    [...native].some((id) => !ids.has(id) && id !== INSTRUMENTATION_NATIVE_OWNER && !every.has(id))
  ) {
    throw new AuditError('A native capability has an unknown Function owner');
  }
  if ([...native].some((id) => id === INSTRUMENTATION_NATIVE_OWNER || every.has(id))) return ids;
  const files = new Set(
    routes
      .filter((route) => native.has(route.id))
      .flatMap((route) => (route.module === undefined ? [] : [route.module.filePath])),
  );
  const pages = routes.some(
    (route) => native.has(route.id) && (route.kind === 'pages' || route.kind === 'pages-api'),
  );
  for (const route of routes) {
    if (
      (route.module !== undefined && files.has(route.module.filePath)) ||
      (pages &&
        route.module !== undefined &&
        route.edge === undefined &&
        (route.kind === 'pages' || route.kind === 'pages-api'))
    )
      native.add(route.id);
  }
  return native;
}

/**
 * No proof covers the App Router's manifest consumers: a Node Function holding any App Router route
 * carries the whole server output instead of a proved closure of it.
 */
function nodeFunctionFiles(routes: readonly RouteCode[]): NodeFunctionFiles {
  return routes.some((route) => route.kind === 'app-page' || route.kind === 'app-route')
    ? 'server'
    : 'proved';
}

/** A native requirement does not license unrelated audit failures or move cache hits to compute. */
export async function nativeFunctionLayout<
  M extends {
    readonly v: number;
    readonly entrypoints: readonly Entrypoint[];
    readonly prerenders: readonly Prerender[];
  },
>(
  context: FunctionsContext,
  manifest: M,
  options: {
    readonly budget: PlanBudget | undefined;
    readonly loads: readonly NativeLoad[];
    readonly weighOnly: boolean;
  },
): Promise<AppFunctions<M>> {
  const every = everyFunction(context.ctx.config.basePath);
  const native = nativeRouteOwners(context.routes, options.loads, every);
  const workers = context.routes.filter((route) => !native.has(route.id) || every.has(route.id));
  const workerOwns = workers.some((route) => !every.has(route.id));
  if (!workerOwns) {
    if (context.routes.some((route) => route.edge !== undefined))
      throw new AuditError(
        'A shared native dependency would move an Edge-runtime entrypoint out of its Worker',
      );
    const runtimeManifest = { ...manifest, v: NATIVE_FUNCTION_BUNDLE_VERSION };
    const input = await appFunctionInput(
      context,
      runtimeManifestJson(runtimeManifest),
      undefined,
      false,
    );
    const built = await buildNodeFunction(input, options.loads, nodeFunctionFiles(context.routes));
    return {
      runtimeManifest,
      built: [{ name: PRIMARY_FUNCTION, built }],
      plan: { nativeFunctions: [{ name: PRIMARY_FUNCTION, routes: [...native] }] },
    };
  }
  const workerIds = new Set(workers.map((route) => route.id));
  const pieces = partsOf(context, { name: PRIMARY_FUNCTION, routes: workerIds });
  const known = new Set(context.routes.map((route) => route.id));
  const workerContext: FunctionsContext = {
    ...context,
    routes: workers,
    modules: workers.flatMap((route) => (route.module === undefined ? [] : [route.module])),
    edgeEntries: workers.flatMap((route) => (route.edge === undefined ? [] : [route.edge])),
    chunks: [...new Set(workers.flatMap((route) => route.chunks))],
    wasm: [...new Set(workers.flatMap((route) => route.wasm))],
    files: { ...context.files, app: pieces.files },
    manifests: pieces.manifests,
    shipped: context.shipped.filter((blob) => carriesBlob(blob, workerIds, known)),
  };
  const planned = await layOutAppFunctions(workerContext, manifest, options.budget, {
    weighOnly: options.weighOnly,
    reservedFunctions: 1,
  });
  if (planned.built.length + 1 > MAX_APP_FUNCTIONS)
    throw new AuditError('Native Function placement exceeds the app Function limit');
  const name = `app-${planned.built.length + 1}`;
  const placements = new Map(
    planned.runtimeManifest.entrypoints.flatMap((entry) =>
      entry.function === undefined ? [] : [[entry.id, entry.function] as const],
    ),
  );
  for (const id of native) if (!every.has(id)) placements.set(id, name);
  const runtimeManifest = {
    ...manifest,
    v: NATIVE_FUNCTION_SPLIT_BUNDLE_VERSION,
    entrypoints: placedEntrypoints(manifest.entrypoints, placements),
  };
  const json = runtimeManifestJson(runtimeManifest);
  const built: AppFunctions<M>['built'][number][] = [];
  for (const worker of planned.built) {
    const held = new Set(
      workers
        .filter(
          (route) =>
            every.has(route.id) || (placements.get(route.id) ?? PRIMARY_FUNCTION) === worker.name,
        )
        .map((route) => route.id),
    );
    built.push({
      name: worker.name,
      built: await buildAppFunction(
        context,
        json,
        { name: worker.name, routes: held },
        options.weighOnly,
      ),
    });
  }
  const held = new Set(
    context.routes
      .filter((route) => native.has(route.id) || every.has(route.id))
      .map((route) => route.id),
  );
  if (context.routes.some((route) => held.has(route.id) && route.edge !== undefined))
    throw new AuditError(
      'A native Function would carry an Edge-runtime entrypoint; refusing publication',
    );
  const input = await appFunctionInput(context, json, { name, routes: held }, false);
  const carries = nodeFunctionFiles(context.routes.filter((route) => held.has(route.id)));
  built.push({ name, built: await buildNodeFunction(input, options.loads, carries) });
  return {
    runtimeManifest,
    built,
    plan: { ...planned.plan, nativeFunctions: [{ name, routes: [...native] }] },
  };
}
