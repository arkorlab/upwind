import type { BlobRef, Prerender, StaticFile } from '@stayingupwind/core/bundle';
import { NO_STORE_CACHE_CONTROL, SEGMENT_TREE_PATH } from '@stayingupwind/core/request';
import { releaseStream } from '@stayingupwind/core/util';

import { isDraftRequest } from './draft.ts';
import { type Entry, entryFor } from './entries.ts';
import { failureAnswer } from './error-pages.ts';
import { isCrawler, isRscRequest, rscBase } from './incoming.ts';
import type { Resolved } from './outputs.ts';
import {
  bypassesPrerender,
  concatShell,
  HTML_CONTENT_TYPE,
  HTTP_NOT_FOUND,
  HTTP_OK,
  invokeEntry,
  notFoundResponse,
  POSTPONED_HEADER,
  PRERENDER_HEADER,
  prerenderHeaders,
  resume,
  type RoutedInput,
  RSC_CONTENT_TYPE,
  staticResponse,
  withCacheState,
} from './serve.ts';
import { entrypointKindOf, findShell, isClassShell, type Store } from './store.ts';

/**
 * What the build made of a route, answered from the bundle: a document from its shell and the
 * resume that completes it, a route's React Server Components from the build's state, a file
 * the Function carries, and the not-found as the request asks for it.
 */

const NOT_FOUND_ENTRY_ID = '/_not-found';
/** The page every status of the Pages Router falls back to, a not-found's among them. */
const ERROR_ENTRY_ID = '/_error';
/** Next.js writes the static not-found document as the `/404` static file, under the `basePath`. */
const NOT_FOUND_PAGE = '/404';
const RSC_SUFFIX = '.rsc';
const CACHE_CONTROL = 'cache-control';

/** The state that resumes a prerender of the build, as the bundle carries it. */
export function postponedOf(store: Store, prerender: Prerender): string | undefined {
  return prerender.postponed === undefined
    ? undefined
    : new TextDecoder().decode(store.readBlob(prerender.postponed.sha256));
}

/**
 * A file the manifest names, under `status`: with the bytes the Function carries, or — for one it
 * does not carry, a file under `_next/static` a rewrite of the build's may land on, which the
 * adapter lists for such a build only — with the host's, which keeps every file of the build. Not
 * for a `HEAD`, which has no use for them: the host's bytes are a read of the whole file.
 * `undefined` where the host has none to give.
 */
export async function staticFileResponse(
  input: RoutedInput,
  store: Store,
  file: StaticFile,
  status: number,
): Promise<Response | undefined> {
  const carried = store.tryReadBlob(file.blob.sha256);
  if (carried !== undefined) {
    return fileResponse(file, carried, status);
  }
  if (input.request.method === 'HEAD') {
    return fileResponse(file, null, status);
  }
  const hosted = await fromHost(input, file.blob);
  return hosted === undefined ? undefined : fileResponse(file, hosted, status);
}

function fileResponse(
  file: StaticFile,
  bytes: Uint8Array<ArrayBuffer> | null,
  status: number,
): Response {
  return new Response(bytes, {
    status,
    headers: {
      'content-type': file.blob.contentType,
      'cache-control': file.immutable
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=0, must-revalidate',
    },
  });
}

/**
 * Whether a crawler asking for `resolved` must be answered with the page rather than the fallback
 * document the build wrote for its class: a member of a Pages Router `fallback: true` route that
 * the build did not prerender. Next.js renders one blocking for a crawler rather than serve the
 * fallback (`isIsrFallback && isBot(…)`, `server/route-modules/pages/pages-handler.ts`), so that
 * what a crawler indexes is the page and not its loading state. The member is rendered and kept as
 * a `fallback: 'blocking'` member is, which is what Next.js does with it too.
 *
 * Only the Pages Router's fallback is a document of its own in this way. An App Router shell is
 * resumed for every visitor, and the crawler it treats differently — one it sends blocking
 * metadata to — it treats above.
 */
export function crawlerWantsWholePage(
  store: Store,
  shell: Prerender,
  resolved: Resolved,
  request: Request,
): boolean {
  return (
    shell.pathname !== resolved.pathname &&
    isClassShell(shell.pathname) &&
    entrypointKindOf(store, shell.route) === 'pages' &&
    isCrawler(request)
  );
}

export interface BuiltDocument {
  readonly entry: Entry;
  /** The status the document goes out with when the build did not set one. */
  readonly status: number;
}

/**
 * A document from the build: its shell, when the build made one, then its resume, as one
 * response. Without a shell, the route is rendered whole — the one kind of render the Functions
 * runtime is asked for from scratch.
 *
 * A shell that has to be resumed is of use only where the entrypoint can resume one. Next.js's
 * edge template renders with `postponed: undefined`, so a route on that runtime renders the
 * document whole and its shell is left where it is. A shell with nothing postponed is the whole
 * document already, and answers for either runtime.
 */
export async function documentFromBuild(
  input: RoutedInput,
  store: Store,
  resolved: Resolved,
  { entry, status: fallbackStatus }: BuiltDocument,
): Promise<Response> {
  // A draft, or a request a condition of the build's bypasses, asks for the page as it is now; the
  // shell was written before either existed. A crawler asks for the page rather than the fallback.
  const shell = findShell(store, resolved.route, resolved.pathname);
  if (
    bypassesPrerender(store, input.request, shell, resolved.url) ||
    (shell !== undefined && crawlerWantsWholePage(store, shell, resolved, input.request))
  ) {
    return invokeEntry(input, entry, resolved.url, {
      onFailure: failureAnswer(store, entry, resolved.route),
    });
  }
  if (shell?.body === undefined) {
    return invokeEntry(input, entry, resolved.url, {
      onFailure: failureAnswer(store, entry, resolved.route),
    });
  }
  const status = shell.initialStatus ?? fallbackStatus;
  if (shell.postponed === undefined) {
    releaseStream(input.request.body, 'static document: handler body unused');
    return withCacheState(staticResponse(store, shell, HTML_CONTENT_TYPE, status), 'HIT');
  }
  if (entry.kind === 'edge') {
    return invokeEntry(input, entry, resolved.url);
  }
  const headers = prerenderHeaders(shell, HTML_CONTENT_TYPE);
  headers.delete(POSTPONED_HEADER);
  headers.set(CACHE_CONTROL, NO_STORE_CACHE_CONTROL);
  // The headers are the shell's; nothing a resume renders would change them, so `HEAD` is
  // answered without one.
  if (input.request.method === 'HEAD') {
    return new Response(null, { status, headers });
  }
  const rest = resume({
    input,
    handler: entry.handler,
    postponed: postponedOf(store, shell),
    url: resolved.url,
  });
  return new Response(concatShell(store.readBlob(shell.body.sha256), rest), { status, headers });
}

/**
 * One prefetch segment of a prerendered page: the bytes the build shipped, the same bytes from the
 * host that kept them, or a 404.
 *
 * `undefined` only when the request asks for no segment — no header, or an empty one — or when the
 * build wrote no segment of the page at all: the caller then answers it as any request for the
 * page's React Server Components, which is what Next.js does for a page it has no segments of. A
 * page it has segments of, Next.js answers from them alone (`app-page-runtime.ts`, "Cache miss"):
 * the segment asked for, or a 404 where there is none. A segment the build recorded and whose bytes
 * neither the Function nor the host has is the same miss to the client, and gets the same answer.
 * The page's payload in its place is not: a client router read it as the route's tree, found
 * nothing it asked for and asked again straight away, for as long as the page was open — measured,
 * some 250 requests a second from one tab. A 404 it leaves alone for ten seconds, and a navigation
 * fetches what it needs.
 *
 * A record is this page's segment only as the adapter anchored it (`segmentPathOf`): the segment
 * path it answers, in the document's own group. The name alone is not enough — an application may
 * have a page of its own at a pathname that reads like another page's segment, and that page
 * neither gives the other segments nor is one.
 *
 * The host read is `AdapterOptions.unshippedOutputs`' other half. A build may record a segment and
 * leave its bytes out of the Function, which is 37% of one measured on a real application; the
 * record is what a host places from, so it stays, and a reference is then no longer a promise that
 * the file is here. **Rendering it instead was tried and cannot work**: `renderCaptured` answers
 * `undefined` whenever the render responded rather than being captured, and a segment prefetch is
 * always answered directly — measured, every time, with nothing captured to read. Resuming cannot
 * either: the postponed state is the document's, and Next.js refuses a segment it has no
 * prerendered output for with a 404.
 */
async function builtSegment(
  input: RoutedInput,
  store: Store,
  document: Prerender | undefined,
): Promise<Response | undefined> {
  const { rsc } = store.manifest.routing;
  const segment = input.request.headers.get(rsc.prefetchSegmentHeader);
  // An empty header names no part, as the classification reads it (`segmentPrefetchOf`): the
  // request is the plain RSC request it is, and is answered as one.
  if (segment === null || segment === '' || document === undefined) {
    return undefined;
  }
  const segmentOf = (segmentPath: string): Prerender | undefined => {
    const name = `${rscBase(document.pathname)}${rsc.prefetchSegmentDirSuffix}${segmentPath}`;
    const prerender = store.prerendersByPathname.get(`${name}${rsc.prefetchSegmentSuffix}`);
    return prerender?.segmentPath === segmentPath &&
      prerender.route === document.route &&
      prerender.groupId === document.groupId
      ? prerender
      : undefined;
  };
  // Next.js writes the route's tree for every page it writes segments of.
  if (segmentOf(SEGMENT_TREE_PATH) === undefined) {
    return undefined;
  }
  const prerender = segmentOf(segment);
  const bytes =
    prerender?.body === undefined
      ? undefined
      : (store.tryReadBlob(prerender.body.sha256) ?? (await fromHost(input, prerender.body)));
  if (prerender === undefined || bytes === undefined) {
    return segmentMissed(rsc.varyHeader);
  }
  const headers = prerenderHeaders(prerender, RSC_CONTENT_TYPE);
  headers.set(PRERENDER_HEADER, '1');
  headers.set(POSTPONED_HEADER, '2');
  headers.set(CACHE_CONTROL, NO_STORE_CACHE_CONTROL);
  headers.set('vary', rsc.varyHeader);
  // The bytes as the store holds them: a view onto the bundle's own buffer, which is what every
  // other blob is answered with here. Copying would be a copy per prefetch of a file the store is
  // holding on purpose; only the host's bytes are copied, and only where they come from.
  return new Response(bytes, { status: HTTP_OK, headers });
}

/**
 * Next.js's answer for a segment it has none of, on a page it has segments of: an empty 404 that
 * still says the route has them (`x-nextjs-postponed: 2`, set before the lookup), and that no
 * cache keeps — the next prefetch may find the bytes where this one did not.
 */
function segmentMissed(vary: string): Response {
  return new Response(null, {
    status: HTTP_NOT_FOUND,
    headers: { [POSTPONED_HEADER]: '2', [CACHE_CONTROL]: NO_STORE_CACHE_CONTROL, vary },
  });
}

/**
 * One blob of this bundle from the host that keeps it, for a build whose Function was not given it
 * (`AdapterOptions.unshippedOutputs`).
 *
 * `undefined` where the host keeps none, where it has no such blob, or where the read failed —
 * all three mean the same thing to the caller, which carries on as it does for a segment the build
 * never wrote. A failure is logged where the reader is built (`bundle-blobs.ts`), so a host that
 * offers this and is failing does not look like one that never offered it.
 *
 * On a buffer of its own, because a host's `Uint8Array` is backed by `ArrayBufferLike` and a
 * response body may not be: one copy of a few hundred bytes, on a path that has just been to the
 * host, which keeps the shipped segment — every other prefetch — a plain view onto the bundle the
 * store is already holding.
 */
async function fromHost(
  input: RoutedInput,
  ref: BlobRef,
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const bytes = await input.blobs?.(ref.sha256);
  return bytes === undefined ? undefined : new Uint8Array(bytes);
}

/**
 * A route's React Server Components: a prefetched segment as built, else its payload resumed —
 * and, for a route on the edge runtime, which resumes nothing, rendered whole.
 */
export async function rscFromBuild(
  input: RoutedInput,
  store: Store,
  entry: Entry,
  resolved: Resolved,
): Promise<Response> {
  const shell = findShell(store, resolved.route, resolved.pathname);
  if (bypassesPrerender(store, input.request, shell, resolved.url)) {
    return invokeEntry(input, entry, resolved.url);
  }
  const built = await builtSegment(input, store, shell);
  if (built !== undefined) {
    return built;
  }
  const twin =
    shell === undefined
      ? undefined
      : store.prerendersByPathname.get(`${rscBase(shell.pathname)}${RSC_SUFFIX}`);
  const source = twin?.postponed === undefined ? shell : twin;
  if (source?.postponed !== undefined && entry.kind === 'node') {
    return resume({
      input,
      handler: entry.handler,
      postponed: postponedOf(store, source),
      url: resolved.url,
    });
  }
  if (
    shell?.pathname === resolved.pathname &&
    shell.postponed === undefined &&
    twin?.body !== undefined &&
    twin.postponed === undefined
  ) {
    return builtPayload(store, twin);
  }
  return invokeEntry(input, entry, resolved.url);
}

/**
 * A page's whole payload as the build wrote it, for a page the build made complete: answered as
 * a platform answers it, from the build, under the status the build gave it — none, whatever the
 * page itself answered (`initialStatus: undefined` for a data route, `build/adapter/
 * build-complete.ts`). A redirect or a `notFound()` is carried in the payload, which the client's
 * router follows itself. Asked to render it, the page's handler answered from its cache under the
 * page's own status, which in minimal mode it leaves to the platform to take off (`app-page.ts`,
 * "Redirect information is encoded in RSC payload"): a client navigation to a page that redirects
 * was answered 307 (`app-dir/rsc-redirect`).
 */
function builtPayload(store: Store, twin: Prerender): Response {
  const response = staticResponse(store, twin, RSC_CONTENT_TYPE, twin.initialStatus ?? HTTP_OK);
  response.headers.set(CACHE_CONTROL, NO_STORE_CACHE_CONTROL);
  response.headers.set('vary', store.manifest.routing.rsc.varyHeader);
  return withCacheState(response, 'HIT');
}

/**
 * The entrypoint that renders a not-found, under the name its router gives it: the App Router's
 * `/_not-found`, and the Pages Router's `/404` — the page an application writes as `pages/404`,
 * which renders like any other and reads the request when it has `getStaticProps`. Next.js names
 * every output under the `basePath`, this one included.
 */
async function notFoundEntry(
  input: RoutedInput,
  basePath: string,
): Promise<{ readonly entry: Entry; readonly route: string } | undefined> {
  for (const name of [NOT_FOUND_ENTRY_ID, NOT_FOUND_PAGE]) {
    const route = `${basePath}${name}`;
    const entry = await entryFor(input, route);
    if (entry !== undefined) {
      return { entry, route };
    }
  }
  return undefined;
}

/**
 * The Pages Router's error page, for a document that landed nowhere in an application with no page
 * of its own for that: Next.js's own server sets 404 and renders `/_error` when there is neither a
 * `/_not-found` nor a `/404` (`renderErrorToResponseImpl`, `server/base-server.ts`). A build has no
 * `/404` when it could not write one at build time — an `_app` with `getInitialProps` is the common
 * case — and its error page then reads the 404 off the response (`pages/_error.tsx`), which is why
 * it is set before the render rather than put on its answer afterwards.
 *
 * Not for React Server Components: only the App Router's client asks for them, and its application
 * has a `/_not-found` of its own.
 */
async function errorPageEntry(
  input: RoutedInput,
  store: Store,
): Promise<{ readonly entry: Entry; readonly route: string } | undefined> {
  const route = `${store.manifest.config.basePath}${ERROR_ENTRY_ID}`;
  if (entrypointKindOf(store, route) !== 'pages') {
    return undefined;
  }
  const entry = await entryFor(input, route);
  return entry?.kind === 'node' ? { entry, route } : undefined;
}

/**
 * The not-found where no page of the application's own renders one: the Pages Router's error page
 * under a 404 (`errorPageEntry`), and failing that, a plain 404.
 */
async function lastNotFound(
  input: RoutedInput,
  store: Store,
  at: URL,
  rsc: boolean,
): Promise<Response> {
  const fallback = rsc ? undefined : await errorPageEntry(input, store);
  if (fallback !== undefined) {
    return invokeEntry(input, fallback.entry, `${at.pathname}${at.search}`, {
      onFailure: failureAnswer(store, fallback.entry, fallback.route),
      status: HTTP_NOT_FOUND,
    });
  }
  // Nothing below will read the body, and leaving it queued keeps the whole upload in the isolate
  // for an answer that has none.
  releaseStream(input.request.body, 'not found: handler body unused');
  return notFoundResponse();
}

/**
 * The not-found, as the request asks for it. A document: the file `next build` wrote when the
 * page was complete at build time, else the page's own shell resumed — a not-found page that
 * reads the request renders no differently from any other. React Server Components, for a
 * navigation on the client that landed nowhere: the page's payload resumed from the build's
 * state, as any route's is, under the status the not-found stands for. Failing those, the Pages
 * Router's error page under a 404 (`errorPageEntry`), and failing that too, a plain 404. Rendered
 * for `at`, the URL routing ended on, as a route is rendered for the URL it resolved to.
 */
export async function notFound(input: RoutedInput, store: Store, at: URL): Promise<Response> {
  const { basePath } = store.manifest.config;
  const rsc = isRscRequest(input.request);
  const rendered = await notFoundEntry(input, basePath);
  // A draft asks to be answered by a render rather than by what the build put away, which is
  // something to ask only of a build that kept the code to render with. A static export kept none
  // — and neither did any build whose not-found is a file and nothing else — so the document it
  // wrote is the answer for that request too: the alternative is the runtime's own bare 404 for a
  // site that has a page for exactly this.
  const rendersItself = rendered !== undefined && isDraftRequest(store, input.request);
  if (!rsc && !rendersItself) {
    // The file for a not-found page that needs nothing of the request, and the prerender for one
    // the Pages Router built with `getStaticProps`: both are the document this build wrote.
    const pathname = `${basePath}${NOT_FOUND_PAGE}`;
    const file = store.staticFiles.get(pathname);
    const stored = store.prerendersByPathname.get(pathname);
    const page =
      (file === undefined
        ? undefined
        : await staticFileResponse(input, store, file, HTTP_NOT_FOUND)) ??
      (stored?.body === undefined
        ? undefined
        : staticResponse(store, stored, HTML_CONTENT_TYPE, stored.initialStatus ?? HTTP_NOT_FOUND));
    if (page !== undefined) {
      releaseStream(input.request.body, 'static not found: handler body unused');
      return page;
    }
  }
  if (rendered === undefined) {
    return lastNotFound(input, store, at, rsc);
  }
  const { entry, route } = rendered;
  const resolved: Resolved = { route, pathname: route, url: `${at.pathname}${at.search}` };
  if (!rsc) {
    const document = await documentFromBuild(input, store, resolved, {
      entry,
      status: HTTP_NOT_FOUND,
    });
    // A shell of the not-found carries the status the build recorded for it; a render of the page
    // answers 200, as it would at its own URL. The status a miss stands for is the platform's to
    // put on it, and a render that failed keeps the status that says so.
    if (document.status !== HTTP_OK) {
      return document;
    }
    return new Response(document.body, { status: HTTP_NOT_FOUND, headers: document.headers });
  }
  const payload = await rscFromBuild(input, store, entry, resolved);
  // A payload rendered goes out under the status the not-found stands for; a render that failed,
  // or answered with something other than a payload, keeps the status that says so.
  if (!payload.ok) {
    return payload;
  }
  return new Response(payload.body, { status: HTTP_NOT_FOUND, headers: payload.headers });
}
