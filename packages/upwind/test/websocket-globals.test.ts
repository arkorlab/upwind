import { Response as MiniflareResponse, WebSocketPair } from 'miniflare';
import { afterEach, describe, expect, it } from 'vitest';

import { installWebSocketGlobals } from '../src/dev/websocket-globals.ts';

describe('development WebSocket globals', () => {
  let restore: (() => void) | undefined;

  afterEach(() => {
    restore?.();
  });

  it('keeps Node fetch brands, Response helpers, subclasses and outbound WebSocket', async () => {
    const outbound = WebSocket;
    const OriginalResponse = Response;
    const existing = new OriginalResponse('existing');
    restore = installWebSocketGlobals();
    class CustomResponse extends Response {}
    const custom = new CustomResponse('custom');

    expect(existing).toBeInstanceOf(Response);
    await expect(fetch('data:text/plain,fetch')).resolves.toBeInstanceOf(Response);
    expect(Response.json({ value: 1 })).toBeInstanceOf(Response);
    expect(Response.redirect('https://example.test')).toBeInstanceOf(Response);
    expect(Response.error()).toBeInstanceOf(Response);
    expect(custom).toBeInstanceOf(CustomResponse);
    expect(existing).not.toBeInstanceOf(CustomResponse);
    expect(WebSocket).toBe(outbound);
  });

  it('preserves the native socket through response copies and accepts DO proxy responses', () => {
    restore = installWebSocketGlobals();
    const pair = new WebSocketPair();
    const init = { status: 101, webSocket: pair[0], headers: { 'sec-websocket-protocol': 'echo' } };
    const response = new Response(null, init);
    const copy = new Response(response.body, response) as Response & { webSocket: unknown };

    expect([copy.status, copy.ok, copy.statusText, copy.webSocket]).toStrictEqual([
      101,
      false,
      'Switching Protocols',
      pair[0],
    ]);
    expect(copy.headers.get('sec-websocket-protocol')).toBe('echo');
    expect(() => copy.clone()).toThrow('Cannot clone');
    expect(new MiniflareResponse(null, init)).toBeInstanceOf(Response);
    expect(() => new Response('not empty', init)).toThrow('null body');
    expect(() => new Response(null, { ...init, status: 200 })).toThrow('status 101');

    const missingSocket = { status: 101 };

    expect(() => new Response(null, missingSocket)).toThrow('status');
  });
});
