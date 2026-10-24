import { PassThrough, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { describe, expect, it } from 'vitest';

import type { NodeHandler } from '../../src/app-module.ts';
import { invokeNodeHandler } from '../../src/node-bridge.ts';

/**
 * A request body a Node.js handler stops reading partway, as workerd's `node:http` server hands it.
 *
 * Next.js reads a server action's body through `pipeline`, with a transform that fails a body past
 * `serverActions.bodySizeLimit`. `pipeline` destroys every stream in it when one fails, and Node.js
 * takes the socket off a server's request it destroys (`stream.socket = null`), which workerd's
 * request, with a getter for `socket` and no setter, threw on: the pipeline never settled, and an
 * action sent too large a body was never answered (`app-action-size-limit-invalid`).
 */

const LIMIT = 1024;
/** Well past the limit, and past what a stream hands over in one chunk. */
const TOO_LARGE = 'a'.repeat(3_000_000);

/** Reads the body as Next.js reads a server action's, refusing it past `LIMIT`. */
const sizeLimited: NodeHandler = async (req, res) => {
  let size = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      callback(size > LIMIT ? new Error('Body exceeded the limit') : null, chunk);
    },
  });
  const read = new PassThrough();
  const chunks: Buffer[] = [];
  try {
    await Promise.all([
      pipeline(req, limit, read),
      (async () => {
        for await (const chunk of read) {
          chunks.push(chunk as Buffer);
        }
      })(),
    ]);
    res.end(`read ${String(Buffer.concat(chunks).length)} bytes`);
  } catch (error) {
    res.statusCode = 413;
    res.end(error instanceof Error ? error.message : String(error));
  }
};

async function sent(body: string): Promise<Response> {
  return invokeNodeHandler({
    handler: sizeLimited,
    request: new Request('https://app.test/action', { method: 'POST', body }),
    requestMeta: {},
    waitUntil: () => {
      // Nothing is left to run.
    },
  });
}

describe('a request body a handler stops reading partway', () => {
  it('fails the pipeline it was read through, and the handler answers', async () => {
    const response = await sent(TOO_LARGE);

    expect(response.status).toBe(413);
    await expect(response.text()).resolves.toBe('Body exceeded the limit');
  });

  it('is read whole when it stays under the limit', async () => {
    const response = await sent('a'.repeat(LIMIT));

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(`read ${String(LIMIT)} bytes`);
  });
});
