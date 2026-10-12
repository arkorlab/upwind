import { budgetPatterns } from '@stayingupwind/core/request';

import { notFoundResponse, serviceUnavailableResponse } from '../handlers/responses.ts';
import type { IncomingRequest } from '../request-context.ts';
import { serveFromPointer } from '../route.ts';
import type { StandaloneEnv } from './env.ts';
import { standaloneHost } from './host.ts';
import { standalonePointer } from './pointer.ts';
import { standaloneRuntime } from './runtime.ts';

/**
 * A request to a site served by a standalone edge: its pointer read, and the edge's delivery path
 * from there (`serveFromPointer`). Every hostname the edge is routed is the site's.
 */
export async function handleStandalone(
  request: IncomingRequest,
  env: StandaloneEnv,
  ctx: ExecutionContext,
  runtime = standaloneRuntime(env),
): Promise<Response> {
  // Every test of an application's routing pattern is bounded, as wherever the edge runs: one past
  // what a test is allowed hands the request to the application's Function (`budgetPatterns`).
  budgetPatterns();
  const url = new URL(request.url);
  const pointerStarted = runtime.now();
  const pointer = await standalonePointer(env, runtime, ctx);
  switch (pointer.kind) {
    case 'found': {
      return serveFromPointer({
        request,
        url,
        env,
        ctx,
        runtime,
        host: standaloneHost(env),
        pointer: pointer.value,
        pointerMs: runtime.now() - pointerStarted,
        privateDelivery: false,
        cspReportingPath: undefined,
      });
    }
    case 'missing': {
      return notFoundResponse('no-pointer');
    }
    case 'unavailable': {
      return serviceUnavailableResponse('pointer-unavailable');
    }
  }
}
