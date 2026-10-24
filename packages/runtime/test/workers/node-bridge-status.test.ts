import { describe, expect, it } from 'vitest';

import type { NodeHandler } from '../../src/app-module.ts';
import { invokeNodeHandler } from '../../src/node-bridge.ts';

/**
 * The status a render starts at. Next.js sets a not-found's 404 on the response before it renders
 * the Pages Router's error page, whose `getInitialProps` reads the status off the response, and
 * then sends whatever status the response has — so a 404 put on the answer afterwards renders the
 * page as a 200. The runtime renders `/_error` for a miss of a build that wrote no `/404` this way.
 */

/** Answers with the status it found on the response, as `pages/_error`'s `getInitialProps` reads it. */
const errorPage: NodeHandler = (_req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ statusCode: res.statusCode }));
  return Promise.resolve();
};

function invoke(status?: number): Promise<Response> {
  return invokeNodeHandler({
    handler: errorPage,
    request: new Request('https://app.test/missing'),
    requestMeta: {},
    waitUntil: () => {
      // Nothing is left to run.
    },
    ...(status !== undefined && { status }),
  });
}

describe('the status a Node.js render starts at', () => {
  it('is on the response before the handler reads it, and is what goes out', async () => {
    const response = await invoke(404);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toStrictEqual({ statusCode: 404 });
  });

  it('is the 200 Node.js starts every response at when none is given', async () => {
    const response = await invoke();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ statusCode: 200 });
  });
});

/**
 * A completed Node.js response may leave its handler awaiting work. A GET's asynchronous error
 * hook needs that lifetime as much as a Server Action's writes. Safe requests retain that work
 * once the producer ends the response or normal finish occurs. An open stream whose producer has
 * not ended adds no lifetime when its reader disconnects. The response still leaves before the handler finishes. Mutations retain their work
 * from the start.
 */

/** What a handler that goes on after its answer leaves with `waitUntil`, and whether that waited for it. */
async function held(method: string): Promise<{
  kept: number;
  responseBeforeCompletion: boolean;
  waitedForTheEnd: boolean;
}> {
  const kept: Promise<unknown>[] = [];
  const finished = Promise.withResolvers<undefined>();
  const ended = { value: false };
  const handler: NodeHandler = async (_req, res) => {
    res.end('ok');
    await finished.promise;
    ended.value = true;
  };
  const response = await invokeNodeHandler({
    handler,
    request: new Request('https://app.test/act', { method }),
    requestMeta: {},
    waitUntil: (promise) => {
      kept.push(promise);
    },
  });
  await response.text();
  const count = kept.length;
  const responseBeforeCompletion = !ended.value;
  finished.resolve(undefined);
  await Promise.all(kept);
  return { kept: count, responseBeforeCompletion, waitedForTheEnd: count > 0 && ended.value };
}

describe('a Node.js handler after its response', () => {
  it.each(['GET', 'HEAD', 'POST', 'PUT'])(
    'retains %s completion without waiting for it before answering',
    async (method) => {
      await expect(held(method)).resolves.toStrictEqual({
        kept: 1,
        responseBeforeCompletion: true,
        waitedForTheEnd: true,
      });
    },
  );
});
