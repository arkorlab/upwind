import {
  isPublicationTag,
  parseCacheTagsHeader,
  type PublicationRequirement,
} from '@stayingupwind/core/cache';
import type { ImageRequestParams } from '@stayingupwind/core/images';

/** A local dynamic source may resolve through rewrites; no image hit may skip its publication read. */
export function protectedImageSource(
  params: ImageRequestParams,
  required: PublicationRequirement | undefined,
): boolean {
  return required !== undefined && !params.isAbsolute && !params.isStatic;
}

export function imagePublicationTags(source: Response): string[] {
  return parseCacheTagsHeader(source.headers.get('x-next-cache-tags') ?? undefined).filter((tag) =>
    isPublicationTag(tag),
  );
}

/** Image derivatives retain the source's bound and never acquire the optimizer's minimum TTL. */
export function imagePublicationHeaders(
  headers: Headers,
  publication: readonly string[],
  protectedSource: boolean | undefined,
): boolean {
  if (protectedSource !== true && publication.length === 0) return false;
  headers.set('cache-control', 'private, no-store');
  if (publication.length > 0) headers.set('x-next-cache-tags', publication.join(','));
  return true;
}
