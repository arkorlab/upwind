import type { BlobRef, Prerender } from '@stayingupwind/core/bundle';
import { NO_STORE_CACHE_CONTROL } from '@stayingupwind/core/request';
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

export function staticFileResponse(
  store: Store,
  pathname: string,
  status: number,
): Response | undefined {
  const file = store.staticFiles.get(pathname);
  if (file === undefined) {
    return undefined;
  }
  return new Response(store.readBlob(file.blob.sha256), {
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
    return invokeEntry(input, entry, resolved.url, failureAnswer(store, entry, resolved.route));
  }
  if (shell?.body === undefined) {
    return invokeEntry(input, entry, resolved.url, failureAnswer(store, entry, resolved.route));
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
 * A route's React Server Components: a prefetched segment as built, else its payload resumed —
 * and, for a route on the edge runtime, which resumes nothing, rendered whole.
 */
/**
 * One prefetch segment of a prerendered page: the bytes the build shipped, or the same bytes from
 * the host that kept them.
 *
 * `undefined` when the request asks for no segment, when the build wrote none under this key, or
 * when neither the Function nor the host has the bytes — the caller then carries on as it does for
 * a document whose shell the build did not write.
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
  pathname: string,
): Promise<Response | undefined> {
  const { rsc } = store.manifest.routing;
  const segment = input.request.headers.get(rsc.prefetchSegmentHeader);
  if (segment === null) {
    return undefined;
  }
  const dir = rsc.prefetchSegmentDirSuffix;
  const key = `${rscBase(pathname)}${dir}${segment}${rsc.prefetchSegmentSuffix}`;
  const prerender = store.prerendersByPathname.get(key);
  if (prerender?.body === undefined) {
    return undefined;
  }
  const bytes = store.tryReadBlob(prerender.body.sha256) ?? (await fromHost(input, prerender.body));
  if (bytes === undefined) {
    return undefined;
  }
  const headers = prerenderHeaders(prerender, RSC_CONTENT_TYPE);
  headers.set(PRERENDER_HEADER, '1');
  headers.set(POSTPONED_HEADER, '2');
  headers.set(CACHE_CONTROL, NO_STORE_CACHE_CONTROL);
  headers.set('vary', rsc.varyHeader);
  return new Response(new Uint8Array(bytes), { status: HTTP_OK, headers });
}

/**
 * One blob of this bundle from the host that keeps it, for a build whose Function was not given it
 * (`AdapterOptions.unshippedOutputs`).
 *
 * `undefined` where there is no host, where the host does not answer this, or where it has no such
 * blob — all three mean the same thing to the caller, which carries on as it does for a segment the
 * build never wrote. Nothing reaches here on a path that works: the host answers these prefetches
 * from its own storage, and the Function is asked only for the ones it could not.
 *
 * Not memoised. A read that happens once per request on a fallback is not worth a cache that would
 * hold a build's bytes in an isolate serving every other request — and the host is the one that
 * knows how to cache it.
 */
async function fromHost(input: RoutedInput, ref: BlobRef): Promise<Uint8Array | undefined> {
  const host = input.cache?.host;
  if (host === undefined) {
    return undefined;
  }
  try {
    return await host.readBundleBlob?.(ref.sha256);
  } catch {
    // A host that cannot answer is a segment the Function does not have, not a failed request:
    // the caller resumes, and the client that asked for a prefetch navigates instead.
    return undefined;
  }
}

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
  const built = await builtSegment(input, store, shell?.pathname ?? resolved.pathname);
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
 * The not-found, as the request asks for it. A document: the file `next build` wrote when the
 * page was complete at build time, else the page's own shell resumed — a not-found page that
 * reads the request renders no differently from any other. React Server Components, for a
 * navigation on the client that landed nowhere: the page's payload resumed from the build's
 * state, as any route's is, under the status the not-found stands for. Failing every one, a
 * plain 404. Rendered for `at`, the URL routing ended on, as a route is rendered for the URL it
 * resolved to.
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
    const stored = store.prerendersByPathname.get(pathname);
    const page =
      staticFileResponse(store, pathname, HTTP_NOT_FOUND) ??
      (stored?.body === undefined
        ? undefined
        : staticResponse(store, stored, HTML_CONTENT_TYPE, stored.initialStatus ?? HTTP_NOT_FOUND));
    if (page !== undefined) {
      releaseStream(input.request.body, 'static not found: handler body unused');
      return page;
    }
  }
  if (rendered === undefined) {
    // Nothing below will read the body, and leaving it queued keeps the whole upload in the
    // isolate for an answer that has none.
    releaseStream(input.request.body, 'not found: handler body unused');
    return new Response('Not Found', { status: HTTP_NOT_FOUND });
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
