import {
  headerRulesFor,
  type ProjectManifest,
  type StaticFileEntry,
  staticFileKey,
} from '@stayingupwind/core/manifest';

import type { EdgeContext } from '../strategies/context.ts';
import {
  type HostedGateInput,
  type MiddlewareContinue,
  serveAfterMiddleware,
} from './hosted-gate.ts';
import {
  abandonFileRead,
  type EarlyFileRead,
  handleStaticFile,
  startFileRead,
} from './static-file.ts';

export interface HostedStaticFileInput extends HostedGateInput {
  /** The file as classified: the build of it the request's own `dpl` names. */
  readonly file: StaticFileEntry;
}

interface HostedFileInput {
  readonly request: Request;
  /** The original URL, before the middleware rewrites it. */
  readonly url: URL;
  readonly edge: EdgeContext;
  readonly manifest: ProjectManifest;
}

/** A file to answer with, under the pathname it is shipped under. */
interface ServedFile {
  readonly pathname: string;
  readonly file: StaticFileEntry;
  /** Its read, started beside the middleware, when this is the file it was started for. */
  readonly early?: EarlyFileRead | undefined;
  /** The read started for the file a middleware rewrite moved the request from, let go of. */
  readonly replaced?: EarlyFileRead | undefined;
}

/**
 * A shipped file of a hosted application, served from storage under the headers `next.config`
 * gives its path and what the middleware set.
 */
function serveFile(
  input: HostedFileInput,
  served: ServedFile,
  middleware: MiddlewareContinue | undefined,
  dispatches: number,
): Promise<Response> {
  // The request as the middleware left it. It may have removed a `Range` or an `If-None-Match`,
  // and the application's own Worker would never see them; answering 206 or 304 on headers the
  // middleware took away is the edge deciding something the application already decided.
  const request =
    middleware === undefined
      ? input.request
      : new Request(input.request, { headers: middleware.requestHeaders });
  return handleStaticFile(
    {
      request,
      pathname: served.pathname,
      file: served.file,
      edge: input.edge,
      middleware,
      middlewareDispatches: dispatches,
      // Judged on the request as it reached the edge, as the document path judges them: the
      // router runs these rules before the middleware, so neither a path it rewrote nor a header it
      // took away — or added — is what Next.js selected them with.
      configured: headerRulesFor(input.manifest, input.url, input.request.headers),
    },
    served.early,
    served.replaced,
  );
}

/**
 * The shipped file a middleware rewrite lands on, as this deployment ships it: the request's `dpl`
 * named the path it asked for, not the one it was sent to. `undefined` when `url` names no file.
 */
function shippedFileAt(manifest: ProjectManifest, url: URL): ServedFile | undefined {
  const pathname = staticFileKey(manifest, url.pathname);
  const file = pathname === undefined ? undefined : manifest.staticFiles?.[pathname];
  return pathname === undefined || file === undefined ? undefined : { pathname, file };
}

/**
 * Serve the shipped file a middleware rewrite lands on (`shippedFileAt`); `undefined` when `url`
 * names no file. `dispatches` are the middleware's, counted among the file's subrequests.
 */
export function serveHostedFile(
  input: HostedFileInput,
  url: URL,
  middleware: MiddlewareContinue | undefined,
  dispatches: number,
): Promise<Response> | undefined {
  const served = shippedFileAt(input.manifest, url);
  return served === undefined ? undefined : serveFile(input, served, middleware, dispatches);
}

/**
 * A file of a hosted application, served from storage once what runs ahead of the filesystem has
 * had its say. A middleware rewrite that keeps the file — a query it adds, or the default locale
 * Next.js puts in front of the path it rewrites to (`staticFileKey`) — keeps the build the
 * classification chose; one to another shipped file is served as that file; to anything else,
 * the Worker's.
 *
 * The file is read while the middleware runs rather than after it: the answer the middleware lets
 * through takes the read, and one it answers itself or sends elsewhere lets it go. What that costs
 * is a read of a file for a request the middleware turns away, which is the price of taking the
 * middleware's round trip off the time to the file's first byte.
 */
export function routeHostedStaticFile(input: HostedStaticFileInput): Promise<Response> {
  const { url, manifest } = input;
  let early: EarlyFileRead | undefined;
  const classified = (): ServedFile => ({ pathname: url.pathname, file: input.file, early });
  const letGo = (): void => {
    abandonFileRead(early);
    early = undefined;
  };
  return serveAfterMiddleware(input, {
    start: () => {
      early = startFileRead({
        request: input.request,
        pathname: url.pathname,
        file: input.file,
        edge: input.edge,
      });
    },
    abandon: letGo,
    serve: (middleware, dispatches) => serveFile(input, classified(), middleware, dispatches),
    rewritten: (middleware, dispatches) => {
      const kept =
        middleware.url.pathname === url.pathname ||
        staticFileKey(manifest, middleware.url.pathname) === staticFileKey(manifest, url.pathname);
      if (kept) {
        return serveFile(input, classified(), middleware, dispatches);
      }
      // The read of the file asked for is let go, and counted among the requests of the file
      // served instead. A rewrite to a path the Worker answers is a passthrough, which counts the
      // request it makes and none of what was spent deciding to make it (`passthrough.ts`).
      const replaced = early;
      letGo();
      const target = shippedFileAt(manifest, middleware.url);
      return target === undefined
        ? undefined
        : serveFile(input, { ...target, replaced }, middleware, dispatches);
    },
  });
}
