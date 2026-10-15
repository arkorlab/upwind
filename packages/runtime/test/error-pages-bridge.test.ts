import { IncomingMessage, type RequestListener, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { Duplex } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { InvalidatedTags, RequestWrites, withRequestContext } from '../src/cache/context.ts';
import { entryFor } from '../src/entries.ts';
import { render404 } from '../src/error-pages.ts';
import { invokeNodeHandler } from '../src/node-bridge.ts';
import { getStore, type Store } from '../src/store.ts';

const transport = vi.hoisted((): { listener: RequestListener | undefined; dispatch: unknown } => {
  return {
    listener: undefined as RequestListener | undefined,
    dispatch: undefined,
  };
});

vi.mock(import('node:http'), async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    createServer: ((listener: RequestListener) => {
      transport.listener = listener;
      return {
        listen: () => {
          // The listener is dispatched directly; no port is opened.
        },
      };
    }) as unknown as typeof original.createServer,
  };
});

vi.mock(import('cloudflare:node'), () => {
  return {
    handleAsNodeRequest: (_port: number, _request: Request, _env: unknown, dispatch: unknown) => {
      transport.dispatch = dispatch;
      return Promise.resolve(new Response(null));
    },
  };
});

vi.mock(import('../src/entries.ts'), () => ({ entryFor: vi.fn(), nodeHandlerOf: vi.fn() }));
vi.mock(import('../src/store.ts'), async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, getStore: vi.fn() };
});

/** A connected writable socket for the real Node response, with no listening port. */
class MemorySocket extends Duplex {
  readonly bytes: string[] = [];
  readonly first = Promise.withResolvers<undefined>();

  override _read(): void {
    // The request has no body to read.
  }

  override _write(chunk: Uint8Array, _encoding: string, done: () => void): void {
    this.bytes.push(new TextDecoder().decode(chunk));
    this.first.resolve(undefined);
    done();
  }
}

/** The real bridge dispatching its listener into a real ServerResponse on an in-memory socket. */
async function bridge(
  answer: Response,
): Promise<{ socket: MemorySocket; response: ServerResponse }> {
  vi.mocked(getStore).mockReturnValue({
    manifest: {
      config: { basePath: '' },
      entrypoints: [{ pathname: '/_not-found', kind: 'app-page' }],
    },
  } as unknown as Store);
  vi.mocked(entryFor).mockResolvedValue({ kind: 'edge', handler: () => Promise.resolve(answer) });
  const socket = new MemorySocket();
  socket.on('error', () => {
    // The bridge deliberately destroys a response whose source failed after headers were sent.
  });
  const active = new IncomingMessage(socket as unknown as Socket);
  active.method = 'GET';
  active.url = '/missing';
  const response = new ServerResponse(active);
  response.assignSocket(socket as unknown as Socket);
  const request = new Request('https://app.test/missing');
  await invokeNodeHandler({
    request,
    handler: render404,
    requestMeta: {},
    waitUntil: () => {
      // A GET has no work held behind its answer.
    },
    run: (work) =>
      withRequestContext(
        {
          request,
          tables: { app: { entries: {} }, edge: { entries: {} } },
          runtime: undefined,
          startedAt: 0,
          fetchStarts: new Map(),
          waitUntil: () => {
            // The not-found has no background work.
          },
          run: (inner) => inner(),
          invalidated: new InvalidatedTags(),
          writes: new RequestWrites(),
        },
        work,
      ),
  });
  Object.assign(active, { cloudflare: { ctx: transport.dispatch } });
  if (transport.listener === undefined) throw new Error('the bridge did not create its server');
  transport.listener(active, response);
  return { socket, response };
}

describe('edge not-found source failures through the Node bridge', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sends a complete 500 before the first byte without copying the failed body length', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {
      // The bridge logs the expected source failure.
    });
    const failure = new Error('not-found failed before headers');
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(failure);
      },
    });
    const { socket, response } = await bridge(
      new Response(source, {
        headers: { 'content-type': 'text/html', 'content-length': '900' },
      }),
    );
    await vi.waitFor(() => {
      expect(logged).toHaveBeenCalledWith('next-runtime: handler failed', failure);
    });

    expect(response.statusCode).toBe(500);
    expect(response.writableEnded).toBe(true);
    expect(socket.destroyed).toBe(false);
    expect(socket.bytes.join('')).toContain('HTTP/1.1 500');
    expect(response.getHeader('content-length')).toBeUndefined();
    expect(socket.bytes.join('')).toContain('Internal Server Error');
    expect(source.locked).toBe(false);

    socket.destroy();
  });

  it('breaks the connection when the source fails after the 404 shell was sent', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {
      // The bridge logs the expected source failure.
    });
    const source = new TransformStream<Uint8Array, Uint8Array>();
    const producer = source.writable.getWriter();
    const { socket, response } = await bridge(new Response(source.readable));
    await producer.write(new TextEncoder().encode('404 shell'));
    await socket.first.promise;
    const failure = new Error('not-found failed after headers');
    await producer.abort(failure);
    await vi.waitFor(() => {
      expect(logged).toHaveBeenCalledWith('next-runtime: handler failed', failure);
    });

    expect(response.headersSent).toBe(true);
    expect(response.writableEnded).toBe(false);
    expect(socket.destroyed).toBe(true);
    expect(socket.bytes.join('')).toContain('HTTP/1.1 404');
    expect(socket.bytes.join('')).toContain('404 shell');
    expect(socket.bytes.join('')).not.toContain('Internal Server Error');
    expect(source.readable.locked).toBe(false);
  });
});
