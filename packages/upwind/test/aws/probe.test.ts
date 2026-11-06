import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));
vi.mock('node:https', () => ({ request: requestMock }));

import { deploymentProbeFetch } from '../../src/aws/lifecycle/probe.ts';

afterEach(() => {
  requestMock.mockReset();
});

function response(status: number, body: string): void {
  requestMock.mockImplementation(
    (_options: RequestOptions, callback: (incoming: IncomingMessage) => void) => {
      const incoming = Object.assign(new PassThrough(), {
        statusCode: status,
        statusMessage: 'OK',
        rawHeaders: ['content-type', 'application/json'],
      });
      return Object.assign(new EventEmitter(), {
        end: () => {
          callback(incoming as IncomingMessage);
          incoming.end(body);
        },
      });
    },
  );
}

describe('first-deploy direct ALB readiness', () => {
  it('connects to the new ALB with the canonical Host, SNI and certificate identity', async () => {
    response(200, '{"ready":true,"deploymentId":"candidate"}');
    const probe = deploymentProbeFetch(
      'https://shop.example',
      'new-alb.us-east-1.elb.amazonaws.com',
    );
    const signal = AbortSignal.timeout(15_000);
    const result = await probe('https://shop.example/__upwind/health?build=candidate', {
      headers: { 'x-upwind-probe': 'secret', host: 'wrong.example' },
      redirect: 'manual',
      signal,
    });
    expect(await result.json()).toEqual({ ready: true, deploymentId: 'candidate' });
    expect(requestMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        hostname: 'new-alb.us-east-1.elb.amazonaws.com',
        port: 443,
        servername: 'shop.example',
        path: '/__upwind/health?build=candidate',
        headers: expect.objectContaining({ host: 'shop.example', 'x-upwind-probe': 'secret' }),
        rejectUnauthorized: true,
        agent: false,
      }),
      expect.any(Function),
    );
    const options = requestMock.mock.calls[0]?.[0] as RequestOptions;
    expect(options.signal?.aborted).toBe(false);
    // A certificate for the ALB's generated hostname must not satisfy the application hostname.
    expect(
      options.checkServerIdentity?.('new-alb.us-east-1.elb.amazonaws.com', {
        subjectaltname: 'DNS:new-alb.us-east-1.elb.amazonaws.com',
      } as Parameters<NonNullable<RequestOptions['checkServerIdentity']>>[1]),
    ).toMatchObject({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
  });

  it('preserves injected transports and ordinary CloudFront fetches', () => {
    const injected = vi.fn<typeof fetch>();
    expect(deploymentProbeFetch('https://shop.example', 'new-alb.example', injected)).toBe(
      injected,
    );
    expect(deploymentProbeFetch('https://app.cloudfront.net', undefined)).toBe(fetch);
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('rejects certificate and connection failures without disabling verification', async () => {
    const error = Object.assign(new Error('hostname does not match certificate'), {
      code: 'ERR_TLS_CERT_ALTNAME_INVALID',
    });
    requestMock.mockImplementation(() => {
      const outgoing = new EventEmitter();
      return Object.assign(outgoing, { end: () => outgoing.emit('error', error) });
    });
    await expect(
      deploymentProbeFetch('https://shop.example', 'new-alb.example')('https://shop.example/'),
    ).rejects.toBe(error);
  });

  it('returns manual redirects without issuing another request', async () => {
    response(302, 'redirect');
    const result = await deploymentProbeFetch('https://shop.example', 'new-alb.example')(
      'https://shop.example/private',
      { redirect: 'manual' },
    );
    expect(result.status).toBe(302);
    await result.body?.cancel();
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('cancels an unfinished check body by destroying its underlying response stream', async () => {
    const incoming = Object.assign(new PassThrough(), {
      statusCode: 200,
      statusMessage: 'OK',
      rawHeaders: [],
    });
    requestMock.mockImplementation(
      (_options: RequestOptions, callback: (incoming: IncomingMessage) => void) =>
        Object.assign(new EventEmitter(), {
          end: () => {
            callback(incoming as IncomingMessage);
            incoming.write('a streaming response that has not ended');
          },
        }),
    );
    const result = await deploymentProbeFetch('https://shop.example', 'new-alb.example')(
      'https://shop.example/stream',
      { redirect: 'manual', signal: AbortSignal.timeout(30_000) },
    );
    await result.body?.cancel();
    expect(incoming.destroyed).toBe(true);
  });

  it('rejects aborted, cross-origin and mutating probes before opening a connection', async () => {
    const probe = deploymentProbeFetch('https://shop.example', 'new-alb.example');
    await expect(probe('https://shop.example/', { signal: AbortSignal.abort() })).rejects.toThrow();
    await expect(probe('https://other.example/')).rejects.toThrow('public origin');
    await expect(probe('https://shop.example/', { method: 'POST' })).rejects.toThrow('GET or HEAD');
    expect(requestMock).not.toHaveBeenCalled();
  });
});
