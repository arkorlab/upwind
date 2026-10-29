import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';

import {
  isWebSocketResponseBridgeSource,
  webSocketResponseBridge,
  WEBSOCKET_RESPONSE_SYMBOL,
} from '@stayingupwind/core/next';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const nextRoot = dirname(require.resolve('next/package.json'));
const SEND_FILE = join(nextRoot, 'dist/server/send-response.js');

interface NodeResponse {
  readonly originalResponse: Record<string | symbol, unknown>;
  readonly getHeader: (name: string) => string | undefined;
  readonly appendHeader: (name: string, value: string) => void;
}

type Send = (
  request: { readonly method: string },
  node: NodeResponse,
  response: Response,
) => Promise<void>;

function serializer(): Send {
  const exports: { sendResponse?: Send } = {};
  const rewritten = webSocketResponseBridge(readFileSync(SEND_FILE, 'utf8'));
  // eslint-disable-next-line sonarjs/code-eval -- Execute only the installed Next serializer after this package's checked build rewrite.
  runInNewContext(rewritten.contents, {
    exports,
    require: createRequire(SEND_FILE),
    process,
    Symbol,
    Error,
  });
  if (exports.sendResponse === undefined) throw new Error('Next exported no response serializer');
  return exports.sendResponse;
}

describe('next WebSocket response transport', () => {
  it.each([
    'server/send-response.js',
    'esm/server/send-response.js',
    'server/route-modules/app-route/module.js',
    'esm/server/route-modules/app-route/module.js',
    'compiled/next-server/server.runtime.prod.js',
    'compiled/next-server/app-route.runtime.prod.js',
  ])('covers the installed Next copy %s', (file) => {
    const source = readFileSync(join(nextRoot, 'dist', file), 'utf8');

    expect(isWebSocketResponseBridgeSource(source)).toBe(true);
    expect(webSocketResponseBridge(source).edits).toBeGreaterThan(0);
  });

  it('hands off only after Next has merged headers and cookies, without ending the socket', async () => {
    const end = vi.fn();
    const accepted = vi.fn();
    const headers = new Headers({ 'x-existing': 'routing', 'set-cookie': 'first=1' });
    const node = {
      originalResponse: { end, [Symbol.for(WEBSOCKET_RESPONSE_SYMBOL)]: accepted },
      getHeader: (name: string) => headers.get(name) ?? undefined,
      appendHeader: (name: string, value: string) => {
        headers.append(name, value);
      },
    };
    const response = new Response(null, {
      headers: { 'x-existing': 'handler', 'set-cookie': 'second=2', 'x-handler': 'yes' },
    });
    Object.defineProperties(response, { status: { value: 101 }, webSocket: { value: {} } });
    await serializer()({ method: 'GET' }, node, response);

    expect(accepted).toHaveBeenCalledExactlyOnceWith(response);
    expect(headers.get('x-existing')).toBe('routing');
    expect(headers.get('x-handler')).toBe('yes');
    expect(headers.getSetCookie()).toStrictEqual(['first=1', 'second=2']);
    expect(end).not.toHaveBeenCalled();
  });

  it('keeps ordinary empty responses on Next’s original serializer', async () => {
    const end = vi.fn();
    const accepted = vi.fn();
    await serializer()(
      { method: 'GET' },
      {
        originalResponse: { end, [Symbol.for(WEBSOCKET_RESPONSE_SYMBOL)]: accepted },
        getHeader: vi.fn<NodeResponse['getHeader']>(),
        appendHeader: vi.fn<NodeResponse['appendHeader']>(),
      },
      new Response(null, { status: 204 }),
    );

    expect(end).toHaveBeenCalledExactlyOnceWith();
    expect(accepted).not.toHaveBeenCalled();
  });

  it('refuses a changed serializer or cookie merge instead of silently losing a socket', () => {
    const send = readFileSync(SEND_FILE, 'utf8');

    expect(() =>
      webSocketResponseBridge(send.replace('const { originalResponse } = res;', '')),
    ).toThrow(/serializer/u);

    const cookies = readFileSync(
      join(nextRoot, 'dist/server/route-modules/app-route/module.js'),
      'utf8',
    );

    expect(() =>
      webSocketResponseBridge(cookies.replace('new Response(res.body, {', 'Response.json({')),
    ).toThrow(/cookie response/u);
  });
});
