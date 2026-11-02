import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { finished } from 'node:stream';

const KIB = 1024;
/**
 * What workerd's server allows a request whose answer left its body unread (KJ's
 * `HttpServerSettings`, `canceledUploadGraceBytes` and `canceledUploadGracePeriod`): the client may
 * finish sending it, up to this many more bytes within this long, and the connection then carries
 * its next request. Past either, the connection is closed.
 */
const UNREAD_GRACE_KIB = 64;
const UNREAD_GRACE_BYTES = UNREAD_GRACE_KIB * KIB;
const UNREAD_GRACE_MS = 1000;
/**
 * How long a connection closed that way is kept once its end is sent. Bytes left unread make its
 * close a reset, which can cost the client an answer it has not read yet (RFC 9112, section 9.6),
 * so it is dropped this much later, or as soon as the client closes it.
 */
const CLOSING_LINGER_MS = 500;
/** What a read of a body fails with once its answer has gone out, as it does in workerd. */
const LATE_READ = "Can't read from request stream after response has been sent.";

/** Read and drop what the answer left of a body, within the grace; past it, close the connection. */
function dropUnread(req: IncomingMessage, socket: Socket): void {
  let left = UNREAD_GRACE_BYTES;
  let settled = false;
  const close = (): void => {
    if (settled) return;
    settled = true;
    // Read no further: the next bytes may already be another request, which this connection will
    // not answer now. The request is paused too, as a read of it resumes its connection. Its end
    // follows the answer out.
    req.pause();
    socket.pause();
    socket.end();
    const linger = setTimeout(() => {
      socket.destroy();
    }, CLOSING_LINGER_MS);
    linger.unref();
    socket.once('close', () => {
      clearTimeout(linger);
    });
  };
  const grace = setTimeout(close, UNREAD_GRACE_MS);
  grace.unref();
  const settle = (): void => {
    settled = true;
    clearTimeout(grace);
  };
  req.on('data', (chunk: Buffer) => {
    left -= chunk.byteLength;
    if (left < 0) close();
  });
  req.once('end', settle);
  req.once('close', settle);
  req.resume();
}

/**
 * The request's body as the application reads it: from the connection, as fast as it is read.
 *
 * The connection is the answer's. Cancelling the body stops it being read, and nothing more:
 * destroying the request, as `Readable.toWeb` does, has Node.js detach the connection from it and
 * stop reading the connection for good. Once the answer has gone out, what the application left
 * unread of the body is read and dropped, within workerd's grace, so that the connection carries
 * its next request; past the grace, the connection is closed. Left as it was, it answered nothing
 * more and stayed open until a timeout, and a client that sent its next request on it waited for
 * the server's keep-alive timeout.
 */
export function nativeBody(req: IncomingMessage, res: ServerResponse): ReadableStream<Uint8Array> {
  const { socket } = req;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let open = true;
  const onData = (chunk: Buffer): void => {
    // A copy: the parser's chunk may share its memory with the next one.
    controller?.enqueue(new Uint8Array(chunk));
    if ((controller?.desiredSize ?? 0) <= 0) req.pause();
  };
  const shut = (): void => {
    open = false;
    req.off('data', onData);
  };
  req.pause();
  req.on('data', onData);
  const cleanup = finished(req, (error) => {
    cleanup();
    // As `Readable.toWeb` does: a request that has failed once cannot fail its reader again.
    req.on('error', () => {
      // Already reported to the body's reader, or the body was let go of.
    });
    if (!open) return;
    shut();
    if (error === null || error === undefined) controller?.close();
    else controller?.error(error);
  });
  res.once('finish', () => {
    if (req.complete || req.destroyed) return;
    if (open) {
      shut();
      controller?.error(new TypeError(LATE_READ));
    }
    dropUnread(req, socket);
  });
  return new ReadableStream<Uint8Array>(
    {
      start: (started) => {
        controller = started;
      },
      pull: () => {
        req.resume();
      },
      cancel: shut,
    },
    { highWaterMark: req.readableHighWaterMark, size: (chunk) => chunk.byteLength },
  );
}
