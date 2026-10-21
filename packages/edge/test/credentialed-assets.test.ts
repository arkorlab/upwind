import type { HostCredentials } from '@stayingupwind/host/credentials';
import { type AssetBackendId, DEFAULT_DELIVERY_POLICY } from '@stayingupwind/host/delivery';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEdgeMemory } from '../src/memory/caches.ts';
import type { EdgeMetric } from '../src/observability/metrics.ts';
import { serveFromPointer } from '../src/route.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import { pprDocument, seedSite } from './helpers/site.ts';

const PUBLIC_ASSET = 'export default "public";';
const CLIENT_ASSET = 'export default "client";';
const IMMUTABLE = 'public, max-age=31536000, immutable';
const BACKENDS = ['r2-mirror', 'cache-api-readthrough'] as const;
const CLIENTS: readonly {
  readonly label: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly prepare: (fixture: AssetFixture) => Promise<void>;
}[] = [
  {
    label: 'cookie, cold',
    headers: { cookie: 'session=secret' },
    prepare: () => Promise.resolve(),
  },
  {
    label: 'authorization, cold',
    headers: { authorization: 'Bearer secret' },
    prepare: () => Promise.resolve(),
  },
  { label: 'cookie, warm', headers: { cookie: 'session=secret' }, prepare: warmAsset },
  {
    label: 'authorization, warm',
    headers: { authorization: 'Bearer secret' },
    prepare: warmAsset,
  },
];

interface HostClient {
  readonly label: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly credentials: HostCredentials;
}

const HOST_CLIENTS: readonly HostClient[] = [
  {
    label: 'a host session cookie',
    headers: { cookie: 'host_session=secret' },
    credentials: { cookies: ['host_session'], headers: [] },
  },
  {
    label: 'a host authorization header',
    headers: { authorization: 'Bearer host' },
    credentials: { cookies: [], headers: ['Authorization'] },
  },
];

const MIXED_CLIENTS: readonly (HostClient & {
  readonly forwarded: Readonly<Record<string, string>>;
})[] = [
  {
    label: 'a host cookie and an app cookie',
    headers: { cookie: 'host_session=secret; session=secret' },
    credentials: { cookies: ['host_session'], headers: [] },
    forwarded: { cookie: 'session=secret' },
  },
  {
    label: 'host authorization and an app cookie',
    headers: { authorization: 'Bearer host', cookie: 'session=secret' },
    credentials: { cookies: [], headers: ['Authorization'] },
    forwarded: { cookie: 'session=secret' },
  },
  {
    label: 'a host cookie and app authorization',
    headers: { cookie: 'host_session=secret', authorization: 'Bearer app' },
    credentials: { cookies: ['host_session'], headers: [] },
    forwarded: { authorization: 'Bearer app' },
  },
];

interface AssetFixture {
  readonly asked: Request[];
  readonly points: EdgeMetric[];
  readonly ask: (
    headers?: Readonly<Record<string, string>>,
  ) => Promise<{ readonly response: Response; readonly text: string; readonly request: Request }>;
}

/** The real asset route and Cache API, with only the application's responses supplied here. */
async function assetFixture(
  backend: AssetBackendId,
  options: {
    readonly setsCookie?: boolean;
    readonly credentials?: HostCredentials;
    readonly immutable?: boolean;
  } = {},
): Promise<AssetFixture> {
  const site = await seedSite({ document: pprDocument() });
  const url = `https://site.example/_next/static/chunks/credential-${crypto.randomUUID()}.js`;
  const asked: Request[] = [];
  const points: EdgeMetric[] = [];
  const baseHost = standaloneHost(env);
  const host = {
    ...baseHost,
    credentials: options.credentials ?? baseHost.credentials,
    observer: {
      ...baseHost.observer,
      metric: (point: EdgeMetric): void => {
        points.push(point);
      },
    },
  };
  const runtime = standaloneRuntime(env, {
    memory: createEdgeMemory(() => Date.now()),
    dispatchApp: (_script, request) => {
      asked.push(request);
      const personal =
        request.headers.has('cookie') ||
        request.headers.has('authorization') ||
        request.headers.has('x-client-lane');
      const body = personal ? CLIENT_ASSET : PUBLIC_ASSET;
      const publicControl = options.immutable === false ? 'public, max-age=60' : IMMUTABLE;
      const headers = new Headers({
        'cache-control': personal ? 'private, no-store' : publicControl,
        'content-type': 'text/javascript',
        'content-length': String(body.length),
      });
      if (!personal && options.setsCookie === true) {
        headers.set('set-cookie', 'session=created; Path=/; HttpOnly');
      }
      return Promise.resolve(new Response(body, { headers }));
    },
  });
  const ask: AssetFixture['ask'] = async (headers = {}) => {
    const request = new Request<unknown, IncomingRequestCfProperties>(url, { headers });
    const ctx = createExecutionContext();
    const response = await serveFromPointer(
      {
        request,
        url: new URL(url),
        env,
        ctx,
        runtime,
        host,
        pointer: site.pointer,
        pointerMs: 0,
        privateDelivery: false,
        cspReportingPath: undefined,
      },
      {
        manifestLookup: Promise.resolve({ kind: 'found', value: site.manifest }),
        policyLookup: Promise.resolve({
          kind: 'found',
          source: 'exact',
          policy: {
            ...DEFAULT_DELIVERY_POLICY,
            assets: { ...DEFAULT_DELIVERY_POLICY.assets, backend },
          },
        }),
      },
    );
    const text = await response.text();
    await waitOnExecutionContext(ctx);
    return { response, text, request };
  };
  return { asked, points, ask };
}

async function warmAsset(fixture: AssetFixture): Promise<void> {
  const cold = await fixture.ask();
  const hit = await fixture.ask();

  expect({ cold: cold.text, hit: hit.text, requests: fixture.asked.length }).toStrictEqual({
    cold: PUBLIC_ASSET,
    hit: PUBLIC_ASSET,
    requests: 1,
  });
  expect(hit.response.headers.get('x-arkor-edge')).toContain('hit=1');
}

describe.each(['passthrough', ...BACKENDS] as const)('host asset headers under %s', (backend) => {
  it.each(['Accept', 'User-Agent', 'Accept-Language'])(
    'removes a host-reserved %s while preserving other asset headers and cache hits',
    async (reserved) => {
      const headers = {
        accept: 'application/javascript',
        'user-agent': 'browser',
        'accept-language': 'ja',
      };
      const fixture = await assetFixture(backend, {
        credentials: { cookies: [], headers: [reserved] },
      });
      const cold = await fixture.ask(headers);
      const repeated = await fixture.ask(headers);
      const expected = new Headers(headers);
      expected.delete(reserved);

      expect([cold.text, repeated.text]).toStrictEqual([PUBLIC_ASSET, PUBLIC_ASSET]);
      expect(fixture.asked).toHaveLength(backend === 'passthrough' ? 2 : 1);
      for (const request of fixture.asked) {
        for (const name of Object.keys(headers)) {
          expect(request.headers.get(name)).toBe(expected.get(name));
        }
      }
      expect(cold.request.headers.get(reserved)).toBe(new Headers(headers).get(reserved));
      if (backend !== 'passthrough') {
        expect(repeated.response.headers.get('x-arkor-edge')).toContain('hit=1');
      }
    },
  );
});

describe.each(BACKENDS)('credentialed assets under the %s policy', (backend) => {
  afterEach(() => vi.restoreAllMocks());

  it.each(CLIENTS)('sends only the client request for $label', async (client) => {
    const fixture = await assetFixture(backend);
    await client.prepare(fixture);
    const sentBefore = fixture.asked.length;
    const pointsBefore = fixture.points.length;
    const cacheOpens = vi.spyOn(caches, 'open');

    const answer = await fixture.ask(client.headers);

    expect(answer.text).toBe(CLIENT_ASSET);
    expect(answer.response.headers.get('x-arkor-edge')).toBe(
      'passthrough;reason=asset-unshareable',
    );
    expect(cacheOpens).not.toHaveBeenCalled();
    expect(
      fixture.asked.slice(sentBefore).map((request) => {
        return {
          method: request.method,
          cookie: request.headers.get('cookie'),
          authorization: request.headers.get('authorization'),
        };
      }),
    ).toStrictEqual([
      {
        method: 'GET',
        cookie: new Headers(client.headers).get('cookie'),
        authorization: new Headers(client.headers).get('authorization'),
      },
    ]);
    expect(
      fixture.points
        .slice(pointsBefore)
        .map((point) => ({ kind: point.kind, subrequests: point.subrequests })),
    ).toStrictEqual([{ kind: 'passthrough', subrequests: 1 }]);
  });

  it('keeps anonymous cold admission and cache hits', async () => {
    const fixture = await assetFixture(backend);

    const cold = await fixture.ask();
    const hit = await fixture.ask();

    expect({ cold: cold.text, hit: hit.text, requests: fixture.asked.length }).toStrictEqual({
      cold: PUBLIC_ASSET,
      hit: PUBLIC_ASSET,
      requests: 1,
    });
    expect(hit.response.headers.get('x-arkor-edge')).toContain('hit=1');
    expect(fixture.asked[0]?.headers.has('cookie')).toBe(false);
    expect(fixture.asked[0]?.headers.has('authorization')).toBe(false);
  });

  it('still hands an anonymous cookie-setting refusal to the original request', async () => {
    const fixture = await assetFixture(backend, { setsCookie: true });

    const answer = await fixture.ask({ 'x-client-lane': 'original' });

    expect(answer.text).toBe(CLIENT_ASSET);
    expect(answer.response.headers.get('x-arkor-edge')).toBe(
      'passthrough;reason=asset-unshareable',
    );
    expect(fixture.asked.map((request) => request.headers.get('x-client-lane'))).toStrictEqual([
      null,
      'original',
    ]);
    expect(
      fixture.points.map((point) => ({ kind: point.kind, subrequests: point.subrequests })),
    ).toStrictEqual([{ kind: 'passthrough', subrequests: 2 }]);
  });

  it.each(HOST_CLIENTS)('keeps anonymous cache admission and hits with $label', async (client) => {
    const fixture = await assetFixture(backend, { credentials: client.credentials });
    const cold = await fixture.ask(client.headers);
    const hit = await fixture.ask(client.headers);

    expect({ cold: cold.text, hit: hit.text, requests: fixture.asked.length }).toStrictEqual({
      cold: PUBLIC_ASSET,
      hit: PUBLIC_ASSET,
      requests: 1,
    });
    expect(hit.response.headers.get('x-arkor-edge')).toContain('hit=1');
    expect(fixture.asked[0]?.headers.has('cookie')).toBe(false);
    expect(fixture.asked[0]?.headers.has('authorization')).toBe(false);
    expect({
      cookie: cold.request.headers.get('cookie'),
      authorization: cold.request.headers.get('authorization'),
    }).toStrictEqual({
      cookie: new Headers(client.headers).get('cookie'),
      authorization: new Headers(client.headers).get('authorization'),
    });
  });

  it.each(HOST_CLIENTS)('answers a non-immutable probe once with $label', async (client) => {
    const fixture = await assetFixture(backend, {
      credentials: client.credentials,
      immutable: false,
    });
    const answer = await fixture.ask(client.headers);

    expect(answer.text).toBe(PUBLIC_ASSET);
    expect(fixture.asked).toHaveLength(1);
    expect(answer.response.headers.get('x-arkor-edge')).not.toBe(
      'passthrough;reason=asset-unshareable',
    );
    expect(fixture.asked[0]?.headers.has('cookie')).toBe(false);
    expect(fixture.asked[0]?.headers.has('authorization')).toBe(false);
  });

  it.each(MIXED_CLIENTS)('still sends only the client request for $label', async (client) => {
    const fixture = await assetFixture(backend, { credentials: client.credentials });
    const cacheOpens = vi.spyOn(caches, 'open');
    const answer = await fixture.ask(client.headers);

    expect(answer.text).toBe(CLIENT_ASSET);
    expect(answer.response.headers.get('x-arkor-edge')).toBe(
      'passthrough;reason=asset-unshareable',
    );
    expect(cacheOpens).not.toHaveBeenCalled();
    expect(fixture.asked).toHaveLength(1);
    expect({
      cookie: fixture.asked[0]?.headers.get('cookie'),
      authorization: fixture.asked[0]?.headers.get('authorization'),
    }).toStrictEqual({
      cookie: new Headers(client.forwarded).get('cookie'),
      authorization: new Headers(client.forwarded).get('authorization'),
    });
    expect(fixture.points.map((point) => point.subrequests)).toStrictEqual([1]);
  });
});
