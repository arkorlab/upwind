import type { ImagesConfig } from '@stayingupwind/core/images';
import { GATE_ANSWER_HEADER, GATE_PASS } from '@stayingupwind/host/bindings';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEdgeMemory } from '../src/memory/caches.ts';
import { serveFromPointer } from '../src/route.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import { navigation, pprDocument, seedSite, type SiteOptions } from './helpers/site.ts';

const IMAGES: ImagesConfig = {
  path: '/_next/image',
  basePath: '',
  sizes: [64],
  qualities: [75],
  formats: ['image/webp'],
  minimumCacheTTL: 60,
  maximumRedirects: 2,
  maximumResponseBody: 1_000_000,
  remotePatterns: [],
  domains: [],
  localPatterns: [{ pathname: '^.*$', search: '' }],
  dangerouslyAllowLocalIP: false,
  dangerouslyAllowSVG: false,
  contentSecurityPolicy: "script-src 'none'; sandbox;",
  contentDispositionType: 'attachment',
};
const sockets: WebSocket[] = [];

async function routed(path: string, options: Omit<SiteOptions, 'document'> = {}, denied = false) {
  const { pointer } = await seedSite({ document: pprDocument(), ...options });
  const dispatch = vi.fn(() => {
    const pair = new WebSocketPair();
    pair[1].accept();
    pair[1].binaryType = 'arraybuffer';
    pair[1].addEventListener('message', (event) => {
      const data: unknown = event.data;
      if (typeof data === 'string' || data instanceof ArrayBuffer) pair[1].send(data);
    });
    sockets.push(pair[1]);
    // eslint-disable-next-line unicorn/no-invalid-response-options -- Workers supports native upgrades.
    return Promise.resolve(new Response(null, { status: 101, webSocket: pair[0] }));
  });
  const gate = vi.fn(() => {
    return Promise.resolve(
      denied
        ? new Response('denied', { status: 403 })
        : new Response(null, { headers: { [GATE_ANSWER_HEADER]: GATE_PASS } }),
    );
  });
  const host = standaloneHost(env);
  const runtime = standaloneRuntime(env, {
    memory: createEdgeMemory(() => Date.now()),
    dispatchApp: dispatch,
    transformImage: () => Promise.reject(new Error('a WebSocket must not run the image optimizer')),
  });
  const request = navigation(path, { headers: { upgrade: 'WebSocket' } });
  const ctx = createExecutionContext();
  const response = await serveFromPointer({
    request,
    url: new URL(request.url),
    env,
    ctx,
    runtime,
    host: { ...host, gates: { answer: gate } },
    pointer,
    pointerMs: 0,
    privateDelivery: false,
    cspReportingPath: undefined,
  });
  await waitOnExecutionContext(ctx);
  return { response, dispatch, gate };
}

function accept(response: Response): WebSocket {
  const socket = response.webSocket;
  if (socket === null) throw new Error('WebSocket response lost its socket');
  socket.accept();
  sockets.push(socket);
  return socket;
}

function acceptIfPresent(response: Response): void {
  if (response.webSocket !== null) accept(response);
}

describe('websocket routing before HTTP artifacts', () => {
  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.close(1000, 'test finished');
  });

  it.each([
    { path: '/', options: {} },
    { path: '/asset.txt', options: { files: { '/asset.txt': 'static file' } } },
    { path: '/_next/image?url=%2Fsource.png&w=64&q=75', options: { images: IMAGES } },
  ])(
    'passes $path to the Function without serving a shell, file or image',
    async ({ path, options }) => {
      const { response, dispatch } = await routed(path, options);

      expect(response.status).toBe(101);
      expect(dispatch).toHaveBeenCalledTimes(1);

      const socket = accept(response);
      const message = new Promise<MessageEvent>((resolve) => {
        socket.addEventListener('message', resolve, { once: true });
      });
      socket.send('through the Function');

      expect((await message).data).toBe('through the Function');
    },
  );

  it.each([false, true])(
    'keeps route authorization before dispatch (denied=%s)',
    async (denied) => {
      const { response, dispatch, gate } = await routed(
        '/',
        { gates: { '/': 'members' }, gatedPathnames: { '/': '/' } },
        denied,
      );

      expect(gate).toHaveBeenCalledTimes(1);
      expect(dispatch).toHaveBeenCalledTimes(denied ? 0 : 1);
      expect(response.status).toBe(denied ? 403 : 101);

      acceptIfPresent(response);
    },
  );
});
