import { describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({ fetch: vi.fn<typeof fetch>() }));
vi.mock(import('../src/cache/native.ts'), () => ({ nativeFetch: transport.fetch }));

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

describe('node delegated bindings', () => {
  it('omits the private bootstrap payload from an application environment snapshot', () => {
    vi.stubEnv('ARKOR_NODE_RUNTIME', JSON.stringify(config));
    try {
      const env = createNodeFunctionEnv(config);
      const dump = JSON.stringify(env);

      expect(Object.hasOwn(env, 'ARKOR_NODE_RUNTIME')).toBe(false);
      expect(dump).not.toContain(config.controlToken);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each(['gzip', 'br'])(
    'normalizes decoded %s capability responses with one native fetch',
    async (encoding) => {
      transport.fetch.mockClear();
      transport.fetch.mockResolvedValueOnce(
        new Response('decoded capability', {
          headers: { 'content-encoding': encoding, 'content-length': '123', 'x-origin': 'kept' },
        }),
      );
      const result = await nodeCapabilityFetcher(config.capabilities.cacheWrite).fetch(
        'http://cache.test/value',
      );

      expect(transport.fetch).toHaveBeenCalledTimes(1);
      expect({
        encoding: result.headers.get('content-encoding'),
        length: result.headers.get('content-length'),
        origin: result.headers.get('x-origin'),
      }).toStrictEqual({ encoding: null, length: null, origin: 'kept' });
      await expect(result.text()).resolves.toBe('decoded capability');

      transport.fetch.mockClear();
    },
  );

  it('keeps a double-slash service path on the sealed broker origin with body and sanitized headers', async () => {
    transport.fetch.mockClear();
    transport.fetch.mockResolvedValueOnce(new Response('sealed'));
    const binding = nodeCapabilityFetcher(config.capabilities.services.SEARCH, true);
    await binding.fetch('https://service.example//attacker.example/path?q=1', {
      method: 'POST',
      body: 'private request body',
      headers: { 'x-upwind-control-token': 'spoofed', 'x-custom': 'kept' },
    });
    const [input, options] = transport.fetch.mock.calls[0]!;
    const forwarded = input as Request;
    const url = new URL(forwarded.url);

    expect({
      origin: url.origin,
      path: url.pathname,
      query: url.search,
      method: forwarded.method,
      body: await forwarded.text(),
      original: forwarded.headers.get('x-upwind-service-url'),
      control: forwarded.headers.get('x-upwind-control-token'),
      custom: forwarded.headers.get('x-custom'),
      redirect: options?.redirect,
    }).toStrictEqual({
      origin: config.capabilities.services.SEARCH,
      path: '//attacker.example/path',
      query: '?q=1',
      method: 'POST',
      body: 'private request body',
      original: 'https://service.example//attacker.example/path?q=1',
      control: null,
      custom: 'kept',
      redirect: 'manual',
    });

    transport.fetch.mockClear();
  });

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
    }).toStrictEqual({ fetch: 'function', resources: '[{"name":"_API","type":"service"}]' });
  });

  it.each(['__proto__', 'constructor', 'prototype', 'ARKOR_CACHE', 'NEXT_DEPLOYMENT_ID'])(
    'refuses reserved or prototype-sensitive service alias %s',
    (name) => {
      expect(() => {
        return parseNodeRuntimeConfiguration(
          JSON.stringify({
            ...config,
            capabilities: { services: { [name]: config.capabilities.services.SEARCH } },
          }),
        );
      }).toThrow('invalid Node runtime service');
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
    }).toStrictEqual({
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

    expect({ write: env['ARKOR_CACHE'], read: env['ARKOR_CACHE_READ'] }).toStrictEqual({
      write: undefined,
      read: undefined,
    });
    expect(() => {
      return parseNodeRuntimeConfiguration(
        JSON.stringify({
          ...withoutCache,
          capabilities: { services: {}, cacheRead: config.capabilities.cacheRead },
        }),
      );
    }).toThrow(Error);
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
    }).toStrictEqual({
      url: 'http://eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee.eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee.arkor.internal/items?q=1',
      method: 'POST',
      body: 'query',
      serviceUrl: 'https://search.example/items?q=1',
      control: null,
      custom: 'kept',
      redirect: 'manual',
    });
    await expect(result.text()).resolves.toBe('service');
  });
});
