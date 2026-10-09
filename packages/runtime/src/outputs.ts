import {
  pageOfDataPathname,
  pagesDataPathnameUnder,
  type Prerender,
  queryDependent,
  underBasePath,
} from '@stayingupwind/core/bundle';
import { MIDDLEWARE_PREFETCH_HEADER } from '@stayingupwind/core/request';

import { notFound, rscFromBuild } from './documents.ts';
import { entryFor } from './entries.ts';
import { type GenerationSource, serveFromGeneration, speculative } from './generations.ts';
import { notFoundData } from './pages-not-found.ts';
import { rscRepresentation } from './representations.ts';
import {
  bypassesPrerender,
  HTTP_OK,
  invokeEntry,
  notFoundResponse,
  type RoutedInput,
  staticResponse,
  withCacheState,
} from './serve.ts';
import { completedShell, findShell, type Store } from './store.ts';
import { renderedBy } from './with-body.ts';

/**
 * The outputs of an entry beside its document, which the Function answers itself: a Pages Router
 * page's data route, an App Router page's payload and its prefetched segments, and a route handler
 * rendered at build. Each is served from the entry's current generation as the document is, from
 * the build's own output while the cache holds none, and by the handler where the build made
 * nothing to keep.
 *
 * A route on Next.js's edge runtime has no generation: it is rendered whole, as its handler
 * renders it, whatever the build wrote for it. What the render itself fetched is kept, in the
 * deployment's data cache, as any other render's is.
 */

const JSON_UTF8_TYPE = 'application/json; charset=utf-8';
const OCTET_STREAM = 'application/octet-stream';
const MATCHED_PATH_HEADER = 'x-nextjs-matched-path';
const NEVER_STORED = 'private, no-cache, no-store, max-age=0, must-revalidate';

/**
 * A client router's prefetch through a middleware, of a page whose props are not static: Next.js
 * renders nothing for it and answers `{}`, marked `x-middleware-skip`, with the page it matched
 * (`server/base-server.ts`); the navigation that follows asks for the props for real. Rendered and
 * answered with the props instead, the prefetch was the navigation's answer as well: the client
 * never asked again, and `getServerSideProps` ran for a link nobody followed.
 */
function prefetchSkipped(page: string): Response {
  return new Response(new TextEncoder().encode('{}'), {
    headers: {
      [MATCHED_PATH_HEADER]: page,
      'x-middleware-skip': '1',
      'cache-control': NEVER_STORED,
    },
  });
}

/**
 * The page a data route answers for, as Next.js names it to the client's router in
 * `x-nextjs-matched-path` (`route-modules/route-module.ts`, `server/base-server.ts`): the page the
 * build defines — `/[...path]` for a member of a dynamic route, not the member — under the locale its
 * route is under, and without the base path. The client reads a member's name back through the base
 * path twice (`getNextPathnameInfo`, then `removeBasePath`, which takes the base path's length off
 * unasked): under `/docs`, the member `/docs/first` came back as `/t`, and the catch-all's query as
 * `["t"]`. A page it is given as a pattern, it resolves from the URL it asked for instead.
 */
function matchedPathOf(store: Store, route: string): string {
  const { buildId, config } = store.manifest;
  return underBasePath(
    config.basePath,
    pageOfDataPathname(buildId, config.basePath, route) ?? route,
  );
}

export interface Resolved {
  readonly route: string;
  readonly pathname: string;
  readonly url: string;
}

/** The type a prerender's body was recorded with; a route handler's is whatever it answered. */
function recordedContentType(prerender: Prerender): string {
  const value = prerender.initialHeaders?.['content-type'];
  if (value === undefined) {
    return OCTET_STREAM;
  }
  return typeof value === 'string' ? value : (value[0] ?? OCTET_STREAM);
}

/** What a data request is for: the page, the data route's own name, and the URL to render at. */
interface DataTarget {
  readonly page: string;
  readonly data: string;
  readonly url: string;
}

/**
 * The data route a request resolved to, whichever way routing put it.
 *
 * A data URL the build left an output for resolves by its own name. One it did not — an unbuilt
 * member of a route with a fallback — is normalized to its page before the dynamic matchers run,
 * and the page is all the router hands back; the handler has to be told which of the two the
 * client asked for, since the `_next/data` prefix is what Next.js reads the kind of the request
 * from (`route-modules/route-module.ts`) and what makes it answer with props rather than a
 * document.
 */
function dataTargetOf(store: Store, resolved: Resolved): DataTarget {
  const { buildId, config } = store.manifest;
  const page = pageOfDataPathname(buildId, config.basePath, resolved.pathname);
  if (page !== undefined) {
    return { page, data: resolved.pathname, url: resolved.url };
  }
  const at = resolved.url.indexOf('?');
  const search = at === -1 ? '' : resolved.url.slice(at);
  const data = pagesDataPathnameUnder(buildId, config.basePath, resolved.pathname);
  return { page: resolved.pathname, data, url: `${data}${search}` };
}

/**
 * A Pages Router data route: the props of the page's current generation, as the page's own
 * `getStaticProps` returned them. The route resolves to the data template of a page; the page's
 * entry is the one served, under its own pathname.
 *
 * A page whose props come from `getServerSideProps` is the other shape: the build gives its data
 * route an entrypoint of its own, nothing is kept of it, and it renders for every request.
 */
export async function servePagesData(
  input: RoutedInput,
  store: Store,
  resolved: Resolved,
): Promise<Response> {
  const target = dataTargetOf(store, resolved);
  const template = store.prerendersByPathname.get(resolved.route);
  // No prerender: props from `getServerSideProps`, through the route's own entrypoint — and for a
  // middleware's prefetch of them, nothing at all (`prefetchSkipped`).
  if (template === undefined) {
    const own = await entryFor(input, resolved.route);
    if (own === undefined) {
      return notFoundData();
    }
    return input.request.headers.has(MIDDLEWARE_PREFETCH_HEADER)
      ? prefetchSkipped(matchedPathOf(store, resolved.route))
      : invokeEntry(input, own, target.url);
  }
  // A prerendered page's props, an SSG fallback's included, come from its current generation or the
  // build, whatever entrypoint the route has besides: the page's own, where routing normalized an
  // unbuilt data URL to it, would render past the generation every visitor gets.
  const entry = await entryFor(input, template.route);
  if (entry === undefined) {
    return notFoundData();
  }
  const shell = findShell(store, template.route, target.page);
  // A draft or a bypass condition asks the page for the props it would render now: neither the
  // build's output nor a generation of it is an answer (`draft.ts`).
  if (
    entry.kind === 'edge' ||
    bypassesPrerender(store, input.request, template, target.url) ||
    bypassesPrerender(store, input.request, shell, target.url) ||
    // Props that depend on a query the route does not name: the build's data answered one query,
    // not this request's, and no generation stands for it either (`serveFromGeneration`).
    queryDependent(
      store.prerendersByPathname.get(target.page) ?? shell,
      template.route,
      target.page,
    )
  ) {
    return invokeEntry(input, entry, target.url);
  }
  const built = store.prerendersByPathname.get(target.data);
  const current = await serveFromGeneration(
    input,
    store,
    {
      route: template.route,
      pathname: target.page,
      url: target.url,
      representation: 'pages-data',
      dataPathname: target.data,
      onMiss: built?.body === undefined ? 'render' : 'build',
    },
    entry.handler,
  );
  if (current !== undefined) {
    return current;
  }
  if (built?.body !== undefined) {
    return withCacheState(
      staticResponse(store, built, JSON_UTF8_TYPE, built.initialStatus ?? HTTP_OK),
      'HIT',
    );
  }
  return invokeEntry(input, entry, target.url);
}

/**
 * A route handler: served from its current generation when the build rendered it, whole; run
 * for the request otherwise, as a handler that reads the request has to be.
 */
export async function serveRouteHandler(
  input: RoutedInput,
  store: Store,
  resolved: Resolved,
): Promise<Response> {
  const entry = await entryFor(input, resolved.route);
  if (entry === undefined) {
    return notFoundResponse();
  }
  const built = store.prerendersByPathname.get(resolved.pathname);
  if (
    entry.kind === 'edge' ||
    bypassesPrerender(store, input.request, built, resolved.url) ||
    built?.body === undefined ||
    // Next.js classifies its outputs from 16.3 on, and this is the handler's own response only if
    // it says so. Before that it classifies nothing, and what stands in its place is the caller's
    // own question: nothing reaches here but an `app-route` (`handle.ts`), and a route handler has
    // no second output at its pathname for this to be mistaken for.
    (built.routeType ?? 'route') !== 'route' ||
    // An answer that depends on a query the route does not name: the build's body is one query's.
    queryDependent(built, resolved.route, resolved.pathname)
  ) {
    return invokeEntry(input, entry, resolved.url);
  }
  const current = await serveFromGeneration(
    input,
    store,
    {
      route: resolved.route,
      pathname: resolved.pathname,
      url: resolved.url,
      representation: 'route-body',
      onMiss: 'build',
    },
    entry.handler,
  );
  return (
    current ??
    withCacheState(
      staticResponse(store, built, recordedContentType(built), built.initialStatus ?? HTTP_OK),
      'HIT',
    )
  );
}

/**
 * Where a React Server Components request of a page is answered from: the entry its document is
 * (`serveDocument`), and what to do where the cache holds none.
 *
 * A member the build did not render of a route whose every navigation is static (`ensureStatic`)
 * is rendered once and kept, as its document is: Next.js answers it with a blocking render rather
 * than a dynamic one (`isDynamicRSCRequest`, in the page's handler), and resuming the class's state
 * here answered nothing at all. A member of a route that blocks, of whose class the build made no
 * shell, is kept under the shell its class completes to (`completedShell`); a prefetch of it before
 * anything is kept is answered from the class's own output — which leaves out what its parameters
 * hold up, a root layout that reads one — and the entry is rendered behind that answer, for the
 * requests after it.
 */
function rscSource(
  input: RoutedInput,
  store: Store,
  shell: Prerender | undefined,
  resolved: Resolved,
): GenerationSource {
  const blocking = shell?.ensureStatic === 'navigation' && shell.pathname !== resolved.pathname;
  const unbuilt = shell !== undefined && shell.body === undefined;
  const want = {
    representation: rscRepresentation(input.request, store),
    url: resolved.url,
    prefetch: input.request.headers.get(store.manifest.routing.rsc.prefetchHeader) === '1',
  };
  let pathname = resolved.pathname;
  if (shell !== undefined && !blocking) {
    pathname = unbuilt ? completedShell(shell, resolved.pathname) : shell.pathname;
  }
  let onMiss: GenerationSource['onMiss'] = 'build';
  if (blocking) {
    onMiss = 'render';
  } else if (unbuilt && speculative(want)) {
    onMiss = 'behind';
  }
  // Under the route the build filed the shell under, which its entry is keyed by, as a document is.
  return { route: shell?.route ?? resolved.route, pathname, ...want, onMiss };
}

/**
 * Serve a React Server Components request: resume from the current generation's state for a
 * navigation, serve its static payload for a prefetch, or fall back to the build's state.
 *
 * A regeneration commits the payload and every prefetched segment it produced beside the
 * document. Answering these from the build while documents come from a newer generation is how a
 * client navigation lands on a page assembled out of two of them.
 */
export async function serveRsc(
  input: RoutedInput,
  store: Store,
  asked: Resolved,
): Promise<Response> {
  const rendered = await renderedBy(input, store, asked);
  if (rendered === undefined) {
    return notFound(input, store, new URL(input.request.url));
  }
  const { entry, resolved } = rendered;
  if (entry.kind === 'node') {
    const shell = findShell(store, resolved.route, resolved.pathname);
    const source = rscSource(input, store, shell, resolved);
    const current = await serveFromGeneration(input, store, source, entry.handler);
    if (current !== undefined) {
      return current;
    }
    // Rendered for the request where nothing kept the blocking render — no cache, or none it may
    // keep: the class's state is what answered such a member with nothing at all.
    if (source.onMiss === 'render') {
      return invokeEntry(input, entry, resolved.url);
    }
  }
  return rscFromBuild(input, store, entry, resolved);
}
