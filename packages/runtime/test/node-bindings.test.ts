import { describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({ fetch: vi.fn<typeof fetch>() }));
vi.mock('../src/cache/native.ts', () => ({ nativeFetch: transport.fetch }));

import {
  createNodeFunctionEnv,
  nodeCapabilityFetcher,
  parseNodeRuntimeConfiguration,
} from '../src/node-bindings.ts';

const config = {
  v: 1 as const,
  deploymentId: 'synthetic-deployment',
  functionName: 'app',
  controlToken: 'synthetic-control-token-at-least-32-bytes',
  capabilities: {
    cacheWrite:
      'http://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.arkor.internal',
    cacheRead:
      'http://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.arkor.internal',
    prefetch:
      'http://cccccccccccccccccccccccccccccccc.cccccccccccccccccccccccccccccccc.arkor.internal',
    monitor:
      'http://dddddddddddddddddddddddddddddddd.dddddddddddddddddddddddddddddddd.arkor.internal',
    services: {
      SEARCH:
        'http://eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee.eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee.arkor.internal',
    },
  },
};

describe('Node delegated bindings', () => {
  it('publishes a declared HTTP service alias beginning with an underscore', () => {
    const parsed = parseNodeRuntimeConfiguration(
      JSON.stringify({
        ...config,
        capabilities: { services: { _API: config.capabilities.services.SEARCH } },
      }),
    );
    const env = createNodeFunctionEnv(parsed);

    expect({
      fetch: typeof (env['_API'] as { fetch: unknown }).fetch,
      resources: env['ARKOR_RESOURCES'],
    }).toEqual({ fetch: 'function', resources: '[{"name":"_API","type":"service"}]' });
  });

  it.each(['__proto__', 'constructor', 'prototype', 'ARKOR_CACHE', 'NEXT_DEPLOYMENT_ID'])(
    'refuses reserved or prototype-sensitive service alias %s',
    (name) => {
      expect(() =>
        parseNodeRuntimeConfiguration(
          JSON.stringify({
            ...config,
            capabilities: { services: { [name]: config.capabilities.services.SEARCH } },
          }),
        ),
      ).toThrow('invalid Node runtime service');
    },
  );

  it('publishes only declared HTTP resources and delegated markers', () => {
    const env = createNodeFunctionEnv(parseNodeRuntimeConfiguration(JSON.stringify(config)));

    expect({
      deployment: env['NEXT_DEPLOYMENT_ID'],
      cacheToken: env['ARKOR_CACHE_TOKEN'],
      monitorToken: env['ARKOR_MONITOR_TOKEN'],
      resources: env['ARKOR_RESOURCES'],
      service: typeof (env['SEARCH'] as { fetch: unknown }).fetch,
    }).toEqual({
      deployment: 'synthetic-deployment',
      cacheToken: 'delegated',
      monitorToken: 'delegated',
      resources: '[{"name":"SEARCH","type":"service"}]',
      service: 'function',
    });
  });

  it('preserves no-cache-host operation and refuses an orphan cache reader', () => {
    const withoutCache = { ...config, capabilities: { services: {} } };
    const env = createNodeFunctionEnv(parseNodeRuntimeConfiguration(JSON.stringify(withoutCache)));

    expect({ write: env['ARKOR_CACHE'], read: env['ARKOR_CACHE_READ'] }).toEqual({
      write: undefined,
      read: undefined,
    });
    expect(() =>
      parseNodeRuntimeConfiguration(
        JSON.stringify({
          ...withoutCache,
          capabilities: { services: {}, cacheRead: config.capabilities.cacheRead },
        }),
      ),
    ).toThrow(Error);
  });

  it.each([
    { ...config, controlToken: 'short' },
    { ...config, capabilities: { ...config.capabilities, cacheWrite: 'https://public.example/' } },
    {
      ...config,
      capabilities: { ...config.capabilities, cacheWrite: 'http://cache.arkor.internal/private' },
    },
    {
      ...config,
      capabilities: {
        ...config.capabilities,
        services: { ARKOR_CACHE: 'http://cache.arkor.internal' },
      },
    },
  ])('rejects an unsealed or malformed configuration', (value) => {
    expect(() => parseNodeRuntimeConfiguration(JSON.stringify(value))).toThrow(Error);
  });

  it('uses captured native fetch, preserves service URL/body, and refuses automatic redirects', async () => {
    transport.fetch.mockResolvedValueOnce(new Response('service'));
    const binding = nodeCapabilityFetcher(config.capabilities.services.SEARCH, true);
    const result = await binding.fetch('https://search.example/items?q=1', {
      method: 'POST',
      body: 'query',
      headers: { 'x-upwind-control-token': 'spoofed', 'x-custom': 'kept' },
    });
    const [forwarded, options] = transport.fetch.mock.calls[0]!;
    const request = forwarded as Request;

    expect({
      url: request.url,
      method: request.method,
      body: await request.text(),
      serviceUrl: request.headers.get('x-upwind-service-url'),
      control: request.headers.get('x-upwind-control-token'),
      custom: request.headers.get('x-custom'),
      redirect: options?.redirect,
    }).toEqual({
      url: 'http://eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee.eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee.arkor.internal/items?q=1',
      method: 'POST',
      body: 'query',
      serviceUrl: 'https://search.example/items?q=1',
      control: null,
      custom: 'kept',
      redirect: 'manual',
    });
    expect(await result.text()).toBe('service');
  });
});
