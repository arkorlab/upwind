import type { ImageLocalPattern, ImageRemotePattern, ImagesConfig } from './config.ts';
import { isLocalAddress } from './local-address.ts';
import { negotiateImageFormat } from './negotiate.ts';

/**
 * `/_next/image?url=…&w=…&q=…`, checked the way Next.js's own optimizer checks it
 * (`ImageOptimizerCache.validateParams`): the same rules in the same order, and the same message
 * for each refusal, so an application behaves here as it does under `next start`.
 */

export interface ImageRequestParams {
  /** The source: a pathname of the application, or an absolute URL. */
  readonly href: string;
  readonly isAbsolute: boolean;
  /** A build-hashed file under `_next/static/media`: immutable, cached for ten years. */
  readonly isStatic: boolean;
  readonly width: number;
  readonly quality: number;
  /** The format the client negotiated, or `''` to keep the source's own. */
  readonly mimeType: string;
}

export type ImageRequestResult =
  | { readonly kind: 'ok'; readonly params: ImageRequestParams }
  | { readonly kind: 'invalid'; readonly errorMessage: string };

const MAX_URL_LENGTH = 3072;
const NOT_ALLOWED = '"url" parameter is not allowed';
const MAX_QUALITY = 100;
/** Where the optimizer lives by default; Next.js refuses this as a source wherever it appears. */
const RECURSIVE_IMAGE_PATH = /\/_next\/image(?:$|\/)/u;
const DIGITS = /^\d+$/u;

interface Invalid {
  readonly kind: 'invalid';
  readonly errorMessage: string;
}

function invalid(errorMessage: string): Invalid {
  return { kind: 'invalid', errorMessage };
}

/**
 * The build compiles each pattern to a regular expression source; compiled here once per pattern
 * object, on the first image request rather than when the manifest is parsed, so a manifest with
 * images costs a document request nothing.
 */
const remoteRegExps = new WeakMap<ImageRemotePattern, { hostname: RegExp; pathname: RegExp }>();
const localRegExps = new WeakMap<ImageLocalPattern, RegExp>();

function compile(source: string): RegExp {
  // As Next.js compiled it for its own router, without the unicode flag.
  // eslint-disable-next-line security/detect-non-literal-regexp, require-unicode-regexp
  return new RegExp(source);
}

function remoteRegExpsOf(pattern: ImageRemotePattern): { hostname: RegExp; pathname: RegExp } {
  let regexps = remoteRegExps.get(pattern);
  if (regexps === undefined) {
    regexps = { hostname: compile(pattern.hostname), pathname: compile(pattern.pathname) };
    remoteRegExps.set(pattern, regexps);
  }
  return regexps;
}

function localRegExpOf(pattern: ImageLocalPattern): RegExp {
  let regexp = localRegExps.get(pattern);
  if (regexp === undefined) {
    regexp = compile(pattern.pathname);
    localRegExps.set(pattern, regexp);
  }
  return regexp;
}

function matchesRemotePattern(pattern: ImageRemotePattern, url: URL): boolean {
  if (pattern.protocol !== undefined && pattern.protocol !== url.protocol.replace(/:$/u, '')) {
    return false;
  }
  if (pattern.port !== undefined && pattern.port !== url.port) {
    return false;
  }
  const regexps = remoteRegExpsOf(pattern);
  if (!regexps.hostname.test(url.hostname)) {
    return false;
  }
  if (pattern.search !== undefined && pattern.search !== url.search) {
    return false;
  }
  return regexps.pathname.test(url.pathname);
}

function matchesLocalPattern(pattern: ImageLocalPattern, url: URL): boolean {
  if (pattern.search !== undefined && pattern.search !== url.search) {
    return false;
  }
  return localRegExpOf(pattern).test(url.pathname);
}

/** A pathname parsed the way Next.js parses one: against a placeholder origin it never uses. */
const LOCAL_BASE = 'https://n';

function localAllowed(config: ImagesConfig, href: string): boolean {
  const url = new URL(href, LOCAL_BASE);
  return config.localPatterns.some((pattern) => matchesLocalPattern(pattern, url));
}

function remoteAllowed(config: ImagesConfig, url: URL): boolean {
  return (
    config.domains.includes(url.hostname) ||
    config.remotePatterns.some((pattern) => matchesRemotePattern(pattern, url))
  );
}

function decodedPathname(href: string): string {
  const { pathname } = new URL(href, LOCAL_BASE);
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

/** The path without the trailing slash `trailingSlash` gives it. */
function withoutTrailingSlash(path: string): string {
  let out = path;
  while (out.endsWith('/')) {
    out = out.slice(0, -1);
  }
  return out;
}

/**
 * A source that is the optimizer itself: `/_next/image`, as Next.js refuses it, and the path the
 * optimizer was configured to answer at when that is another — for which Next.js's own check
 * does not look, and which would otherwise have the optimizer ask itself, once per level the
 * URL nests. The path is compared without the trailing slash `trailingSlash` gives it.
 */
function isRecursive(config: ImagesConfig, url: string): boolean {
  const pathname = decodedPathname(url);
  if (RECURSIVE_IMAGE_PATH.test(pathname)) {
    return true;
  }
  const optimizer = withoutTrailingSlash(config.path);
  return optimizer !== '' && (pathname === optimizer || pathname.startsWith(`${optimizer}/`));
}

type Source =
  | Invalid
  | { readonly kind: 'ok'; readonly href: string; readonly isAbsolute: boolean };

function sourceOf(config: ImagesConfig, url: string): Source {
  if (url.length > MAX_URL_LENGTH) {
    return invalid('"url" parameter is too long');
  }
  if (url.startsWith('//')) {
    return invalid('"url" parameter cannot be a protocol-relative URL (//)');
  }
  if (url.startsWith('/')) {
    if (isRecursive(config, url)) {
      return invalid('"url" parameter cannot be recursive');
    }
    if (!localAllowed(config, url)) {
      return invalid(NOT_ALLOWED);
    }
    return { kind: 'ok', href: url, isAbsolute: false };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return invalid('"url" parameter is invalid');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return invalid('"url" parameter is invalid');
  }
  // A local address is refused as the optimizer refuses one it resolved, in the same words.
  const local = !config.dangerouslyAllowLocalIP && isLocalAddress(parsed.hostname);
  if (local || !remoteAllowed(config, parsed)) {
    return invalid(NOT_ALLOWED);
  }
  // No recursion check here, as Next.js has none for an absolute URL
  // (`server/image-optimizer.js` tests the path of a relative one only). A path is the wrong
  // thing to judge it by: an external image service is free to answer at `/_next/image`, and a
  // URL that would reach this optimizer through itself is refused for its *host*, where the
  // fetch is judged against this platform's own names.
  return { kind: 'ok', href: parsed.href, isAbsolute: true };
}

function isStaticSource(config: ImagesConfig, url: string): boolean {
  return (
    url.startsWith(`${config.basePath}/_next/static/media`) ||
    url.startsWith(`${config.basePath}/_next/static/immutable/media`)
  );
}

interface NumberErrors {
  readonly required: string;
  readonly array: string;
  readonly shape: string;
}

const WIDTH_ERRORS: NumberErrors = {
  required: '"w" parameter (width) is required',
  array: '"w" parameter (width) cannot be an array',
  shape: '"w" parameter (width) must be an integer greater than 0',
};

const QUALITY_ERRORS: NumberErrors = {
  required: '"q" parameter (quality) is required',
  array: '"q" parameter (quality) cannot be an array',
  shape: '"q" parameter (quality) must be an integer between 1 and 100',
};

type Digits = Invalid | { readonly kind: 'ok'; readonly value: string };

/** One numeric parameter as written: present once, digits only. */
function digitsOf(search: URLSearchParams, name: string, errors: NumberErrors): Digits {
  const values = search.getAll(name);
  const value = values[0];
  if (value === undefined || value === '') {
    return invalid(errors.required);
  }
  if (values.length > 1) {
    return invalid(errors.array);
  }
  if (!DIGITS.test(value)) {
    return invalid(errors.shape);
  }
  return { kind: 'ok', value };
}

/** The request's parameters, or the message Next.js would answer 400 with. */
export function parseImageRequest(
  search: URLSearchParams,
  accept: string | null,
  config: ImagesConfig,
): ImageRequestResult {
  const urls = search.getAll('url');
  const url = urls[0];
  if (url === undefined || url === '') {
    return invalid('"url" parameter is required');
  }
  if (urls.length > 1) {
    return invalid('"url" parameter cannot be an array');
  }
  const source = sourceOf(config, url);
  if (source.kind === 'invalid') {
    return source;
  }
  // Both raw values are checked for shape before either is checked for range, as Next.js does.
  const w = digitsOf(search, 'w', WIDTH_ERRORS);
  if (w.kind === 'invalid') {
    return w;
  }
  const q = digitsOf(search, 'q', QUALITY_ERRORS);
  if (q.kind === 'invalid') {
    return q;
  }
  const width = Number.parseInt(w.value, 10);
  if (width <= 0 || Number.isNaN(width)) {
    return invalid(WIDTH_ERRORS.shape);
  }
  if (!config.sizes.includes(width)) {
    return invalid(`"w" parameter (width) of ${width} is not allowed`);
  }
  const quality = Number.parseInt(q.value, 10);
  if (Number.isNaN(quality) || quality < 1 || quality > MAX_QUALITY) {
    return invalid(QUALITY_ERRORS.shape);
  }
  if (config.qualities !== undefined && !config.qualities.includes(quality)) {
    return invalid(`"q" parameter (quality) of ${q.value} is not allowed`);
  }
  return {
    kind: 'ok',
    params: {
      href: source.href,
      isAbsolute: source.isAbsolute,
      isStatic: isStaticSource(config, url),
      width,
      quality,
      mimeType: negotiateImageFormat(accept ?? '', config.formats),
    },
  };
}
