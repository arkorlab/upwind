import { type AppRuntime, functionFor, type ProjectManifest } from '@stayingupwind/core/manifest';
import { PatternBudgetExceededError } from '@stayingupwind/core/request';

import { withScopeRevision } from '../cache/scope-signal.ts';
import type { EdgeRuntime } from '../edge-runtime.ts';
import { dispatchSplitApp, NoApplicationError, NoDispatchError, unsent } from './app-dispatch.ts';
export {
  dispatchedOf,
  dispatchesOf,
  dispatchedSoFar,
  dispatchesSoFar,
  dispatchesMade,
  dispatchesOfFailure,
  MisroutedError,
  type Dispatched,
} from './app-dispatch.ts';

/**
 * Which app Worker a request goes to, for a deployment whose build split its routes across several:
 * the one the manifest's tables place the route in, read the way Next.js routes it (`functionFor`)
 * — and `undefined`, the first, where they cannot say, or where the deployment was not split. Read
 * off the request as the Worker will be handed it: after the middleware, when the edge ran it. A
 * wrong answer costs one more hop, never a different response (`fetchUpstream`).
 */
export function functionOfRequest(
  app: AppRuntime | undefined,
  manifest: ProjectManifest | undefined,
  request: Request,
): string | undefined {
  if (manifest === undefined || app?.functions === undefined) {
    return undefined;
  }
  try {
    return functionFor(manifest, new URL(request.url), request.headers);
  } catch (error) {
    // A pattern of the application's the edge does not run against this request
    // (`budgetPatterns`): the tables cannot say, and the first Worker hands it to the right one.
    if (error instanceof PatternBudgetExceededError) {
      return undefined;
    }
    throw error;
  }
}

interface UpstreamTarget {
  readonly function?: string | undefined;
  readonly scopeId?: string | undefined;
}

/**
 * Send a request to the deployment's app Worker: `target` names which, for a deployment split across
 * several, and the first is meant without it, and its scope where the manifest names another.
 * A deployment that was not split is one property read away from what it always was.
 */
export function fetchUpstream(
  runtime: EdgeRuntime,
  app: AppRuntime | undefined,
  request: Request,
  target?: UpstreamTarget,
): Promise<Response> {
  if (app === undefined) {
    return unsent(new NoApplicationError());
  }
  if (runtime.dispatchApp === undefined) {
    return unsent(new NoDispatchError());
  }
  // Told where the deployment's scope stands, as this isolate last found it: a Function behind it
  // catches up before it judges anything (`SCOPE_REVISION_HEADER`). Its manifest can name a scope
  // different from the deployment id used while the manifest is still being read.
  const told = withScopeRevision(runtime, target?.scopeId ?? app.deploymentId, request);
  if (app.functions === undefined) {
    // Catch only the synchronous call; awaiting or observing it would wrap its normal promise.
    // eslint-disable-next-line sonarjs/no-try-promise
    try {
      return runtime.dispatchApp(app.scriptName, told);
    } catch (error) {
      // Preserve the host's failure value, as the split async dispatcher does.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      return Promise.reject(error);
    }
  }
  return dispatchSplitApp(runtime.dispatchApp, app, told, target?.function);
}
