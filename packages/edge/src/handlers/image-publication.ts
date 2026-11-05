import {
  admitPublication,
  isPublicationTag,
  parseCacheTagsHeader,
  publicationDeadline,
  publicationExpired,
  publicationTimeFor,
  resourceSnapshotOf,
} from '@stayingupwind/core/cache';
import type { ProjectManifest } from '@stayingupwind/core/manifest';
import { enforcePublicationPolicy } from '@stayingupwind/core/paas';
import { releaseStream } from '@stayingupwind/core/util';

import type { ImageInput } from './image.ts';

interface ImagePublicationInput {
  readonly manifest: ProjectManifest;
  readonly edge: { readonly runtime: { readonly now: () => number } };
}

/** Validate every reserved witness before deciding whether an anonymous source has bounded data. */
export function imageSourceTags(response: Response): string[] {
  const tags = parseCacheTagsHeader(response.headers.get('x-next-cache-tags') ?? undefined);
  const witnesses = tags.map((tag) => resourceSnapshotOf(tag));
  return tags.some((tag) => isPublicationTag(tag)) || witnesses.some((value) => value !== undefined)
    ? tags
    : [];
}

export function imagePublicationNow(input: ImagePublicationInput): number {
  return publicationTimeFor(
    input.manifest.publication ?? input.edge.runtime,
    input.edge.runtime.now(),
  );
}

export function imageSourceExpired(input: ImagePublicationInput, tags: readonly string[]): boolean {
  return publicationExpired(tags, imagePublicationNow(input));
}

export function imageMayCache(input: ImageInput, tags: readonly string[]): boolean {
  return !input.edge.validated && input.middleware === undefined && tags.length === 0;
}

/** Large transformed output keeps the source deadline through every downstream read. */
function imagePublicationStream(
  input: ImagePublicationInput,
  body: ReadableStream<Uint8Array>,
  tags: readonly string[],
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const expired = (controller: ReadableStreamDefaultController<Uint8Array>): boolean => {
    if (!imageSourceExpired(input, tags)) return false;
    releaseStream(reader, 'Publication unavailable');
    controller.error(new Error('Publication unavailable'));
    return true;
  };
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (expired(controller)) return;
        const next = await reader.read();
        if (expired(controller)) return;
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      },
      cancel: (reason: unknown) => reader.cancel(reason),
    },
    { highWaterMark: 0 },
  );
}

/** Reapply the source's absolute proof after configured headers, async work and 304 selection. */
export function admitImagePublication(
  input: ImagePublicationInput,
  response: Response,
  tags: readonly string[],
): Response {
  if (tags.length === 0) return response;
  response.headers.set('x-next-cache-tags', tags.join(','));
  const now = imagePublicationNow(input);
  const admitted = admitPublication(response, tags, now, {
    clockOwner: input.manifest.publication ?? input.edge.runtime,
  });
  enforcePublicationPolicy(admitted.headers, { mode: 'no-store', noTransform: false });
  if (
    admitted.body !== null &&
    publicationDeadline(tags) !== undefined &&
    !publicationExpired(tags, now)
  )
    return new Response(
      imagePublicationStream(input, admitted.body as ReadableStream<Uint8Array>, tags),
      admitted,
    );
  return admitted;
}
