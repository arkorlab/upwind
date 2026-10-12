import * as z from '../schema/index.ts';

/**
 * What `next/image` asks the platform to enforce behind `/_next/image`, as `next build` writes it
 * to `images-manifest.json`: the sizes and qualities a request may name, the sources it may name
 * (compiled to regular expressions by the build, so no glob matcher is needed here), and the
 * headers the optimized response carries.
 *
 * The patterns are checked — to compile, and to be safe to run on a shared Function — where the
 * configuration is written: by the build, and at the upload, as every pattern a bundle carries is
 * (`checkedImagesConfigSchema`, in `build.ts`). They are read
 * as they were written: a manifest carries what its upload checked, and a reader that checked
 * again would refuse, with the whole manifest, one written before the check was.
 */

const MAX_QUALITY = 100;

export const imageRemotePatternSchema = z.object({
  protocol: z.enum(['http', 'https']).optional(),
  hostname: z.string().min(1),
  port: z.string().optional(),
  pathname: z.string().min(1),
  search: z.string().optional(),
});
export type ImageRemotePattern = z.infer<typeof imageRemotePatternSchema>;

export const imageLocalPatternSchema = z.object({
  pathname: z.string().min(1),
  search: z.string().optional(),
});
export type ImageLocalPattern = z.infer<typeof imageLocalPatternSchema>;

export const imageFormatSchema = z.enum(['image/avif', 'image/webp']);
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
