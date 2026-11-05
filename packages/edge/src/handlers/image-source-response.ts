import { limitBody, releaseStream } from '@stayingupwind/core/util';

import { imageSourceTags } from './image-publication.ts';
import type { SourceResult } from './image-source.ts';

const HTTP_BAD_REQUEST = 400;
const HTTP_PAYLOAD_TOO_LARGE = 413;

function refused(status: number, message: string, requests: number): SourceResult {
  return { kind: 'error', error: { status, message, requests } };
}

export function acceptedImageSource(
  response: Response,
  limit: number,
  message: string,
  requests: number,
): SourceResult {
  const declared = response.headers.get('content-length');
  if (declared !== null && Number.parseInt(declared, 10) > limit) {
    releaseStream(response.body, 'image source too large');
    return refused(HTTP_PAYLOAD_TOO_LARGE, message, requests);
  }
  if (response.body === null) {
    return refused(HTTP_BAD_REQUEST, message, requests);
  }
  let publication: readonly string[];
  try {
    publication = imageSourceTags(response);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    releaseStream(response.body, 'image source publication refused');
    return refused(HTTP_BAD_REQUEST, message, requests);
  }
  return {
    kind: 'ok',
    source: {
      body: limitBody(response.body as ReadableStream<Uint8Array>, limit),
      cacheControl: response.headers.get('cache-control'),
      etag: response.headers.get('etag'),
      requests,
      publication,
    },
  };
}
