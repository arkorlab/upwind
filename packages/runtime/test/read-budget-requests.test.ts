import { fileURLToPath } from 'node:url';

import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FUNCTION_COMPATIBILITY_DATE,
  FUNCTION_COMPATIBILITY_FLAGS,
} from '../../adapter/src/function.ts';
import { bundleInlineWorker } from './inline-worker.ts';

// The time each test had where this suite ran before: a cancelled request reaches the Worker's
// read room only once workerd has noticed it, six seconds or so apiece on a quiet machine.
vi.setConfig({ testTimeout: 60_000 });

const REQUEST_TIMEOUT_MS = 15_000;
/** How long a read here waits for room before it gives up, as the Function's reads have one. */
const WAIT_MS = 5000;
/** How long the read that waits is watched for an answer before the room is given back. */
const STILL_WAITING_MS = 200;
/** When the caller of a read gives up on it: once it holds its room, or waits for it. */
const GONE_MS = 300;
/**
 * How long the read after a cancelled one waits for room: past how long a claim nothing renews
 * lasts (five seconds of the waiting read's own askings), with time to spare for them.
 */
const LAPSED_WITHIN_MS = 9000;
const POLL_MS = 10;
const POLLS = 300;
const ROOM_BYTES = 32 * 1024 * 1024;
const READ_BUDGET = fileURLToPath(
  new URL('../../cache/src/function/read-budget.ts', import.meta.url),
);

/**
 * A Worker that reads in the room an isolate reads artifacts and records in, as the Function's
 * reads do: the whole room each, waited for under a deadline of the request's own. `/read` reads its
 * body in it, and `/hold` holds it for `ms` on a timer of its own, as a read whose body is slow to
 * come does; each waits for it as long as `wait` says, or `WAIT_MS`. `/room` says whether the whole
 * room is free, asked for and not waited for.
 */
const WORKER = `
import { ArtifactRoom, ReadBudget } from ${JSON.stringify(READ_BUDGET)};

const budget = new ReadBudget(${String(ROOM_BYTES)});

function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function wholeRoom(waitMs) {
  const given = new AbortController();
  const deadline = setTimeout(() => given.abort(new Error('no room in time')), waitMs);
  try {
    return await new ArtifactRoom(budget).hold(${String(ROOM_BYTES)}, given.signal);
  } finally {
    clearTimeout(deadline);
  }
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/room') {
      try {
        (await wholeRoom(0))();
        return new Response('free');
      } catch {
        return new Response('taken');
      }
    }
    let release;
    try {
      release = await wholeRoom(Number(url.searchParams.get('wait') ?? ${String(WAIT_MS)}));
    } catch (error) {
      return new Response(String(error), { status: 503 });
    }
    try {
      if (url.pathname === '/hold') {
        await pause(Number(url.searchParams.get('ms')));
        return new Response('held');
      }
      return new Response(await request.text());
    } finally {
      release();
    }
  },
};
`;

/**
 * Whoever sends the Function its requests, an edge for one: it asks over a binding, and gives up on
 * the request after `goneMs` — its own client gone, say — which cancels the request's work at the
 * next thing it waits on.
 */
const CALLER = `
export default {
  async fetch(request, env) {
    const gone = new AbortController();
    setTimeout(() => gone.abort(), Number(new URL(request.url).searchParams.get('goneMs')));
    try {
      await env.ROOM.fetch(request, { signal: gone.signal });
      return new Response('answered');
    } catch {
      return new Response('gave up');
    }
  },
};
`;

/** A response's status and body, said short. */
async function answered(response: Promise<Response>): Promise<string> {
  const settled = await response;
  return `${String(settled.status)} ${await settled.text()}`;
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * The room is the isolate's, one for every request it serves, so a read waits for room another
 * request holds, and goes on in its own request once that request gives it back. A request can
 * also be cancelled with room it holds, or with its place in line — its caller gone — and the code
 * after its `await` never runs: what it held, or what it was to be given, comes back only once
 * nothing has renewed its claim for a while.
 *
 * Run under Miniflare from Node, with the Function's compatibility date and flags: the Workers pool
 * that runs the other suites serves every request through the Worker it runs them in.
 */
describe('the room a Function isolate reads in, across its requests', () => {
  let runtime: Miniflare | undefined;
  let origin: URL;
  let callerOrigin: URL;

  beforeEach(async () => {
    const bundled = await bundleInlineWorker({
      stdin: {
        contents: WORKER,
        sourcefile: 'read-budget-requests.mjs',
        resolveDir: fileURLToPath(new URL('../../cache/src/function/', import.meta.url)),
      },
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      target: 'es2024',
      external: ['node:*'],
    });
    runtime = new Miniflare({
      ...convertV4MiniflareOptions({
        workers: [
          {
            name: 'read-budget-requests',
            modulesRoot: '/read-budget-requests',
            modules: [
              {
                type: 'ESModule',
                path: '/read-budget-requests/index.mjs',
                contents: bundled.outputFiles[0]!.text,
              },
            ],
            compatibilityDate: FUNCTION_COMPATIBILITY_DATE,
            compatibilityFlags: [...FUNCTION_COMPATIBILITY_FLAGS],
            unsafeDirectSockets: [{ proxy: false }],
          },
          {
            name: 'read-budget-caller',
            modulesRoot: '/read-budget-caller',
            modules: [
              { type: 'ESModule', path: '/read-budget-caller/index.mjs', contents: CALLER },
            ],
            compatibilityDate: FUNCTION_COMPATIBILITY_DATE,
            serviceBindings: { ROOM: 'read-budget-requests' },
            unsafeDirectSockets: [{ proxy: false }],
          },
        ],
      }),
      log: new Log(LogLevel.NONE),
    });
    await runtime.ready;
    origin = await runtime.unsafeGetDirectURL('read-budget-requests');
    callerOrigin = await runtime.unsafeGetDirectURL('read-budget-caller');
  });

  afterEach(async () => {
    await runtime?.dispose();
    runtime = undefined;
  });

  function request(path: string, body?: BodyInit): Promise<Response> {
    return fetch(new URL(path, origin), {
      ...(body !== undefined && { method: 'POST', body, duplex: 'half' }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  /** `path` asked through the caller, which gives up on it after `GONE_MS`. */
  async function givenUpOn(path: string): Promise<string> {
    const url = new URL(path, callerOrigin);
    url.searchParams.set('goneMs', String(GONE_MS));
    return (await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })).text();
  }

  async function room(): Promise<string> {
    return (await request('/room')).text();
  }

  /** Once the whole room is taken, by a read that holds it. */
  async function roomTaken(): Promise<void> {
    for (let poll = 0; poll < POLLS; poll += 1) {
      if ((await room()) === 'taken') {
        return;
      }
      await pause(POLL_MS);
    }
    throw new Error('the first read never took the room');
  }

  /**
   * What a read that waits for room long enough for a cancelled claim to lapse comes to: the room
   * held, or none in time. It is the read that waits that lets the lapsed claim go.
   */
  function readAfter(): Promise<string> {
    return answered(request(`/hold?ms=1&wait=${String(LAPSED_WITHIN_MS)}`));
  }

  it('goes on in its own request once another request gives its room back', async () => {
    // The first read holds the whole room until its body ends, which the test decides. Its first
    // bytes go at once, since a body with none yet is not sent at all.
    const encoder = new TextEncoder();
    const sent = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
    const held = answered(
      request(
        '/read',
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('the read '));
            sent.resolve(controller);
          },
        }),
      ),
    );
    await roomTaken();

    const waiting = answered(request('/read', 'the read that waited'));
    const meanwhile = await Promise.race([
      waiting,
      (async () => {
        await pause(STILL_WAITING_MS);
        return 'still waiting';
      })(),
    ]);
    const body = await sent.promise;
    body.enqueue(encoder.encode('that held'));
    body.close();

    expect(meanwhile).toBe('still waiting');
    await expect(held).resolves.toBe('200 the read that held');
    await expect(waiting).resolves.toBe('200 the read that waited');
    await expect(room()).resolves.toBe('free');
  });

  /** A request cancelled as it holds room never gives it back itself. */
  it('gets back the room a read held once its request was cancelled', async () => {
    // Held for a minute, unless its request is cancelled first.
    await expect(givenUpOn('/hold?ms=60000')).resolves.toBe('gave up');

    const meanwhile = await room();

    expect(meanwhile).toBe('taken');
    await expect(readAfter()).resolves.toBe('200 held');
    await expect(room()).resolves.toBe('free');
  });

  /**
   * A request cancelled as it waits keeps its place in line, and would be given room it can never
   * give back.
   */
  it('lets a read whose request was cancelled as it waited out of line', async () => {
    const holding = answered(request('/hold?ms=1000'));
    await roomTaken();

    await expect(givenUpOn('/hold?ms=1')).resolves.toBe('gave up');

    await expect(holding).resolves.toBe('200 held');
    await expect(readAfter()).resolves.toBe('200 held');
    await expect(room()).resolves.toBe('free');
  });
});
