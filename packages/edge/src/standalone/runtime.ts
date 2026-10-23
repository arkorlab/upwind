import { functionBinding } from '@stayingupwind/host/bindings';

import {
  type BlobWorker,
  type DispatchApp,
  type EdgeRuntime,
  imagesTransform,
} from '../edge-runtime.ts';
import { createEdgeMemory, type EdgeMemory } from '../memory/caches.ts';
import type { StandaloneEnv } from './env.ts';

/**
 * A Function the pointer names that this edge is not bound to. Answered `502` and not tried again:
 * the edge is deployed with the Functions its pointer names, so one missing now is missing for good.
 */
export class FunctionNotBoundError extends Error {
  constructor(scriptName: string, options?: ErrorOptions) {
    super(`no Function is bound as ${functionBinding(scriptName)}`, options);
    this.name = 'FunctionNotBoundError';
  }
}

function isFetcher(value: unknown): value is Fetcher {
  return typeof value === 'object' && value !== null && 'fetch' in value;
}

/**
 * The deployment's Functions over service bindings, each by its name (`functionBinding`). What a
 * dispatch may spend is not bounded here (`DispatchLimits`): a Function reached by a service binding
 * keeps the limits it was deployed with.
 */
function serviceDispatch(env: StandaloneEnv): DispatchApp {
  return async (scriptName, request): Promise<Response> => {
    const service: unknown = Reflect.get(env, functionBinding(scriptName));
    if (!isFetcher(service)) {
      throw new FunctionNotBoundError(scriptName);
    }
    return service.fetch(request);
  };
}

/** Only a placeholder: a binding is routed by the binding, and the reader keys on the path alone. */
const BLOB_ORIGIN = 'https://blob.upwind.invalid';

/** The bucket's reader over its binding, where one is bound (`EdgeRuntime.blobWorker`). */
function blobReader(service: Fetcher | undefined): BlobWorker | undefined {
  if (service === undefined) {
    return undefined;
  }
  return async (path, init): Promise<Response> =>
    service.fetch(new Request(`${BLOB_ORIGIN}${path}`, init));
}

/** Isolate-wide memory, shared by every request this instance of the Worker handles. */
const shared: { memory: EdgeMemory | undefined } = { memory: undefined };

/**
 * The edge's runtime as a standalone edge builds it: `fetch`, the clock, the isolate's memory, its
 * Functions over service bindings, Images and the blob reader where they are bound, and no reports.
 * A test hands in what it replaces.
 */
export function standaloneRuntime(
  env: StandaloneEnv,
  overrides: Partial<EdgeRuntime> = {},
): EdgeRuntime {
  const now = overrides.now ?? ((): number => Date.now());
  // On the real clock, whatever clock a runtime brings: the memory is every request's, and the clock
  // of whichever runtime came first would otherwise judge the age of all it holds.
  const memory = overrides.memory ?? (shared.memory ??= createEdgeMemory((): number => Date.now()));
  return {
    fetchImpl: overrides.fetchImpl ?? ((request, init): Promise<Response> => fetch(request, init)),
    now,
    memory,
    dispatchApp: overrides.dispatchApp ?? serviceDispatch(env),
    transformImage: overrides.transformImage ?? imagesTransform(env.IMAGES),
    blobWorker: overrides.blobWorker ?? blobReader(env.BLOBS),
    reports: overrides.reports,
  };
}
