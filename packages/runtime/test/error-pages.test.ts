import { IncomingMessage, type ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { Writable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { InvalidatedTags, RequestWrites, withRequestContext } from '../src/cache/context.ts';
import { entryFor } from '../src/entries.ts';
import { render404 } from '../src/error-pages.ts';
import { getStore, type Store } from '../src/store.ts';

vi.mock(import('../src/entries.ts'), () => {
  return {
    entryFor: vi.fn(),
    nodeHandlerOf: vi.fn(),
  };
});

vi.mock(import('../src/store.ts'), async (importOriginal) => {
  return {
    ...(await importOriginal()),
    getStore: vi.fn(),
  };
});

/** A Node response whose bytes are observable before the producer finishes. */
class CapturedResponse extends Writable {
  readonly #accept: Promise<undefined>;
  statusCode = 404;
  readonly headers = new Map<string, unknown>();
  readonly chunks: string[] = [];
  readonly first = Promise.withResolvers<undefined>();

  constructor(accept = Promise.resolve(undefined)) {
    super({ highWaterMark: 1 });
    this.#accept = accept;
  }

  setHeader(name: string, value: unknown): void {
    this.headers.set(name, value);
  }

  override _write(chunk: Uint8Array, _encoding: string, done: (error?: Error) => void): void {
    this.chunks.push(new TextDecoder().decode(chunk));
    this.first.resolve(undefined);
    // eslint-disable-next-line promise/no-callback-in-promise -- Node's writable contract completes through a callback.
    void this.#accept.then(done).catch(done);
  }
}

/** The edge App Router not-found, reached while a Pages Router request is being answered. */
function render(answer: Response, response: CapturedResponse, method = 'GET'): Promise<void> {
  vi.mocked(getStore).mockReturnValue({
    manifest: {
      config: { basePath: '' },
      entrypoints: [{ pathname: '/_not-found', kind: 'app-page' }],
    },
  } as unknown as Store);
  vi.mocked(entryFor).mockResolvedValue({ kind: 'edge', handler: () => Promise.resolve(answer) });
  const active = new IncomingMessage(new Socket());
  active.method = method;
  active.url = '/missing';
  return withRequestContext(
    {
      request: new Request('https://app.test/missing', { method }),
      tables: { app: { entries: {} }, edge: { entries: {} } },
      runtime: undefined,
      startedAt: 0,
      publication: new Set<string>(),
      fetchStarts: new Map(),
      waitUntil: () => {
        // The render has no work behind its answer.
      },
      run: (work) => work(),
      invalidated: new InvalidatedTags(),
      writes: new RequestWrites(),
    },
    () => render404(active, response as unknown as ServerResponse),
  );
}

describe('an edge not-found copied into an active Node response', () => {
  afterEach(() => vi.clearAllMocks());

  it('sends the shell before a slow boundary, preserving status and separate cookies', async () => {
    const source = new TransformStream<Uint8Array, Uint8Array>();
    const producer = source.writable.getWriter();
    const headers = new Headers({ 'content-type': 'text/html' });
    headers.append('set-cookie', 'first=1; Path=/');
    headers.append('set-cookie', 'second=2; Path=/');
    const response = new CapturedResponse();
    const completed = render(new Response(source.readable, { headers }), response);
    await producer.write(new TextEncoder().encode('shell'));
    await response.first.promise;

    expect(response.chunks).toStrictEqual(['shell']);
    expect(response.writableEnded).toBe(false);
    expect(response.statusCode).toBe(404);
    expect(response.headers.get('set-cookie')).toStrictEqual([
      'first=1; Path=/',
      'second=2; Path=/',
    ]);

    await producer.write(new TextEncoder().encode('boundary'));
    await producer.close();
    await completed;

    expect(response.chunks.join('')).toBe('shellboundary');
  });

  it('bounds reads while the Node response is under backpressure', async () => {
    const accepted = Promise.withResolvers<undefined>();
    let pulls = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(1024));
        if (pulls === 100) controller.close();
      },
    });
    const response = new CapturedResponse(accepted.promise);
    const completed = render(new Response(source), response);
    await response.first.promise;
    await new Promise((resolve) => {
      setImmediate(resolve);
    });

    expect(pulls).toBeLessThan(5);
    expect(response.chunks).toHaveLength(1);

    accepted.resolve(undefined);
    await completed;

    expect(pulls).toBe(100);
  });

  it('cancels an unfinished render when the client disconnects', async () => {
    const cancelled = vi.fn();
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('shell'));
      },
      cancel: cancelled,
    });
    const response = new CapturedResponse();
    const completed = render(new Response(source), response);
    // eslint-disable-next-line unicorn/prefer-await -- Observe rejection before disconnecting, then inspect it afterwards.
    const rejected = completed.catch((error: unknown) => error);
    await response.first.promise;
    response.destroy();

    await expect(rejected).resolves.toBeInstanceOf(Error);
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it('returns an upstream failure to the bridge without destroying an unsent response', async () => {
    const failure = new Error('render failed');
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(failure);
      },
    });
    const response = new CapturedResponse();

    await expect(render(new Response(source), response)).rejects.toBe(failure);
    expect(response.destroyed).toBe(false);
    expect(source.locked).toBe(false);

    response.end();
  });

  it('ends HEAD without waiting for the body or its cancellation acknowledgement', async () => {
    const cancelled = vi.fn(() => {
      return new Promise<undefined>(() => {
        // A source that never acknowledges its cancellation.
      });
    });
    const source = new ReadableStream<Uint8Array>({ cancel: cancelled });
    const response = new CapturedResponse();

    await render(
      new Response(source, { status: 307, headers: { location: '/moved' } }),
      response,
      'HEAD',
    );

    expect(response.writableEnded).toBe(true);
    expect(response.chunks).toStrictEqual([]);
    expect(response.statusCode).toBe(307);
    expect(response.headers.get('location')).toBe('/moved');
    expect(cancelled).toHaveBeenCalledTimes(1);
  });
});
