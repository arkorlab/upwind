import type { Prerender } from '@stayingupwind/core/bundle';
import {
  publicationExpired,
  publicationForBuild,
  admitPublication,
  parseCacheTagsHeader,
  publicationForRoute,
} from '@stayingupwind/core/cache';

import type { RoutedInput } from './serve.ts';
const HTTP_CLIENT_ERROR = 400;

import { nowMs } from './cache/clock.ts';
import {
  INVALIDATIONS_RECORDED_WITHIN_MS,
  type RequestContext,
  requestContext,
} from './cache/context.ts';
import type { CacheRuntime } from './cache/runtime.ts';

export function requirePublication(runtime: CacheRuntime | undefined, route: string): void {
  const context = requestContext();
  const required = publicationForRoute(runtime?.host.publication, route);
  if (context !== undefined && required !== undefined) context.publicationRequirement = required;
}

export function admitRequestPublication(response: Response, context: RequestContext): Response {
  const tags = [
    ...context.publication,
    ...parseCacheTagsHeader(response.headers.get('x-next-cache-tags') ?? undefined),
  ];
  const required = response.status < HTTP_CLIENT_ERROR ? context.publicationRequirement : undefined;
  return admitPublication(response, tags, nowMs(), required);
}

export async function onceRecorded(
  context: RequestContext,
  routed: Promise<Response>,
): Promise<Response> {
  try {
    return await routed;
  } finally {
    await context.invalidated.recorded(INVALIDATIONS_RECORDED_WITHIN_MS);
  }
}

export function buildPublicationExpired(
  input: RoutedInput,
  shell: Prerender | undefined,
  route: string,
): boolean {
  const tags = parseCacheTagsHeader(
    new Headers(shell?.initialHeaders as HeadersInit).get('x-next-cache-tags') ?? undefined,
  );
  const expired = publicationExpired(
    tags,
    nowMs(),
    publicationForBuild(input.cache?.host.publication, route),
  );
  if (
    !expired &&
    shell !== undefined &&
    input.cache?.host.publication?.independentBuild?.includes(route) === true
  ) {
    const context = requestContext();
    if (context !== undefined) delete context.publicationRequirement;
  }
  return expired;
}
