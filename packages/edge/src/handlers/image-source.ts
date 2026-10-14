import { sha256HexOfText } from '@stayingupwind/core/artifact';
import {
  allowedImageDestination,
  type ImageRequestParams,
  type ImagesConfig,
  sourceSizeLimit,
} from '@stayingupwind/core/images';
import {
  findStaticFile,
  isReserved,
  type ProjectManifest,
  type StaticFileEntry,
} from '@stayingupwind/core/manifest';
import { MIDDLEWARE_DONE_HEADER, ORIGINAL_URL_HEADER } from '@stayingupwind/core/paas';
import { REDIRECT_STATUSES } from '@stayingupwind/core/request';
import { isDeadlineError, limitBody, releaseStream, withDeadline } from '@stayingupwind/core/util';
import { isUnderAnyDomain } from '@stayingupwind/host/domains';

import { logWarn } from '../observability/logger.ts';
import { asksBlobWorker } from '../preview/blobs.ts';
import type { EdgeContext } from '../strategies/context.ts';
import type { MiddlewareContinue } from './hosted-gate.ts';
import { decideMiddleware, middlewareMatches } from './middleware.ts';
import { readStaticFileStream, type StoredStream } from './static-file.ts';
import { dispatchesOf, dispatchesSoFar, fetchUpstream, functionOfRequest } from './upstream.ts';

/**
 * Where an image's source comes from, and the bytes of it.
 *
 * A file the build shipped is read from storage by its hash — a redeploy that changes the file
 * changes the hash — unless what Next.js runs ahead of its filesystem has a say on the file's own
 * path: a rule of `next.config` that claims it, or the application's middleware when its matchers
 * cover it. Next.js's optimizer asks its router for a source, and a file the middleware guards on
 * a request for the file is guarded behind the optimizer too; such a file is `gated`, and what it
 * amounts to is this deployment's answer for that path rather than the file itself. Any other
 * pathname of the application is asked of its Worker — a route handler that draws images, say —
 * and an absolute URL of the internet, each with the limits Next.js's own optimizer applies
 * (`fetchInternalImage`, `fetchExternalImage`). Nothing of the client's request travels with any
 * of these: the optimized image goes into a shared cache, so it has to be what an anonymous
 * visitor would have been given.
 */

/** What stands between the optimizer and a shipped file's path, if anything. */
type BlobGate = 'none' | 'reserved' | 'middleware';

export type ImageSource =
  | {
      readonly kind: 'blob';
      readonly file: StaticFileEntry;
      readonly href: string;
      readonly gate: BlobGate;
    }
  | { readonly kind: 'local'; readonly href: string }
  | { readonly kind: 'remote'; readonly href: string };

export interface SourceBody {
  readonly body: ReadableStream<Uint8Array>;
  readonly cacheControl: string | null;
  readonly etag: string | null;
  /** Requests it took to get here: the middleware's run, a fetch, one per redirect followed. */
  readonly requests: number;
}

/** A refusal, in the words and with the status Next.js's optimizer uses. */
export interface SourceError {
  readonly status: number;
  readonly message: string;
  /** Requests made before the refusal, for the metric. */
  readonly requests: number;
}

export type SourceResult =
  | { readonly kind: 'ok'; readonly source: SourceBody }
  | { readonly kind: 'error'; readonly error: SourceError };

const HTTP_BAD_REQUEST = 400;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const HTTP_GATEWAY_TIMEOUT = 504;
const HTTP_LOOP_DETECTED = 508;
/** Next.js's own budget for a source; a slower one is answered 504 rather than waited for. */
const SOURCE_FETCH_BUDGET_MS = 7000;

const UPSTREAM_INVALID = '"url" parameter is valid but upstream response is invalid';
const INTERNAL_INVALID = '"url" parameter is valid but internal response is invalid';
const TIMED_OUT = '"url" parameter is valid but upstream response timed out';
const SOURCE_REFUSED = 'image source refused';

const HTTP_INTERNAL_ERROR = 500;

/** A refusal in the status Next.js's `ImageError` would carry: an error status, or 500 for another. */
function refused(status: number, message: string, requests: number): SourceResult {
  return {
    kind: 'error',
    error: {
      status: status >= HTTP_BAD_REQUEST ? status : HTTP_INTERNAL_ERROR,
      message,
      requests,
    },
  };
}

/** A pathname parsed the way Next.js parses one: against a placeholder origin it never uses. */
const LOCAL_BASE = 'https://n';

/** The pathname as the loader encoded it, without the query the optimizer ignores for a file. */
function localPathname(href: string): string {
  return new URL(href, LOCAL_BASE).pathname;
}

/**
 * The gate on a shipped file's path, decided on the request the application would see for it and
 * before anything is served: a cached result is keyed by it, so a file kept under one path is
 * not handed out under another the middleware has a say on. Validation proves what is stored and
 * skips the middleware, as it does everywhere.
 */
function blobGate(edge: EdgeContext, manifest: ProjectManifest, href: string): BlobGate {
  const request = localRequest(edge, href);
  const url = new URL(request.url);
  if (isReserved(manifest, url, request.headers, true)) {
    return 'reserved';
  }
  if (!edge.validated && middlewareMatches(edge, manifest, url, request.headers)) {
    return 'middleware';
  }
  return 'none';
}

export function resolveImageSource(
  edge: EdgeContext,
  manifest: ProjectManifest,
  params: ImageRequestParams,
): ImageSource {
  if (params.isAbsolute) {
    return { kind: 'remote', href: params.href };
  }
  const file = findStaticFile(manifest, localPathname(params.href));
  if (file === undefined) {
    return { kind: 'local', href: params.href };
  }
  return { kind: 'blob', file, href: params.href, gate: blobGate(edge, manifest, params.href) };
}

/** Whether a source's result is the file itself, kept for as long as the file is. */
export function isContentAddressed(source: ImageSource): boolean {
  return source.kind === 'blob' && source.gate === 'none';
}

/**
 * What one optimized image is cached under: the source's identity, then the parameters. A shipped
 * file is its hash, shared across deployments and invalidated by a change to the file — unless a
 * gate stands on its path, when the result is this deployment's answer for that path on the host
 * the request came in on, as another pathname of the application is bound to the deployment and
 * the host that answered it: the application sees the host, and may answer each differently; a
 * URL is itself.
 */
export async function imageSourceId(
  source: ImageSource,
  deploymentId: string,
  host: string,
): Promise<string> {
  const answered = async (href: string): Promise<string> =>
    `local:${deploymentId}:${host}:${await sha256HexOfText(href)}`;
  switch (source.kind) {
    case 'blob': {
      return source.gate === 'none' ? `blob:${source.file.sha256}` : answered(source.href);
    }
    case 'local': {
      return answered(source.href);
    }
    case 'remote': {
      return `remote:${await sha256HexOfText(source.href)}`;
    }
  }
}

/** The most a source may be: what the configuration allows, within what the service takes. */
export function sourceLimit(config: ImagesConfig): number {
  return sourceSizeLimit(config);
}

function accepted(
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
  return {
    kind: 'ok',
    source: {
      body: limitBody(response.body as ReadableStream<Uint8Array>, limit),
      cacheControl: response.headers.get('cache-control'),
      etag: response.headers.get('etag'),
      requests,
    },
  };
}

/**
 * The request the application sees for a source of its own: a bare GET at its own host, as
 * Next.js's optimizer makes one.
 */
function localRequest(edge: EdgeContext, href: string): Request {
  const url = new URL(href, `https://${edge.forwarding.previewHost}`);
  return new Request(url.href, {
    headers: {
      'x-forwarded-host': edge.forwarding.previewHost,
      'x-forwarded-proto': 'https',
      via: '1.1 arkor-edge',
    },
    redirect: 'manual',
  });
}

/** A source's request as the middleware left it, with the Worker told the middleware ran. */
function rewrittenRequest(original: Request, middleware: MiddlewareContinue): Request {
  const headers = new Headers(middleware.requestHeaders);
  headers.set(MIDDLEWARE_DONE_HEADER, '1');
  headers.set(ORIGINAL_URL_HEADER, original.url);
  return new Request(middleware.url.href, { headers, redirect: 'manual' });
}

/** What a source of the application's own is fetched with. */
interface LocalContext {
  readonly edge: EdgeContext;
  readonly config: ImagesConfig;
  /** For the tables that say which app Worker a path is in, where the build split them. */
  readonly manifest: ProjectManifest;
}

/** What a fetch of a source from the application comes after. */
interface LocalFetch {
  /** The requests already made for the source, which its result counts. */
  readonly earlier: number;
  /** What is left of the source's budget, where something before the fetch spent some. */
  readonly budgetMs?: number;
}

async function fetchLocal(
  local: LocalContext,
  request: Request,
  { earlier, budgetMs = SOURCE_FETCH_BUDGET_MS }: LocalFetch,
): Promise<SourceResult> {
  const { edge, config } = local;
  // A budget the middleware spent is a timed-out source, not a request sent and abandoned.
  if (budgetMs <= 0) {
    return refused(HTTP_GATEWAY_TIMEOUT, TIMED_OUT, earlier);
  }
  // To the Worker the manifest's tables place the path in, as a passthrough is sent: one dispatch,
  // where the first Worker would only have named the one that holds it.
  const fn = functionOfRequest(edge.app, local.manifest, request);
  // A source past its budget is let go, not left rendering behind the refusal: nobody reads it.
  const controller = new AbortController();
  const signalled = new Request(request, { signal: controller.signal });
  const answer = fetchUpstream(edge.runtime, edge.app, signalled, fn);
  let response: Response;
  try {
    response = await withDeadline(answer, budgetMs, 'image source');
  } catch (error) {
    controller.abort(error);
    // Two where the Worker the first named failed, or was still out when the budget ran out: the
    // deadline's error is its own, so the dispatch is what says how far it got.
    const requests = earlier + dispatchesSoFar(answer);
    return isDeadlineError(error)
      ? refused(HTTP_GATEWAY_TIMEOUT, TIMED_OUT, requests)
      : refused(HTTP_BAD_REQUEST, INTERNAL_INVALID, requests);
  }
  // Two where a split deployment's first Worker named the one that holds the source.
  const requests = earlier + dispatchesOf(response);
  // Whatever the application answered — a redirect its middleware sent, a 404 — is not an image
  // of its own, and Next.js's optimizer says so with a 400 rather than with that status.
  if (!response.ok) {
    releaseStream(response.body, SOURCE_REFUSED);
    return refused(HTTP_BAD_REQUEST, INTERNAL_INVALID, requests);
  }
  return accepted(response, sourceLimit(config), INTERNAL_INVALID, requests);
}

/** A shipped file from storage; its size is known, so one past the limit is refused unread. */
async function readBlob(
  edge: EdgeContext,
  config: ImagesConfig,
  file: StaticFileEntry,
  requests: number,
): Promise<SourceResult> {
  if (file.byteLength > sourceLimit(config)) {
    return refused(HTTP_PAYLOAD_TOO_LARGE, INTERNAL_INVALID, requests);
  }
  // Storage's requests are the source's as well: the blob Worker's, the bucket's, or both.
  let read: StoredStream;
  try {
    read = await readStaticFileStream(edge, file);
  } catch (error) {
    // The bucket failed, where the blob Worker did not answer with the bytes: Next.js's answer for
    // a source it could not fetch, rather than an exception that fails the whole request.
    logWarn('image source read failed', {
      sha256: file.sha256,
      detail: error instanceof Error ? error.message : String(error),
    });
    // What threw is the bucket, read after the blob Worker where that was asked first.
    const asked = asksBlobWorker(edge.runtime.blobWorker, file) ? 2 : 1;
    return refused(HTTP_INTERNAL_ERROR, INTERNAL_INVALID, requests + asked);
  }
  const spent = requests + read.requests;
  if (read.body === undefined) {
    return refused(HTTP_BAD_REQUEST, INTERNAL_INVALID, spent);
  }
  return {
    kind: 'ok',
    source: { body: read.body, cacheControl: null, etag: `"${file.sha256}"`, requests: spent },
  };
}

/**
 * A file the build shipped, from storage — once what Next.js runs ahead of its filesystem has had
 * its say on the file's own path, as it has on a request for the file. A rule of `next.config`
 * that claims the path before the filesystem makes the Worker's answer the source. The
 * middleware, when its matchers cover the path, sees it as an anonymous visitor asks for it: what
 * it lets through is the file; a path it rewrites to is asked of the Worker, which is told the
 * middleware ran; what it answers itself is the source only if it is one, as under Next.js, and
 * a redirect to a login page is not. A middleware whose own Worker failed is asked of the
 * application's (`decideMiddleware`), which carries none of `_next/static` and could not answer
 * for the file itself. When the edge still cannot say what the middleware decided — both failed,
 * or it rewrote to another origin — the Worker is asked for the file's path and runs the
 * middleware itself, as it does for a document. The middleware and all that follows it, a retry
 * of a failed one included, share the budget a source fetched from the application has.
 */
async function fetchBlob(
  local: LocalContext,
  source: Extract<ImageSource, { kind: 'blob' }>,
): Promise<SourceResult> {
  const { edge, config } = local;
  const request = localRequest(edge, source.href);
  if (source.gate === 'reserved') {
    return fetchLocal(local, request, { earlier: 0 });
  }
  if (source.gate === 'none') {
    return readBlob(edge, config, source.file, 0);
  }
  const deadline = edge.runtime.now() + SOURCE_FETCH_BUDGET_MS;
  const { outcome, dispatches } = await decideMiddleware(edge, request, deadline);
  const left = (): number => deadline - edge.runtime.now();
  switch (outcome.kind) {
    case 'skipped': {
      return readBlob(edge, config, source.file, dispatches);
    }
    case 'continue': {
      return outcome.rewritten
        ? fetchLocal(local, rewrittenRequest(request, outcome), {
            earlier: dispatches,
            budgetMs: left(),
          })
        : readBlob(edge, config, source.file, dispatches);
    }
    case 'responded': {
      if (!outcome.response.ok) {
        releaseStream(outcome.response.body, SOURCE_REFUSED);
        return refused(HTTP_BAD_REQUEST, INTERNAL_INVALID, dispatches);
      }
      return accepted(outcome.response, sourceLimit(config), INTERNAL_INVALID, dispatches);
    }
    case 'external-rewrite':
    case 'failed': {
      return fetchLocal(local, request, { earlier: dispatches, budgetMs: left() });
    }
  }
}

/**
 * A redirect the optimizer will not follow: off the web, to a local address the configuration
 * does not allow (as Next.js judges each hop), or back into the edge's host — every name under a
 * domain it answers on (`ownDomains`), each hostname it answers on (`ownHostnames`), and the
 * hostname this request came in on, which a site's own domain routes here as well.
 */
function redirectRefused(target: URL, edge: EdgeContext, config: ImagesConfig): boolean {
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return true;
  }
  if (!allowedImageDestination(config, target)) {
    return true;
  }
  const { hostname } = target;
  return (
    isUnderAnyDomain(hostname, edge.host.ownDomains) ||
    edge.host.ownHostnames?.includes(hostname) === true ||
    hostname === edge.forwarding.previewHost
  );
}

/**
 * One hop of a remote fetch: the response, or the refusal it amounts to. A budget the earlier
 * hops used up is a refusal before the request goes out, not a request sent and abandoned.
 */
async function fetchHop(
  edge: EdgeContext,
  url: URL,
  deadline: number,
  requests: number,
): Promise<Response | SourceResult> {
  const remaining = deadline - edge.runtime.now();
  if (remaining <= 0) {
    return refused(HTTP_GATEWAY_TIMEOUT, TIMED_OUT, requests);
  }
  // A hop past the budget is let go, not left holding a connection behind the refusal.
  const controller = new AbortController();
  try {
    return await withDeadline(
      edge.runtime.fetchImpl(
        new Request(url.href, { redirect: 'manual', signal: controller.signal }),
      ),
      remaining,
      'image source',
    );
  } catch (error) {
    controller.abort(error);
    return isDeadlineError(error)
      ? refused(HTTP_GATEWAY_TIMEOUT, TIMED_OUT, requests + 1)
      : refused(HTTP_BAD_REQUEST, UPSTREAM_INVALID, requests + 1);
  }
}

/** Where a redirect points, when it is one the optimizer follows. */
function redirectTarget(response: Response, from: URL): URL | undefined {
  const location = response.headers.get('location');
  if (location === null || !REDIRECT_STATUSES.has(response.status)) {
    return undefined;
  }
  return URL.canParse(location, from.href) ? new URL(location, from) : undefined;
}

/**
 * A URL of the internet, its redirects followed as Next.js follows them: up to the configured
 * count, and without checking each hop against the patterns again — but never off the web, and
 * never back into this edge.
 */
async function fetchRemote(
  edge: EdgeContext,
  config: ImagesConfig,
  href: string,
): Promise<SourceResult> {
  const deadline = edge.runtime.now() + SOURCE_FETCH_BUDGET_MS;
  let url = new URL(href);
  // The same judgment a redirect gets, on the destination the caller named. The patterns say which
  // hosts an application meant to allow; they say nothing about where those hosts point, and a
  // pattern that admits the edge's host — the app's own hostname most of all — would make the
  // optimizer a way to reach it through itself.
  if (redirectRefused(url, edge, config)) {
    return refused(HTTP_BAD_REQUEST, UPSTREAM_INVALID, 0);
  }
  let requests = 0;
  for (let hops = config.maximumRedirects; ; hops -= 1) {
    // `fetchHop` is given the count so far, and counts its own request once it has made it.
    const hop = await fetchHop(edge, url, deadline, requests);
    if (!(hop instanceof Response)) {
      return hop;
    }
    requests += 1;
    const target = redirectTarget(hop, url);
    if (target === undefined) {
      if (!hop.ok) {
        releaseStream(hop.body, SOURCE_REFUSED);
        return refused(hop.status, UPSTREAM_INVALID, requests);
      }
      return accepted(hop, sourceLimit(config), UPSTREAM_INVALID, requests);
    }
    releaseStream(hop.body, 'image source redirected');
    if (hops === 0) {
      return refused(HTTP_LOOP_DETECTED, UPSTREAM_INVALID, requests);
    }
    if (redirectRefused(target, edge, config)) {
      return refused(HTTP_BAD_REQUEST, UPSTREAM_INVALID, requests);
    }
    url = target;
  }
}

export function fetchImageSource(
  edge: EdgeContext,
  config: ImagesConfig,
  source: ImageSource,
  manifest: ProjectManifest,
): Promise<SourceResult> {
  const local: LocalContext = { edge, config, manifest };
  switch (source.kind) {
    case 'blob': {
      return fetchBlob(local, source);
    }
    case 'local': {
      return fetchLocal(local, localRequest(edge, source.href), { earlier: 0 });
    }
    case 'remote': {
      return fetchRemote(edge, config, source.href);
    }
  }
}
