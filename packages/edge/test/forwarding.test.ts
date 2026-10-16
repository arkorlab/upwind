import type { ForwardingContext } from '@stayingupwind/core/request';
import { describe, expect, it } from 'vitest';

import { buildPassthroughRequest, buildResumeRequest } from '../src/forwarding.ts';
import { forwardedResponse } from '../src/handlers/responses.ts';

const CONTEXT: ForwardingContext = {
  previewDomain: 'example.test',
  previewHost: 'customer.example.test',
  clientIp: undefined,
};
const CREDENTIALS = { cookies: ['host-session'], headers: ['host-key'] };

describe('forwarded native transport', () => {
  it('preserves a canonical WebSocket upgrade and application metadata while dropping host credentials', () => {
    const client = new Request('http://client.example:3000/a%2Fb?value=%2F%3F&space=one+two', {
      headers: {
        upgrade: 'WebSocket',
        connection: 'upgrade',
        'sec-websocket-protocol': 'echo',
        origin: 'https://application.example',
        cookie: 'host-session=private; application=public',
        'host-key': 'private',
      },
    });
    const forwarded = buildPassthroughRequest(client, CONTEXT, CREDENTIALS);

    expect({
      url: forwarded.url,
      upgrade: forwarded.headers.get('upgrade'),
      connection: forwarded.headers.get('connection'),
      protocol: forwarded.headers.get('sec-websocket-protocol'),
      origin: forwarded.headers.get('origin'),
      cookie: forwarded.headers.get('cookie'),
      hostKey: forwarded.headers.get('host-key'),
    }).toStrictEqual({
      url: 'https://customer.example.test/a%2Fb?value=%2F%3F&space=one+two',
      upgrade: 'websocket',
      connection: null,
      protocol: 'echo',
      origin: 'https://application.example',
      cookie: 'application=public',
      hostKey: null,
    });

    const resumed = buildResumeRequest(
      { clientRequest: client, ctx: CONTEXT, signal: client.signal },
      CREDENTIALS,
    );

    expect(resumed.url).toBe(forwarded.url);
    expect(resumed.headers.get('upgrade')).toBeNull();
  });

  it('leaves unsupported upgrades and host-owned headers out of forwarding', () => {
    const forwarded = buildPassthroughRequest(
      new Request('https://client.example/', { headers: { upgrade: 'h2c' } }),
      CONTEXT,
      CREDENTIALS,
    );

    expect(forwarded.headers.get('upgrade')).toBeNull();

    const owned = buildPassthroughRequest(
      new Request('https://client.example/', { headers: { upgrade: 'websocket' } }),
      CONTEXT,
      { headers: ['Upgrade'], cookies: [] },
    );

    expect(owned.headers.get('upgrade')).toBeNull();
  });

  it('filters an immutable response copy without changing the source or buffering its stream', async () => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(opened) {
        controller = opened;
        opened.enqueue(new TextEncoder().encode('first'));
      },
    });
    const upstream = new Response(stream, {
      status: 202,
      statusText: 'Still streaming',
      headers: { 'x-arkor-private': 'hidden', 'cdn-cache-control': 'max-age=600', allowed: 'kept' },
    });
    upstream.headers.append('set-cookie', 'one=1; Domain=.example.test; Path=/');
    upstream.headers.append('set-cookie', 'two=2; Path=/other');
    const answer = forwardedResponse(upstream, CONTEXT);

    expect({
      status: answer.status,
      statusText: answer.statusText,
      internal: answer.headers.get('x-arkor-private'),
      cdnControl: answer.headers.get('cdn-cache-control'),
      allowed: answer.headers.get('allowed'),
      cookies: answer.headers.getSetCookie(),
    }).toStrictEqual({
      status: 202,
      statusText: 'Still streaming',
      internal: null,
      cdnControl: null,
      allowed: 'kept',
      cookies: ['one=1; Path=/', 'two=2; Path=/other'],
    });
    expect({
      internal: upstream.headers.get('x-arkor-private'),
      cookie: upstream.headers.getSetCookie()[0],
    }).toStrictEqual({ internal: 'hidden', cookie: 'one=1; Domain=.example.test; Path=/' });

    const reader = answer.body!.pipeThrough(new TextDecoderStream()).getReader();

    expect((await reader.read()).value).toBe('first');

    controller!.enqueue(new TextEncoder().encode('last'));
    controller!.close();

    expect((await reader.read()).value).toBe('last');
    expect((await reader.read()).done).toBe(true);
  });

  /**
   * A WebSocket's handshake is copied with its socket, the one the client is handed: a copy of the
   * answer that lost it would have no handshake to give (cubic, upwind#179).
   */
  it('keeps the socket of a WebSocket handshake it copies', () => {
    const socket = new WebSocketPair()[0];
    const upstream = new Response(null, {
      // eslint-disable-next-line unicorn/no-invalid-response-options -- a Worker answers a handshake 101, with the socket
      status: 101,
      webSocket: socket,
      headers: { 'sec-websocket-protocol': 'echo', 'x-arkor-private': 'hidden' },
    });
    const answer = forwardedResponse(upstream, CONTEXT);

    expect({
      status: answer.status,
      kept: answer.webSocket === socket,
      protocol: answer.headers.get('sec-websocket-protocol'),
      internal: answer.headers.get('x-arkor-private'),
    }).toStrictEqual({ status: 101, kept: true, protocol: 'echo', internal: null });
  });
});
