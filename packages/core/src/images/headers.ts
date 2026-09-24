import type { ImagesConfig } from './config.ts';
import { imageExtension } from './detect.ts';

/**
 * The headers an optimized image goes out with, as Next.js sets them (`setResponseHeaders` in its
 * optimizer): the negotiated format varies the response, the cache lifetime comes from the
 * configuration and the source, and the download name and the CSP come from the configuration.
 */

/** Ten years, as Next.js caches a build-hashed source. */
const STATIC_MAX_AGE_SECONDS = 315_360_000;
const DEFAULT_FILENAME = 'image.bin';
/** Characters RFC 6266 lets stand unencoded inside a quoted filename. */
const UNSAFE_FILENAME = /[^\u{20}-\u{7E}]|["\\]/u;

export interface ImageHeadersInput {
  /** The source as the request named it; its last path segment names the download. */
  readonly href: string;
  readonly contentType: string;
  readonly isStatic: boolean;
  /** Seconds the client may keep the image; `max(minimumCacheTTL, upstream max-age)`. */
  readonly maxAge: number;
  readonly etag: string | undefined;
  readonly config: Pick<ImagesConfig, 'contentDispositionType' | 'contentSecurityPolicy'>;
  readonly cache: 'HIT' | 'MISS';
}

/** `hero.jpeg` for `/images/hero.png?v=2` served as JPEG — the name Next.js gives a download. */
export function imageFilename(href: string, contentType: string): string {
  const [withoutQuery = ''] = href.split('?', 1);
  const last = withoutQuery.split('/').pop();
  const extension = imageExtension(contentType);
  if (last === undefined || last === '' || extension === undefined) {
    return DEFAULT_FILENAME;
  }
  const [stem = ''] = last.split('.', 1);
  return `${stem}.${extension}`;
}

/** RFC 6266: a plain quoted name, or an RFC 5987 encoded one when the name needs it. */
function contentDisposition(type: 'inline' | 'attachment', filename: string): string {
  if (UNSAFE_FILENAME.test(filename)) {
    return `${type}; filename*=UTF-8''${encodeURIComponent(filename)}`;
  }
  return `${type}; filename="${filename}"`;
}

export function imageCacheControl(isStatic: boolean, maxAge: number): string {
  return isStatic
    ? `public, max-age=${STATIC_MAX_AGE_SECONDS}, immutable`
    : `public, max-age=${maxAge}, must-revalidate`;
}

export function imageResponseHeaders(input: ImageHeadersInput): Headers {
  const headers = new Headers({
    vary: 'Accept',
    'cache-control': imageCacheControl(input.isStatic, input.maxAge),
    'content-type': input.contentType,
    'content-disposition': contentDisposition(
      input.config.contentDispositionType,
      imageFilename(input.href, input.contentType),
    ),
    'content-security-policy': input.config.contentSecurityPolicy,
    'x-nextjs-cache': input.cache,
  });
  if (input.etag !== undefined) {
    headers.set('etag', input.etag);
  }
  return headers;
}

/** The lifetime an upstream grants, as Next.js reads it: `max-age` from `cache-control`, else 0. */
export function upstreamMaxAge(cacheControl: string | null): number {
  if (cacheControl === null) {
    return 0;
  }
  for (const directive of cacheControl.split(',')) {
    const [name, value] = directive.trim().split('=', 2);
    if (value !== undefined && name?.trim().toLowerCase() === 'max-age') {
      const seconds = Number.parseInt(value.trim().replaceAll('"', ''), 10);
      return Number.isNaN(seconds) || seconds < 0 ? 0 : seconds;
    }
  }
  return 0;
}
