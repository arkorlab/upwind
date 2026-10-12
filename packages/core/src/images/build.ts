import { runnableImageRegexSchema } from '../request/pattern-safety.ts';
import * as z from '../schema/index.ts';
import {
  imageFormatSchema,
  type ImageLocalPattern,
  imageLocalPatternSchema,
  imageRemotePatternSchema,
  type ImagesConfig,
  imagesConfigSchema,
} from './config.ts';

/**
 * The image configuration where it is written: read from what `next build` leaves, and checked as
 * an upload takes it. Apart from what a deployment reads at request time (`config.ts`), so that a
 * reader does not build these schemas, nor the pattern checks behind them, with that one.
 */

/**
 * The configuration as a build writes it and an upload takes it: every pattern checked to compile,
 * and to be one the edge may run against the hostname and path of a source a visitor named.
 */
export const checkedImagesConfigSchema = imagesConfigSchema.extend({
  remotePatterns: z.array(
    imageRemotePatternSchema.extend({
      hostname: runnableImageRegexSchema,
      pathname: runnableImageRegexSchema,
    }),
  ),
  localPatterns: z.array(imageLocalPatternSchema.extend({ pathname: runnableImageRegexSchema })),
});

/** `images-manifest.json` as `next build` writes it; only what is read here is named. */
const nextImagesSchema = z.looseObject({
  path: z.string(),
  loader: z.string(),
  loaderFile: z.string().optional(),
  unoptimized: z.boolean().optional(),
  deviceSizes: z.array(z.number()),
  imageSizes: z.array(z.number()),
  qualities: z.array(z.number()).optional(),
  formats: z.array(z.string()),
  minimumCacheTTL: z.number(),
  maximumRedirects: z.number().optional(),
  maximumResponseBody: z.number().optional(),
  remotePatterns: z.array(imageRemotePatternSchema),
  domains: z.array(z.string()).optional(),
  localPatterns: z.array(imageLocalPatternSchema).optional(),
  dangerouslyAllowSVG: z.boolean(),
  dangerouslyAllowLocalIP: z.boolean().optional(),
  contentSecurityPolicy: z.string(),
  contentDispositionType: z.enum(['inline', 'attachment']),
});
const nextImagesManifestSchema = z.object({ version: z.number(), images: nextImagesSchema });

const DEFAULT_MAXIMUM_REDIRECTS = 3;
const DEFAULT_MAXIMUM_RESPONSE_BODY = 50_000_000;
/**
 * A manifest that names no local patterns at all: Next.js then admits any local source, query
 * string included (`hasLocalMatch` with nothing configured). Its own default configuration does
 * name one — any pathname, no query string — and arrives here as such.
 */
const ANY_LOCAL_PATH: ImageLocalPattern = { pathname: '^.*$' };

/**
 * The image configuration a deployment needs at request time, from the build's manifest — or
 * `undefined` when nothing can ask for `/_next/image`: `unoptimized`, or a `loader` of `custom`,
 * which is where Next.js refuses to emit an optimizer URL at all.
 *
 * A `loaderFile` is *not* one of those, though it looks like one. Next.js allows it beside
 * `loader: 'default'` — only another value is refused (`server/config.ts`, "cannot be used with
 * images.loaderFile property") — and a file kept there is free to return an optimizer URL, which
 * is exactly what the upstream fixture `loader-config-default-loader-with-file` does: its loader
 * returns `/_next/image/?url=…`, and its test is named for the optimization it leaves enabled.
 * Read as meaning otherwise, such a build recorded no configuration and every one of its images
 * came back a miss.
 */
export function imagesConfigFromNextManifest(
  manifest: unknown,
  basePath: string,
): ImagesConfig | undefined {
  const parsed = nextImagesManifestSchema.safeParse(manifest);
  if (!parsed.success) {
    return undefined;
  }
  const { images } = parsed.data;
  if (images.loader !== 'default' || images.unoptimized === true) {
    return undefined;
  }
  return checkedImagesConfigSchema.parse({
    path: images.path,
    basePath,
    sizes: [...images.deviceSizes, ...images.imageSizes],
    ...(images.qualities !== undefined && { qualities: images.qualities }),
    formats: images.formats.filter((format) => imageFormatSchema.safeParse(format).success),
    minimumCacheTTL: images.minimumCacheTTL,
    maximumRedirects: images.maximumRedirects ?? DEFAULT_MAXIMUM_REDIRECTS,
    maximumResponseBody: images.maximumResponseBody ?? DEFAULT_MAXIMUM_RESPONSE_BODY,
    remotePatterns: images.remotePatterns,
    domains: images.domains ?? [],
    localPatterns: images.localPatterns ?? [ANY_LOCAL_PATH],
    dangerouslyAllowSVG: images.dangerouslyAllowSVG,
    dangerouslyAllowLocalIP: images.dangerouslyAllowLocalIP ?? false,
    contentSecurityPolicy: images.contentSecurityPolicy,
    contentDispositionType: images.contentDispositionType,
  });
}
