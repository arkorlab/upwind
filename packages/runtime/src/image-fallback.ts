import {
  allowedImageDestination,
  detectImageType,
  IMAGE_SIGNATURE_BYTES,
  type ImageRequestParams,
  imageResponseHeaders,
  type ImagesConfig,
  parseImageRequest,
  sourceSizeLimit,
  SVG,
  upstreamMaxAge,
} from '@upwind/core/images';
import { REDIRECT_STATUSES } from '@upwind/core/request';
import { isBodyLimitError, limitBody, readBoundedBody, releaseStream } from '@upwind/core/util';

/**
 * `/_next/image` reaching the Worker itself.
 *
 * The edge optimizes images; the Worker has no encoder. But the edge proxies everything while it
 * has no manifest to serve from — before a first deployment activates, while a manifest cannot
 * be read — and a page must not lose its images for that. So a request that gets this far —
 * asked for directly, or rewritten here by a rule of `next.config` — is answered with the source
 * itself, unresized: a path of the application from the application, through its router and its
 * middleware; a URL from the internet, fetched here rather than handed to the browser, whose
 * `img-src` may name this origin alone. The parameters are checked as the optimizer checks
 * them, the bytes are looked at as the optimizer looks at them, and the answer carries the
 * headers the optimizer would have given it, so nothing goes out this way that it would have
 * refused, nor without the sandbox it puts an SVG in, nor past the size it would have stood for.
 */

const HTTP_BAD_REQUEST = 400;
const HTTP_METHOD_NOT_ALLOWED = 405;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const HTTP_INTERNAL_ERROR = 500;
const HTTP_GATEWAY_TIMEOUT = 504;
const HTTP_LOOP_DETECTED = 508;
/** How long a source may take to yield its first bytes, redirects included; Next.js's own budget. */
const SOURCE_BUDGET_MS = 7000;
const UPSTREAM_INVALID = '"url" parameter is valid but upstream response is invalid';
const INTERNAL_INVALID = '"url" parameter is valid but internal response is invalid';
const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);
const FORWARDED_HOST_HEADER = 'x-forwarded-host';
/** What the edge says of itself on a request it forwards; the one part of it a source's request keeps. */
const FORWARDING_HEADERS: readonly string[] = [FORWARDED_HOST_HEADER, 'x-forwarded-proto', 'via'];

export type ImageFallback =
  | { readonly kind: 'response'; readonly response: Response }
  /** The source is the application's own, to be asked of its router. */
  | { readonly kind: 'local'; readonly params: ImageRequestParams }
  /** The source is a URL of the internet, to be fetched. */
  | { readonly kind: 'remote'; readonly params: ImageRequestParams };

function refusal(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'private, no-store' },
  });
}

/**
 * What the request asks for, checked as the optimizer checks it. An image is read and nothing
 * else: a method with a body is refused before it could reach a handler of the application as one.
 */
export function imageFallback(
  request: Request,
  query: URLSearchParams,
  images: ImagesConfig,
): ImageFallback {
  if (!READ_METHODS.has(request.method)) {
    const response = new Response('Method Not Allowed', {
      status: HTTP_METHOD_NOT_ALLOWED,
      headers: { allow: 'GET, HEAD' },
    });
    return { kind: 'response', response };
  }
  const parsed = parseImageRequest(query, request.headers.get('accept'), images);
  if (parsed.kind === 'invalid') {
    return { kind: 'response', response: refusal(HTTP_BAD_REQUEST, parsed.errorMessage) };
  }
  return { kind: parsed.params.isAbsolute ? 'remote' : 'local', params: parsed.params };
}

/**
 * The request the router sees for a source of the application's own: a bare GET, as Next.js's
 * optimizer makes one, and as the edge makes one — nothing of the client's, since what a source
 * answers is for every visitor, and only the platform's word on the host it is served at.
 */
export function sourceRequest(client: Request, href: string): Request {
  const headers = new Headers();
  for (const name of FORWARDING_HEADERS) {
    const value = client.headers.get(name);
    if (value !== null) {
      headers.set(name, value);
    }
  }
  return new Request(new URL(href, client.url).href, { headers });
}

/** The names this application answers at: its own, and the one the edge forwards. */
export function applicationHosts(request: Request): ReadonlySet<string> {
  const hosts = new Set([new URL(request.url).hostname]);
  const forwarded = request.headers.get(FORWARDED_HOST_HEADER);
  if (forwarded !== null) {
    hosts.add(forwarded.split(':', 1)[0] ?? forwarded);
  }
  return hosts;
}

/** A URL of the internet, fetched: its bytes, or the refusal it amounted to. */
type RemoteSource =
  | { readonly kind: 'ok'; readonly response: Response }
  | { readonly kind: 'refused'; readonly response: Response };

/** Where a redirect points, when it is one the optimizer follows. */
function redirectTarget(response: Response, from: URL): URL | undefined {
  const location = response.headers.get('location');
  if (location === null || !REDIRECT_STATUSES.has(response.status)) {
    return undefined;
  }
  return URL.canParse(location, from.href) ? new URL(location, from) : undefined;
}

/**
 * A redirect the optimizer will not follow: off the web, to a local address the configuration
 * does not allow (as Next.js judges each hop), or back to this application, which would have it
 * ask itself.
 */
function redirectRefused(
  target: URL,
  ownHosts: ReadonlySet<string>,
  images: ImagesConfig,
): boolean {
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return true;
  }
  if (!allowedImageDestination(images, target)) {
    return true;
  }
  return ownHosts.has(target.hostname);
}

async function fetchHop(
  fetchImpl: typeof fetch,
  url: URL,
  deadline: number,
): Promise<RemoteSource> {
  const remaining = Math.max(1, deadline - Date.now());
  try {
    const response = await fetchImpl(url.href, {
      redirect: 'manual',
      signal: AbortSignal.timeout(remaining),
    });
    return { kind: 'ok', response };
  } catch (error) {
    return {
      kind: 'refused',
      response:
        error instanceof Error && error.name === 'TimeoutError'
          ? refusal(
              HTTP_GATEWAY_TIMEOUT,
              '"url" parameter is valid but upstream response timed out',
            )
          : refusal(HTTP_INTERNAL_ERROR, UPSTREAM_INVALID),
    };
  }
}

export interface RemoteSourceInput {
  readonly href: string;
  readonly images: ImagesConfig;
  /** The names this application answers at; a redirect to one is refused. */
  readonly ownHosts: ReadonlySet<string>;
  /** How to reach the internet; the platform's `fetch` unless a test says otherwise. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * A URL of the internet, as Next.js's optimizer fetches one: nothing of the client's forwarded,
 * redirects followed up to the configured count and without checking each hop against the
 * patterns again — but never off the web, and never back to this application, which would have
 * it ask itself.
 */
export async function fetchRemoteSource(input: RemoteSourceInput): Promise<RemoteSource> {
  const { images, ownHosts, fetchImpl = fetch } = input;
  const deadline = Date.now() + SOURCE_BUDGET_MS;
  let url = new URL(input.href);
  // The patterns name the hosts an application meant to allow, not where they point. Checked on
  // the first destination as well as on every hop; see `allowedImageDestination`.
  if (!allowedImageDestination(images, url)) {
    return { kind: 'refused', response: refusal(HTTP_BAD_REQUEST, UPSTREAM_INVALID) };
  }
  for (let hops = images.maximumRedirects; ; hops -= 1) {
    const hop = await fetchHop(fetchImpl, url, deadline);
    if (hop.kind === 'refused') {
      return hop;
    }
    const target = redirectTarget(hop.response, url);
    if (target === undefined) {
      return hop;
    }
    releaseStream(hop.response.body, 'image source redirected');
    if (hops === 0) {
      return { kind: 'refused', response: refusal(HTTP_LOOP_DETECTED, UPSTREAM_INVALID) };
    }
    if (redirectRefused(target, ownHosts, images)) {
      return { kind: 'refused', response: refusal(HTTP_BAD_REQUEST, UPSTREAM_INVALID) };
    }
    url = target;
  }
}

/**
 * The status the optimizer refuses a source with: 400 for a path of the application whatever it
 * answered, and for a URL its own status when that is an error, else 500 (`ImageError`).
 */
function refusalStatus(source: Response, internal: boolean): number {
  if (internal || source.ok) {
    return HTTP_BAD_REQUEST;
  }
  return source.status >= HTTP_BAD_REQUEST ? source.status : HTTP_INTERNAL_ERROR;
}

interface SourceResponseInput {
  readonly source: Response;
  readonly params: ImageRequestParams;
  readonly images: ImagesConfig;
  /** The source is a path of the application, refused in the words the optimizer has for one. */
  readonly internal: boolean;
  /** The client's method: a `HEAD` is answered without the body. */
  readonly method: string;
}

/** The source's bytes, whole, or the refusal they amount to. */
type SourceBytes = { readonly bytes: Uint8Array } | { readonly refusal: Response };

/**
 * The whole of a source, read before anything is answered — as the optimizer reads one, and as
 * the edge does — so a size the source did not declare is judged here, as a refusal, rather than
 * met halfway through an answer already committed.
 */
async function readSource(
  body: ReadableStream<Uint8Array>,
  limit: number,
  invalid: string,
): Promise<SourceBytes> {
  let read;
  try {
    read = await readBoundedBody(limitBody(body, limit), {
      limit,
      // One budget in two places: nothing is answered until this read is done, so a source that
      // went quiet and one that is merely slow cost the caller the same thing, and neither may
      // outlast what the whole answer is allowed.
      stallMs: SOURCE_BUDGET_MS,
      budgetMs: SOURCE_BUDGET_MS,
    });
  } catch (error) {
    const status = isBodyLimitError(error) ? HTTP_PAYLOAD_TOO_LARGE : HTTP_INTERNAL_ERROR;
    return { refusal: refusal(status, invalid) };
  }
  if (read.kind === 'over-limit') {
    releaseStream(read.body, 'image source too large');
    return { refusal: refusal(HTTP_PAYLOAD_TOO_LARGE, invalid) };
  }
  return { bytes: read.bytes };
}

/**
 * The source's answer as the optimizer would pass it on: looked at, and under the optimizer's
 * headers. What the source answered with anything but its bytes — a redirect its middleware sent,
 * a 404 — is not an image, and refused as the optimizer refuses it; one larger than a source may
 * be is refused, whether it said so or ran past the limit while it was read.
 */
export async function sourceResponse(input: SourceResponseInput): Promise<Response> {
  const { source, params, images, internal } = input;
  const invalid = internal ? INTERNAL_INVALID : UPSTREAM_INVALID;
  if (!source.ok || source.body === null) {
    releaseStream(source.body, 'image source refused');
    return refusal(refusalStatus(source, internal), invalid);
  }
  const limit = sourceSizeLimit(images);
  const declared = source.headers.get('content-length');
  if (declared !== null && Number.parseInt(declared, 10) > limit) {
    releaseStream(source.body, 'image source too large');
    return refusal(HTTP_PAYLOAD_TOO_LARGE, invalid);
  }
  const read = await readSource(source.body, limit, invalid);
  if ('refusal' in read) {
    return read.refusal;
  }
  const { bytes } = read;
  const contentType = detectImageType(bytes.subarray(0, IMAGE_SIGNATURE_BYTES));
  if (contentType === undefined) {
    return refusal(HTTP_BAD_REQUEST, "The requested resource isn't a valid image.");
  }
  if (contentType === SVG && !images.dangerouslyAllowSVG) {
    return refusal(HTTP_BAD_REQUEST, '"url" parameter is valid but image type is not allowed');
  }
  const granted = upstreamMaxAge(source.headers.get('cache-control'));
  const headers = imageResponseHeaders({
    href: params.href,
    contentType,
    isStatic: params.isStatic,
    maxAge: Math.max(images.minimumCacheTTL, granted),
    etag: source.headers.get('etag') ?? undefined,
    config: images,
    cache: 'MISS',
  });
  headers.set('content-length', String(bytes.byteLength));
  // Read into a buffer of its own, which is what the runtime's `Response` asks a body to be over.
  const body = bytes as Uint8Array<ArrayBuffer>;
  return new Response(input.method === 'HEAD' ? null : body, { headers });
}
