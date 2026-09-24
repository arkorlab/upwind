import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { handleAsNodeRequest } from 'cloudflare:node';

import type { NodeHandler } from './app-module.ts';
import { runWithTaskScheduler } from './tasks.ts';

/**
 * Invoke a Next.js Node.js entrypoint with a Web `Request` and get a Web `Response` back.
 *
 * The entrypoints take Node's `IncomingMessage` and `ServerResponse`, the pair every official
 * adapter hands them from a real `node:http` server. workerd provides that server:
 * `cloudflare:node`'s `handleAsNodeRequest` turns a `Request` into a request on a `node:http`
 * server the Worker listens on, and its response back into a `Response` whose body streams as
 * the handler writes — the first bytes leave as soon as headers commit, and nothing waits for
 * the handler to finish. One server per isolate, started on the first request.
 *
 * What the handler needs — the entrypoint, the URL after rewrites, the request metadata — rides
 * on the execution context workerd attaches to the request (`req.cloudflare.ctx`), which is
 * whatever object is handed to `handleAsNodeRequest`.
 */

/**
 * The async context a handler runs in. The server's request event is its own context: what the
 * request established with `AsyncLocalStorage` before it crossed the loopback (its clock, its
 * platform hooks) is re-established around the handler by this.
 */
export type Run = <T>(work: () => Promise<T>) => Promise<T>;

/** How a handler that threw before it sent anything is answered, in place of plain text. */
export type FailureAnswer = (request: IncomingMessage, response: ServerResponse) => Promise<void>;

export interface InvokeInput {
  readonly handler: NodeHandler;
  readonly request: Request;
  /** Path and query the handler sees as `req.url` (after rewrites), defaulting to the request's. */
  readonly url?: string | undefined;
  readonly requestMeta: Record<string, unknown>;
  readonly waitUntil: (promise: Promise<unknown>) => void;
  readonly run?: Run | undefined;
  /**
   * The handler is expected to answer through a callback rather than the response (a render
   * the platform captures): a response it did not commit is ended empty rather than left open.
   */
  readonly expectNoResponse?: boolean | undefined;
  /** The route's own answer to a failure, when it has one: the Pages Router's error page. */
  readonly onFailure?: FailureAnswer | undefined;
}

/** A port on the Worker's own loopback: nothing listens there but this server. */
const BRIDGE_PORT = 18_080;

/**
 * How long a render may take before the request is let go of.
 *
 * A workaround, and the reasoning behind it is inferred rather than proven. On Cloudflare, one to
 * eight percent of requests to one deployed application were ended by workerd itself — "your
 * Worker's code had hung and would never generate a response" — after 40 to 395 ms, which the
 * edge turned into a 502. They were renders of pages that fetch nothing: `/`, `/blog`, `/docs`,
 * `/pricing`. A probe deployed to find out reported an empty task queue, and while it was
 * deployed the failures stopped altogether: a timer left pending on the request was enough.
 *
 * So these renders are not deadlocked, they are let go of: this bridge runs the handler on a
 * `node:http` server over the Worker's own loopback, and workerd appears not to count what is in
 * flight there as work the outer request waits on. Appears — neither Miniflare nor the bundle
 * served locally reproduces any of it, at any concurrency, so nothing here fails without this
 * line, and the mechanism above is what the evidence suggests rather than what it shows.
 *
 * The timer is never meant to fire. It is armed when the handler is handed the request and
 * cleared when the handler answers: what it costs a request that answers is a timer set and
 * cleared. What it costs one that is genuinely stuck is this long before it fails rather than at
 * once, which is the price of not failing the ones that were never stuck at all.
 */
const RENDER_KEEPALIVE_MS = 10_000;
const HTTP_NO_CONTENT = 204;
const HTTP_INTERNAL_ERROR = 500;

/**
 * The headers workerd hands the handler cut at their first comma: those Node.js keeps one of, whose
 * repeats a `Request` joins with a comma (`multipleForbiddenHeaders` and `splitHeaderValue`, in its
 * `internal_http_server`).
 */
const CUT_AT_A_COMMA: ReadonlySet<string> = new Set([
  'authorization',
  'content-type',
  'from',
  'host',
  'if-modified-since',
  'if-unmodified-since',
  'location',
  'max-forwards',
  'proxy-authorization',
  'referer',
  'user-agent',
]);

/** What rides on the request from `invokeNodeHandler` to the server's handler. */
interface Dispatch {
  readonly input: InvokeInput;
  readonly url: string;
}

interface BridgedRequest extends IncomingMessage {
  readonly cloudflare?: { readonly ctx?: unknown };
}

async function invoke(
  dispatch: Dispatch,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const { input } = dispatch;
  const run: Run = input.run ?? ((work) => work());
  // See RENDER_KEEPALIVE_MS: pending work on the request for as long as the render is in flight.
  const keepalive = setTimeout(() => {
    // Nothing. Its being pending is the whole of it.
  }, RENDER_KEEPALIVE_MS);
  try {
    await runWithTaskScheduler(() => {
      return run(() =>
        input.handler(req, res, { waitUntil: input.waitUntil, requestMeta: input.requestMeta }),
      );
    });
    if (input.expectNoResponse === true && !res.headersSent && !res.writableEnded) {
      res.statusCode = HTTP_NO_CONTENT;
      res.end();
    }
  } catch (error) {
    await answerFailure(input, req, res, error);
    // The Worker's own log: the client sees a 500 and nothing else records why.
    // eslint-disable-next-line no-console
    console.error('next-runtime: handler failed', error);
  } finally {
    clearTimeout(keepalive);
  }
}

/**
 * Answer a handler that threw. Before anything was sent, with the route's own answer to a failure
 * when it has one, run as the handler was run, and with plain text when it has none or that fails
 * too. Past the headers the client has part of a body, and what it can still be told is that the
 * rest is not coming.
 */
async function answerFailure(
  input: InvokeInput,
  req: IncomingMessage,
  res: ServerResponse,
  error: unknown,
): Promise<void> {
  const { onFailure } = input;
  if (onFailure !== undefined && !res.headersSent) {
    const run: Run = input.run ?? ((work) => work());
    try {
      await runWithTaskScheduler(() => run(() => onFailure(req, res)));
    } catch (error_) {
      // eslint-disable-next-line no-console
      console.error('next-runtime: error page failed', error_);
    }
    if (res.writableEnded) {
      return;
    }
  }
  if (res.headersSent) {
    res.destroy(error instanceof Error ? error : new Error(String(error)));
    return;
  }
  res.statusCode = HTTP_INTERNAL_ERROR;
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  res.end('Internal Server Error');
}

/**
 * The request's headers as the request carried them.
 *
 * workerd takes a comma in a header Node.js keeps one of for the join of a repeated one, and hands
 * the handler what comes before it. A value with a comma of its own is cut short: a browser's
 * `User-Agent` has one — `(KHTML, like Gecko)` — and so does every HTTP date. Next.js was told a
 * crawler's agent up to its first comma, told the HTML-limited ones apart from a browser by what
 * was left, and streamed them the metadata it has to block for them (`app-dir/metadata-streaming`,
 * "Google speed insights bot"). The handler reads the headers once asked (`headers` is built from
 * `rawHeaders` then), so the lines are put back before it runs.
 */
function restoreHeaders(req: IncomingMessage, headers: Headers): void {
  const lines = req.rawHeaders;
  for (let index = 0; index + 1 < lines.length; index += 2) {
    const name = lines[index]?.toLowerCase() ?? '';
    const whole = CUT_AT_A_COMMA.has(name) ? headers.get(name) : null;
    if (whole !== null && whole !== lines[index + 1]) {
      lines[index + 1] = whole;
      req.headers[name] = whole;
    }
  }
}

/**
 * A `socket` the request can be given, as Node.js's can: a property of the request itself.
 *
 * Destroying a server's request takes the socket off it (`stream.socket = null`, in workerd's own
 * `streams_destroy` as in Node.js's), and `pipeline` destroys every stream in it when one of them
 * fails. workerd's `IncomingMessage` has a getter for `socket` and no setter, so the assignment
 * threw inside `pipeline`'s own handling of the failure, and the pipeline never settled. Next.js
 * reads a server action's body through one, with a transform that fails a body past
 * `serverActions.bodySizeLimit`: an action sent too large a body was never answered, and the
 * request was let go of when the render's keepalive ran out (`app-action-size-limit-invalid`).
 */
function settableSocket(req: IncomingMessage): void {
  if (Object.getOwnPropertyDescriptor(req, 'socket')?.writable === true) {
    return;
  }
  Object.defineProperty(req, 'socket', {
    configurable: true,
    enumerable: true,
    writable: true,
    value: req.socket,
  });
}

function onRequest(req: IncomingMessage, res: ServerResponse): void {
  const dispatch = (req as BridgedRequest).cloudflare?.ctx as Dispatch | undefined;
  if (dispatch === undefined) {
    // Nothing reaches this server but `invokeNodeHandler`; a request without its dispatch is
    // not one of ours.
    res.statusCode = HTTP_INTERNAL_ERROR;
    res.end('no dispatch');
    return;
  }
  req.url = dispatch.url;
  restoreHeaders(req, dispatch.input.request.headers);
  settableSocket(req);
  // Every failure is caught in `invoke`; a rejection past it would leave the response hanging.
  void invoke(dispatch, req, res).catch((error: unknown) => {
    res.destroy(error instanceof Error ? error : new Error(String(error)));
  });
}

/** The server, started by the first request that needs it. */
class Bridge {
  #listening = false;

  port(): number {
    if (!this.#listening) {
      createServer(onRequest).listen(BRIDGE_PORT);
      this.#listening = true;
    }
    return BRIDGE_PORT;
  }
}

const bridge = new Bridge();

export async function invokeNodeHandler(input: InvokeInput): Promise<Response> {
  const target = new URL(input.request.url);
  const dispatch: Dispatch = { input, url: input.url ?? `${target.pathname}${target.search}` };
  return handleAsNodeRequest(bridge.port(), input.request, undefined, dispatch);
}
