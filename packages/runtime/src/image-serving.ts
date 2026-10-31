import type { ImagesConfig } from '@stayingupwind/core/images';
import { ROUTED_HEADER } from '@stayingupwind/core/paas';

import type { Routed } from './handoff.ts';
import { openImageCache } from './image-cache.ts';
import {
  applicationHosts,
  fetchRemoteSource,
  imageCacheInputOf,
  imageFallback,
  sourceRequest,
  sourceResponse,
} from './image-fallback.ts';
import { misdirectedTo } from './placement.ts';
import type { RoutedInput } from './serve.ts';
import { sourceInput } from './source-input.ts';
import type { Store } from './store.ts';

/**
 * The source `/_next/image` names, unresized; the edge does the optimizing. The request is what
 * routing resolved — a rewrite may have led here. A path of the application is routed in full,
 * its middleware included: what protects `/private/avatar.png` protects it behind the optimizer
 * too, as under Next.js, whose optimizer asks its router the same way. Nothing of the client's
 * request goes to a URL of the internet, nor to the application.
 */
export async function serveImageSource(options: {
  readonly input: RoutedInput;
  readonly store: Store;
  readonly images: ImagesConfig;
  readonly routed: Pick<Routed, 'resolved' | 'source'>;
  readonly routeSource: (input: RoutedInput) => Promise<Response>;
}): Promise<Response> {
  const { input, store, images, routed, routeSource } = options;
  const { resolved } = routed;
  const { request } = input;
  const query = new URL(resolved.url, request.url).searchParams;
  const fallback = imageFallback(request, query, images);
  if (fallback.kind === 'response') {
    return fallback.response;
  }
  const { params } = fallback;
  // Looked up before its source is asked for, where the target keeps images (`image-cache.ts`).
  const cacheInput = imageCacheInputOf(input, store.manifest, params, images);
  const opening = openImageCache(cacheInput);
  const slot = opening === undefined ? undefined : await opening;
  if (slot?.hit !== undefined) return slot.hit;
  const keep = slot?.keep;
  if (fallback.kind === 'remote') {
    const remote = await fetchRemoteSource({
      href: params.href,
      images,
      ownHosts: applicationHosts(request),
    });
    return remote.kind === 'refused'
      ? remote.response
      : sourceResponse({ source: remote.response, params, images, internal: false, request, keep });
  }
  const source = sourceRequest(request, params.href);
  // Routed already, by the Function that handed the image here: answered from there.
  if (routed.source !== undefined) {
    source.headers.set(ROUTED_HEADER, routed.source);
  }
  const answered = await routeSource(sourceInput(input, source));
  // A source another app Function holds is that Function's to fetch: the request for the image goes
  // there whole, and its source is local when it arrives (`answerResolved`).
  if (misdirectedTo(answered) !== undefined) {
    return answered;
  }
  return sourceResponse({
    source: answered,
    params,
    images,
    internal: true,
    request,
    keep,
    publicationProtected: cacheInput.publicationProtected,
  });
}
