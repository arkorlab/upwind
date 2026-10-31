import type { Prerender } from '@stayingupwind/core/bundle';
import {
  publicationExpired,
  publicationForBuild,
  admitPublication,
  parseCacheTagsHeader,
  publicationForRoute,
} from '@stayingupwind/core/cache';
import { observePublicationTags } from '@stayingupwind/core/paas';

import { nowMs } from './cache/clock.ts';
import {
  INVALIDATIONS_RECORDED_WITHIN_MS,
  type RequestContext,
  requestContext,
} from './cache/context.ts';
import type { CacheRuntime } from './cache/runtime.ts';
import { buildPublicationOf, markBuildPublication } from './publication-proof.ts';
import type { RoutedInput } from './serve.ts';

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
  const required =
    buildPublicationOf(response) === context.publicationRequirement
      ? undefined
      : context.publicationRequirement;
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
  return publicationExpired(
    tags,
    nowMs(),
    publicationForBuild(input.cache?.host.publication, route),
  );
}

/** A shipped-data proof belongs only to the actual response selected from that build. */
export function admitBuildPublication(
  input: RoutedInput,
  route: string,
  response: Response,
  tags: readonly string[],
): Response {
  const publication = input.cache?.host.publication;
  const required = publicationForBuild(publication, route);
  const admitted = admitPublication(response, tags, nowMs(), required);
  observePublicationTags(tags);
  const proof = publicationForRoute(publication, route);
  if (proof !== undefined && required === undefined) markBuildPublication(admitted, proof);
  return admitted;
}
