import {
  INVALIDATED_REVISION_HEADER,
  INVALIDATED_TAGS_HEADER,
  invalidatedTagsValue,
} from '@stayingupwind/core/paas';
import { releaseStream } from '@stayingupwind/core/util';

import type { InvalidatedTags, RequestWrites } from './cache/context.ts';

/** A `HEAD` is answered with the response's status and headers alone, whatever produced it. */
export function withoutBody(request: Request, response: Response): Response {
  if (request.method !== 'HEAD' || response.body === null) {
    return response;
  }
  // Released, not awaited: a stalled cancellation must not hold back completed headers.
  releaseStream(response.body, 'HEAD: body not sent');
  return new Response(null, response);
}

/**
 * How long a response waits, before it is answered at all, for the host to record the
 * invalidations its request asked for (`InvalidatedTags.recorded`): past this it is answered all
 * the same, and they go on in `waitUntil` as they did.
 */
export const INVALIDATIONS_RECORDED_WITHIN_MS = 2000;

/**
 * `response`, telling the edge the tags the request invalidated at once
 * (`INVALIDATED_TAGS_HEADER`): those invalidated before its headers were written, which for a
 * Server Action that answers with the page it changed is every one — Next.js applies what the
 * action invalidated before it renders — and for a route handler, whose revalidations Next.js runs
 * behind its response, every one the host recorded while its headers waited
 * (`INVALIDATIONS_RECORDED_WITHIN_MS`). Never what the application said under that name, which is
 * the platform's to say.
 */
export function withInvalidatedTags(response: Response, invalidated: InvalidatedTags): Response {
  const { tags, revision } = invalidated;
  const said =
    response.headers.has(INVALIDATED_TAGS_HEADER) ||
    response.headers.has(INVALIDATED_REVISION_HEADER);
  // A network error (`Response.error()`, status 0) has no headers to carry anything on.
  if (response.status === 0 || (!said && tags.size === 0)) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.delete(INVALIDATED_TAGS_HEADER);
  headers.delete(INVALIDATED_REVISION_HEADER);
  if (tags.size > 0) {
    headers.set(INVALIDATED_TAGS_HEADER, invalidatedTagsValue(tags));
    if (revision !== undefined) {
      headers.set(INVALIDATED_REVISION_HEADER, String(revision));
    }
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * How long the end of a response waits for the cache writes its request handed over behind it
 * (`RequestWrites`): past this its body ends all the same, and the writes go on in `waitUntil` as
 * they did. Shorter than a write waits for the one of its key ahead of it (`WRITE_PATIENCE_MS`).
 */
export const WRITES_LAND_WITHIN_MS = 2000;

/**
 * `response`, ending only once the cache writes its request handed over have landed
 * (`RequestWrites`), or `WRITES_LAND_WITHIN_MS` have gone by. The bytes pass as they come: the
 * first byte is not held, the end is. A response without a body ends with its headers, so those
 * wait instead — a redirect, or a `204`, that the request wrote behind — where any write is out.
 *
 * A body of a stated length ends at its last byte for whoever reads it, whatever its stream does
 * after, and writes can be handed over until that byte — the Node bridge answers once the headers
 * are committed — so the response goes without one, and its end is the stream's. It is made from
 * the response itself, which keeps what a runtime holds of one beside its status and headers: on
 * workerd, a body the application encoded itself (`encodeBody: 'manual'`).
 */
export async function withWritesLanded(
  response: Response,
  writes: RequestWrites,
): Promise<Response> {
  if (response.body === null) {
    await writes.landed(WRITES_LAND_WITHIN_MS);
    return response;
  }
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      flush: () => writes.landed(WRITES_LAND_WITHIN_MS),
    }),
  );
  const held = new Response(body, response);
  held.headers.delete('content-length');
  return held;
}
