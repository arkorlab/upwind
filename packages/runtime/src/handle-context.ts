import { nowMs } from './cache/clock.ts';
import { requestContextFor } from './cache/context.ts';
import { catchUpWithScope } from './cache/pulls.ts';
import { initUrlOf } from './incoming.ts';
import { withoutPlacementHeaders } from './placement.ts';
import {
  INVALIDATIONS_RECORDED_WITHIN_MS,
  withInvalidatedTags,
  withoutBody,
  withWritesLanded,
} from './response.ts';
import type { HandleInput, RoutedInput } from './serve.ts';

export async function handleRequestWith(
  handled: HandleInput,
  route: (input: RoutedInput) => Promise<Response>,
): Promise<Response> {
  const context = requestContextFor({
    tables: { app: handled.app, edge: handled.edge },
    runtime: handled.cache,
    request: handled.request,
    startedAt: handled.clock ?? nowMs(),
    waitUntil: handled.waitUntil,
    clock: handled.clock,
    invalidated: handled.invalidated,
  });
  const input: RoutedInput = { ...handled, initURL: initUrlOf(handled.request), run: context.run };
  return context.run(async () => {
    if (handled.cache !== undefined) {
      await catchUpWithScope(handled.cache, handled.request, handled.waitUntil);
    }
    const response = withoutPlacementHeaders(await route(input));
    // Not answered before the host has recorded what the request invalidated — its headers neither:
    // whoever made it moves on once they come (`InvalidatedTags`).
    await context.invalidated.recorded(INVALIDATIONS_RECORDED_WITHIN_MS);
    const answered = withoutBody(
      handled.request,
      withInvalidatedTags(response, context.invalidated),
    );
    // Without a cache there is nothing to write, and nothing to wait for.
    return handled.cache === undefined ? answered : withWritesLanded(answered, context.writes);
  });
}
