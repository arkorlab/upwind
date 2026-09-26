import { z } from 'zod';

import { runnableSourceRegexSchema } from '../request/pattern-safety.ts';

/**
 * What `next/image` asks the platform to enforce behind `/_next/image`, as `next build` writes it
 * to `images-manifest.json`: the sizes and qualities a request may name, the sources it may name
 * (compiled to regular expressions by the build, so no glob matcher is needed here), and the
 * headers the optimized response carries.
 *
 * The patterns are checked — to compile, and to be safe to run on a shared Function — where the
 * configuration is written: by the build, and at the upload, as every pattern a bundle carries is
 * (`checkedImagesConfigSchema`). They are read
 * as they were written: a manifest carries what its upload checked, and a reader that checked
 * again would refuse, with the whole manifest, one written before the check was.
 */

const MAX_QUALITY = 100;

const imageRemotePatternSchema = z.object({
  protocol: z.enum(['http', 'https']).optional(),
  hostname: z.string().min(1),
  port: z.string().optional(),
  pathname: z.string().min(1),
  search: z.string().optional(),
});
export type ImageRemotePattern = z.infer<typeof imageRemotePatternSchema>;

const imageLocalPatternSchema = z.object({
  pathname: z.string().min(1),
  search: z.string().optional(),
});
export type ImageLocalPattern = z.infer<typeof imageLocalPatternSchema>;

const imageFormatSchema = z.enum(['image/avif', 'image/webp']);
export type ImageFormat = z.infer<typeof imageFormatSchema>;

export const imagesConfigSchema = z.object({
  /** The pathname the loader requests, `basePath` included: `/_next/image`. */
  path: z.string().startsWith('/'),
  basePath: z.string(),
  /** `deviceSizes` and `imageSizes` together: the widths a request may ask for. */
  sizes: z.array(z.number().int().positive()).min(1),
  /** The qualities a request may ask for; absent, any of 1–100. */
  qualities: z.array(z.number().int().min(1).max(MAX_QUALITY)).optional(),
  /** The formats served to a client that accepts them, in the application's order of preference. */
  formats: z.array(imageFormatSchema),
  minimumCacheTTL: z.number().int().nonnegative(),
  maximumRedirects: z.number().int().nonnegative(),
  maximumResponseBody: z.number().int().positive(),
  remotePatterns: z.array(imageRemotePatternSchema),
  /** The deprecated `images.domains`, still admitted by Next.js alongside the patterns. */
  domains: z.array(z.string()),
  localPatterns: z.array(imageLocalPatternSchema),
  /**
   * The application asked for private destinations to be reachable. Next.js defaults it to false
   * and so does this: an allowed remote host that redirects to a loopback or private address, or a
   * pattern that admits one outright, would otherwise make the optimizer a way for anyone to reach
   * whatever the platform can.
   */
  dangerouslyAllowLocalIP: z.boolean().default(false),
  dangerouslyAllowSVG: z.boolean(),
  contentSecurityPolicy: z.string(),
  contentDispositionType: z.enum(['inline', 'attachment']),
});
export type ImagesConfig = z.infer<typeof imagesConfigSchema>;

/**
 * The configuration as a build writes it and an upload takes it: every pattern checked to compile,
 * and to be one the edge may run against the hostname and path of a source a visitor named.
 */
export const checkedImagesConfigSchema = imagesConfigSchema.extend({
  remotePatterns: z.array(
    imageRemotePatternSchema.extend({
      hostname: runnableSourceRegexSchema,
      pathname: runnableSourceRegexSchema,
    }),
  ),
  localPatterns: z.array(imageLocalPatternSchema.extend({ pathname: runnableSourceRegexSchema })),
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
