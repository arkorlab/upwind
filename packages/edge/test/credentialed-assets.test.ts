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

interface AssetFixture {
  readonly asked: Request[];
  readonly points: EdgeMetric[];
  readonly ask: (
    headers?: Readonly<Record<string, string>>,
  ) => Promise<{ readonly response: Response; readonly text: string }>;
}

/** The real asset route and Cache API, with only the application's responses supplied here. */
async function assetFixture(backend: AssetBackendId, setsCookie = false): Promise<AssetFixture> {
  const site = await seedSite({ document: pprDocument() });
  const url = `https://site.example/_next/static/chunks/credential-${crypto.randomUUID()}.js`;
  const asked: Request[] = [];
  const points: EdgeMetric[] = [];
  const baseHost = standaloneHost(env);
  const host = {
    ...baseHost,
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
      const headers = new Headers({
        'cache-control': personal ? 'private, no-store' : IMMUTABLE,
        'content-type': 'text/javascript',
        'content-length': String(body.length),
      });
      if (setsCookie && !personal) {
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
    return { response, text };
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
    const fixture = await assetFixture(backend, true);

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
});
