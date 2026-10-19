import {
  type ConfiguredHeaders,
  type ProjectManifest,
  staticFileBuildWithoutDpl,
  type StaticFileEntry,
  staticFileKey,
} from '@stayingupwind/core/manifest';
import { NULL_BODY_STATUSES } from '@stayingupwind/core/request';
import { releaseStream } from '@stayingupwind/core/util';

import type { StaticFileContext } from '../strategies/context.ts';
import {
  type DeferredHostedGateInput,
  type HostedGate,
  serveAfterMiddleware,
  type TimedContinue,
} from './hosted-gate.ts';
import { headerRulesAsRouted } from './middleware.ts';
import {
  abandonFileRead,
  type EarlyFileRead,
  handleStaticFile,
  requestsOf,
  startFileRead,
} from './static-file.ts';

export interface HostedStaticFileInput extends DeferredHostedGateInput {
  /** The file as classified: the build of it the request's own `dpl` names. */
  readonly file: StaticFileEntry;
}

interface HostedFileInput {
  readonly request: Request;
  /** The original URL, before the middleware rewrites it. */
  readonly url: URL;
  readonly edge: StaticFileContext;
  readonly manifest: ProjectManifest;
  /** Rules already selected for the original request before its middleware ran. */
  readonly configured?: ConfiguredHeaders | undefined;
}

/** A file to answer with, under the pathname it is shipped under. */
interface ServedFile {
  readonly pathname: string;
  readonly file: StaticFileEntry;
  readonly configured?: ConfiguredHeaders | undefined;
  /** Its read, started beside the middleware, when this is the file it was started for. */
  readonly early?: EarlyFileRead | undefined;
  /** The read started for the file a middleware rewrite moved the request from, let go of. */
  readonly replaced?: EarlyFileRead | undefined;
}

const HTTP_OK = 200;

/**
 * A shipped file's answer under the status the middleware gave its rewrite (`rewriteStatus`), as
 * Next.js answers it: its router puts the status on the response before the file server sends the
 * file (`res.statusCode = middlewareRes.status`, in `resolve-routes.js`), and the file server sets
 * one of its own only for a range, a request it answers 304 and an error (`send`). So only an
 * answer of 200 takes it, its body let go of where the status carries none — which the file's
 * metric counts as nothing sent (`wholeFileSent`, in `static-file.ts`).
 */
function underRewriteStatus(response: Response, status: number): Response {
  if (response.status !== HTTP_OK) {
    return response;
  }
  if (NULL_BODY_STATUSES.has(status)) {
    releaseStream(response.body, 'rewrite status: no body');
    // Nor the length of one: the file's would frame a body the answer never sends.
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    return new Response(null, { status, headers });
  }
  return new Response(response.body, { status, headers: response.headers });
}

async function answeredUnder(answered: Promise<Response>, status: number): Promise<Response> {
  return underRewriteStatus(await answered, status);
}

/**
 * A shipped file of a hosted application, served from storage under the headers `next.config`
 * gives its path and what the middleware set, and under the status it gave its rewrite.
 */
function serveFile(
  input: HostedFileInput,
  served: ServedFile,
  middleware: TimedContinue | undefined,
  dispatches: number,
): Promise<Response> {
  // The request as the middleware left it. It may have removed a `Range` or an `If-None-Match`,
  // and the application's own Worker would never see them; answering 206 or 304 on headers the
  // middleware took away is the edge deciding something the application already decided.
  const request =
    middleware === undefined
      ? input.request
      : new Request(input.request, { headers: middleware.requestHeaders });
  const answered = handleStaticFile(
    {
      request,
      pathname: served.pathname,
      file: served.file,
      edge: input.edge,
      middleware,
      middlewareDispatches: dispatches,
      middlewareMs: middleware?.middlewareMs,
      // Judged on the request as it reached the edge, less the host's credentials, as the document
      // path judges them: the router runs these rules before the middleware, so neither a path it
      // rewrote nor a header it took away — or added — is what Next.js selected them with.
      configured:
        served.configured ??
        input.configured ??
        headerRulesAsRouted(input.edge, input.manifest, input.url, input.request.headers),
    },
    served.early,
    served.replaced,
  );
  // A file the middleware gave no status keeps the answer as it comes, with nothing added before it.
  const status = middleware?.rewriteStatus;
  return status === undefined ? answered : answeredUnder(answered, status);
}

/**
 * The shipped file a middleware rewrite lands on, as this deployment ships it: the request's `dpl`
 * named the path it asked for, not the one it was sent to. So the build is chosen as for a request
 * naming no deployment (`staticFileBuildWithoutDpl`), and a build kept from the deployment before
 * that answers only its own `dpl` is no file of this one's. `undefined` when `url` names no file.
 */
export function shippedFileAt(manifest: ProjectManifest, url: URL): ServedFile | undefined {
  const pathname = staticFileKey(manifest, url.pathname);
  const entry = pathname === undefined ? undefined : manifest.staticFiles?.[pathname];
  const file =
    entry === undefined ? undefined : staticFileBuildWithoutDpl(entry, manifest.deployment.dplId);
  return pathname === undefined || file === undefined ? undefined : { pathname, file };
}

/**
 * Serve the shipped file a middleware rewrite lands on (`shippedFileAt`); `undefined` when `url`
 * names no file. `dispatches` are the middleware's, counted among the file's subrequests.
 */
export function serveHostedFile(
  input: HostedFileInput,
  url: URL,
  middleware: TimedContinue | undefined,
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
  let servedInput: HostedFileInput = input;
  let early: EarlyFileRead | undefined;
  function classified(configured: ConfiguredHeaders): ServedFile {
    return { pathname: url.pathname, file: input.file, early, configured };
  }
  const letGo: NonNullable<HostedGate['abandon']> = (
    counted = false,
  ): Promise<number> | undefined => {
    const abandoned = early;
    abandonFileRead(abandoned);
    early = undefined;
    return counted && abandoned !== undefined ? requestsOf(abandoned) : undefined;
  };
  return serveAfterMiddleware(input, {
    ready: (edge) => {
      servedInput = { ...input, edge };
    },
    // Under what the rules set on the path, as the answer will be: a precondition a rule's
    // `Last-Modified` fails is the manifest's to answer, with no read begun beside the middleware.
    start: (configured) => {
      early = startFileRead({
        request: input.request,
        pathname: url.pathname,
        file: input.file,
        edge: servedInput.edge,
        configured,
      });
    },
    abandon: letGo,
    serve: (middleware, dispatches, configured) =>
      serveFile(servedInput, classified(configured), middleware, dispatches),
    rewritten: (middleware, dispatches, configured) => {
      const kept =
        middleware.url.pathname === url.pathname ||
        staticFileKey(manifest, middleware.url.pathname) === staticFileKey(manifest, url.pathname);
      if (kept) {
        return serveFile(servedInput, classified(configured), middleware, dispatches);
      }
      // The read of the file asked for is let go, and counted among the requests of the file
      // served instead. A rewrite to a path the Worker answers is a passthrough, which counts the
      // request it makes and none of what was spent deciding to make it (`passthrough.ts`).
      const replaced = early;
      letGo(false);
      const target = shippedFileAt(manifest, middleware.url);
      return target === undefined
        ? undefined
        : serveFile(servedInput, { ...target, replaced, configured }, middleware, dispatches);
    },
  });
}
