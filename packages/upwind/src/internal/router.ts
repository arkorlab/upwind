import type { IncomingMessage, ServerResponse } from 'node:http';

import { UPWIND_INTERNAL_PREFIX } from '@stayingupwind/core/paas';

import { type DevSession, readyInMs, uptimeMs } from '../dev/session.ts';
import { isTrustedHost } from './host.ts';

/**
 * What upwind answers under its own prefix, and the rules every endpoint here is held to.
 *
 * These are answered by the front door itself: a request for `/__upwind` is never handed to Next.js,
 * so it is answered while the application is still compiling and while a compile of it is failing.
 * That is the point of it — what a developer asks when nothing is working must not depend on the
 * thing that is not working.
 *
 * `/__upwind/auth` never reaches this module. It is upwind's path and the application's request, and
 * `serve.ts` hands it to Next.js before any of the rules below could apply to it — which is why they
 * can stay as strict as they are. Everything here is still `GET`/`HEAD` and still answers for this
 * machine alone; authentication is neither, and is not answered here.
 *
 * The rules:
 *
 * - `GET` and `HEAD` only, until something here has a reason to change state. Then it will need more
 *   than a method: a page on another origin can *send* a request to this port, and what stops it
 *   reading the answer is only that no CORS header is ever written below.
 * - No `access-control-allow-origin`, ever. The same-origin policy is the whole of the protection a
 *   developer's machine has here — and `host.ts` is what keeps a name that resolves to this machine
 *   from borrowing that protection.
 * - `cache-control: no-store`. Every answer describes a moment.
 * - An unknown path answers with the paths that are known, because a typo in a tool's URL should say
 *   so rather than look like a server that is not running.
 */

const STATUS_OK = 200;
const STATUS_FORBIDDEN = 403;
const STATUS_NOT_FOUND = 404;
const STATUS_METHOD_NOT_ALLOWED = 405;
const STATUS_UNAVAILABLE = 503;
const ALLOWED_METHODS = 'GET, HEAD';

interface Answer {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

/** What every answer here carries, so a caller can tell this run's door from any other (`probe.ts`). */
const RUN_HEADER = 'x-upwind-run';

/** Keyed by what follows the prefix, so `''` is `/__upwind` itself. */
type Endpoint = (session: DevSession) => Answer;

const ENDPOINTS = new Map<string, Endpoint>([
  ['', session],
  ['/health', health],
]);

/**
 * Every path this answers, read off the table itself rather than listed again: an endpoint added to
 * the table above is one a 404 and the session report both already know about.
 */
const ENDPOINT_PATHS: readonly string[] = [...ENDPOINTS.keys()].map(
  (rest) => `${UPWIND_INTERNAL_PREFIX}${rest}`,
);

/** What this run is, as anything that has to know about it can read it. */
function session(devSession: DevSession): Answer {
  return {
    status: STATUS_OK,
    body: {
      upwind: devSession.upwindVersion ?? null,
      next: devSession.nextVersion ?? null,
      ready: devSession.readyTick !== undefined,
      address: devSession.address ?? null,
      prefix: UPWIND_INTERNAL_PREFIX,
      projectDir: devSession.projectDir,
      adapter: devSession.adapterPath ?? null,
      startedAt: new Date(devSession.startedAt).toISOString(),
      readyInMs: readyInMs(devSession) ?? null,
      endpoints: ENDPOINT_PATHS,
    },
  };
}

/**
 * Whether the application can be asked for anything yet.
 *
 * `503` until Next.js has prepared, so a script can wait for a dev server the way it would wait for
 * any other: ask until it says yes.
 */
function health(devSession: DevSession): Answer {
  const ready = devSession.readyTick !== undefined;
  return {
    status: ready ? STATUS_OK : STATUS_UNAVAILABLE,
    body: {
      status: ready ? 'ready' : 'starting',
      uptimeMs: uptimeMs(devSession),
    },
  };
}

function write(res: ServerResponse, answer: Answer, runId: string, headOnly: boolean): void {
  const payload = `${JSON.stringify(answer.body, null, 2)}\n`;
  res.writeHead(answer.status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    [RUN_HEADER]: runId,
  });
  if (headOnly) {
    res.end();
    return;
  }
  res.end(payload);
}

/** `/__upwind/health/` asks the same thing as `/__upwind/health`; the prefix itself keeps its shape. */
function endpointKey(pathname: string): string {
  return pathname.slice(UPWIND_INTERNAL_PREFIX.length).replace(/\/$/u, '');
}

/**
 * Answer a request for the internal prefix. Never falls through: a path under `/__upwind` that
 * nothing here claims is a 404 from upwind, not a page the application might have.
 */
export function answerInternal(
  pathname: string,
  req: IncomingMessage,
  res: ServerResponse,
  devSession: DevSession,
): void {
  const method = req.method ?? 'GET';
  // Decided before anything is written, because a `HEAD` carries no body whatever the answer is — a
  // refusal included, or a keep-alive client reads the bytes it was promised as the next response.
  const headOnly = method === 'HEAD';
  if (!isTrustedHost(req.headers.host, req.headers['x-forwarded-host'], devSession.hostname)) {
    write(
      res,
      {
        status: STATUS_FORBIDDEN,
        body: {
          error: `${UPWIND_INTERNAL_PREFIX} is answered for this machine's own names only`,
          host: req.headers.host ?? null,
          forwarded: req.headers['x-forwarded-host'] ?? null,
        },
      },
      devSession.runId,
      headOnly,
    );
    return;
  }
  if (method !== 'GET' && method !== 'HEAD') {
    res.setHeader('allow', ALLOWED_METHODS);
    write(
      res,
      {
        status: STATUS_METHOD_NOT_ALLOWED,
        body: {
          error: `${method} is not allowed under ${UPWIND_INTERNAL_PREFIX}`,
          allow: ALLOWED_METHODS,
        },
      },
      devSession.runId,
      headOnly,
    );
    return;
  }
  const endpoint = ENDPOINTS.get(endpointKey(pathname));
  const answer =
    endpoint === undefined
      ? {
          status: STATUS_NOT_FOUND,
          body: { error: `no upwind endpoint at ${pathname}`, endpoints: ENDPOINT_PATHS },
        }
      : endpoint(devSession);
  write(res, answer, devSession.runId, headOnly);
}
