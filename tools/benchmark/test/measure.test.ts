/* eslint-disable unicorn/prefer-event-target -- Node HTTPS emits its events through EventEmitter. */

import { EventEmitter } from 'node:events';
import type { ClientRequest } from 'node:http';
import { request } from 'node:https';
import { performance } from 'node:perf_hooks';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { agentFor, markersOf, timeRequest } from '../src/measure.ts';

vi.mock(import('node:https'), async (original) => {
  const actual = await original();
  return { ...actual, request: vi.fn() };
});

class FakeRequest extends EventEmitter {
  public reusedSocket = false;

  public destroy(error: Error): this {
    this.emit('error', error);
    return this;
  }

  public end(): void {
    // The test drives each network event explicitly.
  }
}

describe('node HTTPS timing', () => {
  let req: FakeRequest;
  let now: number;

  beforeEach(() => {
    vi.useFakeTimers();
    now = 100;
    req = new FakeRequest();
    vi.mocked(request).mockReturnValue(req as unknown as ClientRequest);
    vi.spyOn(performance, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('times the final headers separately from Early Hints and body milestones', async () => {
    const agent = agentFor(false);
    const measured = timeRequest('https://example.test/', agent, 4000);
    const socket = new EventEmitter();
    req.emit('socket', socket);
    now = 110;
    socket.emit('lookup');
    now = 120;
    socket.emit('connect');
    now = 130;
    socket.emit('secureConnect');
    req.emit('information', { statusCode: 103 });
    now = 140;
    const response = Object.assign(new EventEmitter(), { statusCode: 200, headers: {} });
    req.emit('response', response);
    now = 150;
    response.emit('data', Buffer.from('ok'));
    now = 160;
    response.emit('end');

    await expect(measured).resolves.toMatchObject({
      status: 200,
      headersMs: 40,
      firstByteMs: 50,
      completeMs: 60,
      bytes: 2,
      connection: { dnsMs: 10, connectMs: 10, tlsMs: 10, reused: false },
    });

    agent.destroy();
  });

  it('records actual connection reuse and preserves milestones when the body fails', async () => {
    const agent = agentFor(true);
    req.reusedSocket = true;
    const measured = timeRequest('https://example.test/', agent, 4000);
    req.emit('socket', new EventEmitter());
    now = 110;
    const response = Object.assign(new EventEmitter(), { statusCode: 200, headers: {} });
    req.emit('response', response);
    now = 120;
    response.emit('data', Buffer.from('x'));
    response.emit('error', new Error('body failed'));

    await expect(measured).resolves.toMatchObject({
      headersMs: 10,
      firstByteMs: 20,
      completeMs: null,
      error: 'Error: body failed',
      connection: { dnsMs: null, connectMs: null, tlsMs: null, reused: true },
    });

    agent.destroy();
  });

  it('aborts the entire request deadline even before a socket is assigned', async () => {
    const agent = agentFor(false);
    const measured = timeRequest('https://example.test/', agent, 4000);
    await vi.advanceTimersByTimeAsync(4000);

    await expect(measured).resolves.toMatchObject({
      status: 0,
      headersMs: null,
      firstByteMs: null,
      completeMs: null,
      error: 'Error: request exceeded 4000 ms',
    });

    agent.destroy();
  });

  it('retains only public response markers and caps their text', () => {
    expect(
      markersOf({
        'set-cookie': ['secret=value'],
        'x-vercel-id': 'sfo1::private-id',
        'cf-ray': 'private-id-SJC',
        'x-arkor-edge': 'shell;strategy=kv;src=gen-kv;cache=fresh;seq=9',
        'x-vercel-cache': 'HIT',
        'content-encoding': 'br',
      }),
    ).toStrictEqual({
      vercelCache: 'HIT',
      vercelPop: 'sfo1',
      arkorEdge: 'shell;src=gen-kv;cache=fresh',
      colo: 'SJC',
      encoding: 'br',
    });
    expect(markersOf({ 'cf-mitigated': 'a'.repeat(300) })['mitigated']).toHaveLength(200);
  });

  it.each(['request-id-without-a-pop', '::request-id', ''])(
    'omits a malformed Vercel location instead of publishing its request id: %s',
    (id) => {
      expect(markersOf({ 'x-vercel-id': id })).not.toHaveProperty('vercelPop');
    },
  );
});
