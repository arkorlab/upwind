import { completeAppPageBody, type Prerender } from '@stayingupwind/core/bundle';
import { parseCacheTagsHeader } from '@stayingupwind/core/cache';
import { NO_STORE_CACHE_CONTROL, NULL_BODY_STATUSES } from '@stayingupwind/core/request';

import { admitBuildPublication } from './publication.ts';
import {
  type HTML_CONTENT_TYPE,
  prerenderHeaders,
  type RoutedInput,
  RSC_CONTENT_TYPE,
  staticResponse,
  withCacheState,
} from './serve.ts';
import { hasBundleBlob, type Store } from './store.ts';

const CACHE_TAGS = 'x-next-cache-tags';

interface PageAnswer {
  readonly document: Prerender;
  readonly contentType: typeof HTML_CONTENT_TYPE | typeof RSC_CONTENT_TYPE;
  readonly status: number;
  readonly allowHost: boolean;
}

/**
 * The existing synchronous response for shipped bytes. Only a missing, completed Node App page
 * body may fall back to its immutable bundle blob, after the caller selected the build rather
 * than a newer generation or a bypass render. A missing shell, error output or postponed state
 * remains the build failure it was; a host read never substitutes a new render for old bytes.
 * Whole Flight responses retain their build status (normally 200): redirects and not-found are
 * encoded in the payload for the client's router, not re-rendered under a document status.
 */
export function builtPageResponse(
  input: RoutedInput,
  store: Store,
  prerender: Prerender,
  how: PageAnswer,
): Response | Promise<Response> {
  const finish = (response: Response): Response => {
    if (how.contentType === RSC_CONTENT_TYPE) {
      response.headers.delete('link');
      response.headers.set('cache-control', NO_STORE_CACHE_CONTROL);
      response.headers.set('vary', store.manifest.routing.rsc.varyHeader);
    }
    return admitBuildPublication(input, how.document.route, withCacheState(response, 'HIT'), [
      ...parseCacheTagsHeader(
        new Headers(how.document.initialHeaders as HeadersInit).get(CACHE_TAGS) ?? undefined,
      ),
      ...parseCacheTagsHeader(
        new Headers(prerender.initialHeaders as HeadersInit).get(CACHE_TAGS) ?? undefined,
      ),
    ]);
  };
  if (input.request.method === 'HEAD') {
    // A configured reader can supply an omitted body without HEAD fetching it. With no reader,
    // local metadata is enough to reject a representation that neither source can provide.
    if (
      prerender.body !== undefined &&
      !NULL_BODY_STATUSES.has(how.status) &&
      input.blobs === undefined &&
      !hasBundleBlob(prerender.body.sha256)
    )
      throw new Error(
        'next-runtime: required built page body is unavailable without a blob reader',
      );
    return finish(
      new Response(null, {
        status: how.status,
        headers: prerenderHeaders(prerender, how.contentType),
      }),
    );
  }
  try {
    return finish(staticResponse(store, prerender, how.contentType, how.status));
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !('code' in error) ||
      error.code !== 'ENOENT' ||
      !how.allowHost ||
      !completeAppPageBody({
        prerender,
        document: how.document,
        entry: store.manifest.entrypoints.find((entry) => entry.pathname === prerender.route),
        basePath: store.manifest.config.basePath,
        rscSuffix: store.manifest.routing.rsc.suffix,
      })
    ) {
      throw error;
    }
  }
  return hostedPageResponse(input, prerender, how, finish);
}

async function hostedPageResponse(
  input: RoutedInput,
  prerender: Prerender,
  how: PageAnswer,
  finish: (response: Response) => Response,
): Promise<Response> {
  const body = await requiredBody(input, prerender);
  return finish(
    new Response(body, {
      status: how.status,
      headers: prerenderHeaders(prerender, how.contentType),
    }),
  );
}

async function requiredBody(
  input: RoutedInput,
  prerender: Prerender,
): Promise<Uint8Array<ArrayBuffer>> {
  const ref = prerender.body;
  if (ref === undefined) throw new Error('next-runtime: required built page body is unnamed');
  const bytes = await input.blobs?.(ref.sha256, ref.byteLength);
  if (bytes?.byteLength !== ref.byteLength) {
    throw new Error('next-runtime: required built page body is unavailable or has the wrong size');
  }
  // Host buffers may use ArrayBufferLike. Only this slow path needs a separate response buffer.
  return new Uint8Array(bytes);
}
