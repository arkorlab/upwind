/**
 * A request's body, split between the two that may read it: the middleware, which the router
 * hands it to, and whatever answers the request once routing is done.
 *
 * `tee()` keeps every chunk one side reads queued for the other until that side reads it too, so
 * a side read late — or never — holds the whole body in the isolate: a 90 MB upload to a route
 * handler, held twice in a Function of 128 MB. So the middleware's side is made only when a
 * middleware may run, and it is given a copy of no more than Next.js buffers for a proxy
 * (`proxyClientMaxBodySize`); what answers the request gets the body whole. The copy is the
 * middleware's for as long as it is read, work it left to `waitUntil` included, and it is never
 * more than the limit.
 */

const KIB = 1024;
const MIB = KIB * KIB;
const DEFAULT_PROXY_BODY_LIMIT_MIB = 10;
/** Next.js's own default for `experimental.proxyClientMaxBodySize`. */
export const DEFAULT_PROXY_BODY_LIMIT = DEFAULT_PROXY_BODY_LIMIT_MIB * MIB;

export interface SplitBody {
  /** What the middleware is handed: the first bytes of the body, or none when no middleware runs. */
  readonly routing: ReadableStream<Uint8Array> | null;
  /** What answers the request is handed: the body whole. */
  readonly handler: ReadableStream<Uint8Array> | null;
  /** Stop copying for the middleware's side: nothing reads it, and nothing more is kept for it. */
  releaseRouting(reason: string): void;
}

/** Where the middleware's side ends: the limit, and the request that is named when it is reached. */
export interface ProxyBodyLimit {
  readonly limit: number;
  readonly url: string;
}

/**
 * The two sides over one reader of the body. Whichever side asks, one chunk is read: the handler's
 * side is given it, and the middleware's a copy of it while the copies stay within the limit —
 * then that side ends, with the warning Next.js gives, as a proxy's body does in Next.js. So what
 * either side holds unread is bounded by the limit: the handler's, by what the middleware read
 * ahead of it; the middleware's, by the copies it has not read yet.
 */
function splitAt(source: ReadableStream<Uint8Array>, proxy: ProxyBodyLimit): SplitBody {
  const reader = source.getReader();
  let copied = 0;
  let handlerOpen = true;
  let routingOpen = true;
  // Why each side stopped, handed to the body as `tee()` hands them: the middleware's, the handler's.
  let routingReason: unknown;
  let handlerReason: unknown;
  let released = false;
  let reading: Promise<void> | undefined;
  let handlerSide: ReadableStreamDefaultController<Uint8Array> | undefined;
  let routingSide: ReadableStreamDefaultController<Uint8Array> | undefined;

  const closeRouting = (reason: unknown): void => {
    if (!routingOpen) {
      return;
    }
    routingOpen = false;
    routingReason = reason;
    routingSide?.close();
  };
  /** Once neither side will read another byte, neither does the body. */
  const releaseSource = (): void => {
    if (handlerOpen || routingOpen || released) {
      return;
    }
    released = true;
    void reader.cancel([routingReason, handlerReason]).catch(() => {
      // Already done with, or never acknowledged: nothing else to release.
    });
  };
  const copy = (chunk: Uint8Array): void => {
    const room = proxy.limit - copied;
    if (room > 0) {
      const kept = chunk.byteLength <= room ? chunk : chunk.subarray(0, room);
      routingSide?.enqueue(new Uint8Array(kept));
      copied += kept.byteLength;
    }
    if (chunk.byteLength > room) {
      // The application's to act on, and said as Next.js says it: the limit is its to raise.
      // eslint-disable-next-line no-console
      console.warn(
        `Request body exceeded ${proxy.limit} bytes for ${proxy.url}. Only the first ${proxy.limit} bytes reach the proxy unless \`experimental.proxyClientMaxBodySize\` is raised.`,
      );
      closeRouting('proxy body limit reached');
      releaseSource();
    }
  };
  const readOnce = async (): Promise<void> => {
    const next = await reader.read();
    if (next.done) {
      if (handlerOpen) {
        handlerSide?.close();
      }
      closeRouting('body ended');
      return;
    }
    if (handlerOpen) {
      handlerSide?.enqueue(next.value);
    }
    if (routingOpen) {
      copy(next.value);
    }
  };
  // One read at a time, whichever side asked for it: a second ask waits for the read under way.
  const pull = async (): Promise<void> => {
    if (reading !== undefined) {
      await reading;
      return;
    }
    reading = readOnce();
    try {
      await reading;
    } finally {
      reading = undefined;
    }
  };

  // Read only when a side is read: a side nobody asks for pulls nothing from the body.
  const handler = new ReadableStream<Uint8Array>(
    {
      start: (controller) => {
        handlerSide = controller;
      },
      pull,
      cancel: (reason: unknown) => {
        handlerOpen = false;
        handlerReason = reason;
        releaseSource();
      },
    },
    { highWaterMark: 0 },
  );
  const routing = new ReadableStream<Uint8Array>(
    {
      start: (controller) => {
        routingSide = controller;
      },
      pull: () => (routingOpen ? pull() : undefined),
      cancel: (reason: unknown) => {
        routingOpen = false;
        routingReason = reason;
        releaseSource();
      },
    },
    { highWaterMark: 0 },
  );
  return {
    routing,
    handler,
    releaseRouting: (reason) => {
      closeRouting(reason);
      releaseSource();
    },
  };
}

/**
 * Split `body` for a request routing may run `proxy` on; with no middleware to run, the body is
 * not split at all and goes to what answers the request as it came.
 */
export function splitBody(
  body: ReadableStream<Uint8Array> | null,
  proxy: ProxyBodyLimit | undefined,
): SplitBody {
  if (body === null || proxy === undefined) {
    return {
      routing: null,
      handler: body,
      releaseRouting: () => {
        // Nothing was split off.
      },
    };
  }
  return splitAt(body, proxy);
}
