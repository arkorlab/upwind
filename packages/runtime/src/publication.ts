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
import { admitPublicationStream } from './publication-stream.ts';
import type { RoutedInput } from './serve.ts';

const CACHE_TAGS = 'x-next-cache-tags';

export function requirePublication(runtime: CacheRuntime | undefined, route: string): void {
  const context = requestContext();
  const required = publicationForRoute(runtime?.host.publication, route);
  if (context !== undefined && required !== undefined) {
    context.publicationRequirement = required;
    // The explicit v2 capability proves before-value instrumentation, even when an outer
    // Suspense boundary flushes before its protected descendant has started its first read.
    if (required.version === 2) context.publicationReadStarted = true;
  }
}

export function admitRequestPublication(response: Response, context: RequestContext): Response {
  const tags = [
    ...context.publication,
    ...parseCacheTagsHeader(response.headers.get(CACHE_TAGS) ?? undefined),
  ];
  const independent =
    context.publicationRequirement !== undefined &&
    buildPublicationOf(response) === context.publicationRequirement;
  if (independent) return admitPublication(response, tags, nowMs());
  const required = context.publicationRequirement;
  if (context.publicationReadStarted || context.publication.size > 0)
    return admitPublicationStream(
      response,
      context,
      parseCacheTagsHeader(response.headers.get(CACHE_TAGS) ?? undefined),
      required,
    );
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
    new Headers(shell?.initialHeaders as HeadersInit).get(CACHE_TAGS) ?? undefined,
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
