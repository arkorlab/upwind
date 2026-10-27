import type { ImagesConfig } from '@stayingupwind/core/images';

import type { BuildContext } from '../collect.ts';

/**
 * What the native manifest says of the images the server keeps (`runtime/src/native/image-cache.ts`):
 * the most bytes of them, where the build has an optimizer and the application set
 * `images.maximumDiskCacheSize` — `0` keeps none. Absent, the server keeps half the disk free where
 * they are kept, as `next start` does.
 */
export interface ImageCacheField {
  readonly imageCacheBytes?: number;
}

export function imageCacheField(
  ctx: BuildContext,
  images: ImagesConfig | undefined,
): ImageCacheField {
  const bytes = images === undefined ? undefined : ctx.config.images.maximumDiskCacheSize;
  return bytes === undefined ? {} : { imageCacheBytes: bytes };
}
