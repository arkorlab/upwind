import {
  type AppRuntime,
  functionFor,
  isReserved,
  type ProjectManifest,
  rootRewriteEntry,
} from '@stayingupwind/core/manifest';
import {
  acceptsHtml,
  PatternBudgetExceededError,
  PREFETCH_HINT_HEADERS,
} from '@stayingupwind/core/request';

import { withScopeRevision } from '../cache/scope-signal.ts';
import type { DispatchApp, EdgeRuntime } from '../edge-runtime.ts';
import { inDispatchSpan } from '../observability/spans.ts';
import { stampLogCorrelation } from '../request-context.ts';
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
  reason?: string,
): string | undefined {
  if (manifest === undefined || app?.functions === undefined) {
    return undefined;
  }
  try {
    const url = new URL(request.url);
    const owner = functionFor(manifest, url, request.headers, request.method);
    // Only ordinary HTML clients with no Fetch Metadata take this fallback. The selected Worker
    // still runs middleware on the original request, including locale redirects and cookies.
    if (
      owner !== undefined ||
      reason !== 'sec-fetch-dest' ||
      manifest.rootRewriteHint === undefined ||
      url.pathname !== '/' ||
      request.method !== 'GET'
    )
      return owner;
    const { headers } = request;
    if (
      headers.has('sec-fetch-dest') ||
      headers.has('sec-fetch-mode') ||
      PREFETCH_HINT_HEADERS.some((name) => headers.has(name)) ||
      !acceptsHtml(headers.get('accept')) ||
      isReserved(manifest, url, headers, false)
    )
      return undefined;
    return rootRewriteEntry(manifest)?.function;
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
  readonly continuation?: true;
  readonly function?: string | undefined;
  readonly scopeId?: string | undefined;
  readonly logCorrelationId?: (() => string) | undefined;
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
  const { dispatchApp, tracing } = runtime;
  if (dispatchApp === undefined) {
    return unsent(new NoDispatchError());
  }
  // Told where the deployment's scope stands, as this isolate last found it: a Function behind it
  // catches up before it judges anything (`SCOPE_REVISION_HEADER`). Its manifest can name a scope
  // different from the deployment id used while the manifest is still being read.
  const told = withScopeRevision(runtime, target?.scopeId ?? app.deploymentId, request);
  stampLogCorrelation(told, target?.logCorrelationId);
  // Trace each actual attempt. A split request's own promise identifies its progress even
  // while a second attempt is pending, and an unsent request above keeps its own identity.
  const dispatch: DispatchApp =
    tracing === undefined
      ? dispatchApp
      : (script, forwarded) => {
          const operation = target?.continuation === true ? 'edge.resume' : 'edge.dispatch';
          return inDispatchSpan(tracing, operation, () =>
            dispatchApp.call(runtime, script, forwarded),
          );
        };
  if (app.functions === undefined) {
    // Catch only the synchronous call; awaiting or observing it would wrap its normal promise.
    // eslint-disable-next-line sonarjs/no-try-promise
    try {
      return dispatch.call(runtime, app.scriptName, told);
    } catch (error) {
      // Preserve the host's failure value, as the split async dispatcher does.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      return Promise.reject(error);
    }
  }
  return dispatchSplitApp(dispatch, app, told, target?.function);
}
