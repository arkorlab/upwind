import { DEFAULT_DELIVERY_POLICY } from '@stayingupwind/host/delivery';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { createEdgeMemory } from '../src/memory/caches.ts';
import { serveFromPointer } from '../src/route.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import { pprDocument, seedSite } from './helpers/site.ts';

const ASSET = 'https://site.example/_next/static/chunks/main-abc123.js';
const CACHE_CONTROL = 'public, max-age=31536000, immutable';
const CLIENTS: readonly { readonly label: string; readonly headers: Record<string, string> }[] = [
  { label: 'anonymous', headers: {} },
  { label: 'cookie', headers: { cookie: 'session=secret' } },
  { label: 'authorization', headers: { authorization: 'Bearer secret' } },
];

describe.each(['r2-mirror', 'cache-api-readthrough', 'passthrough'] as const)(
  'head assets under the %s policy',
  (backend) => {
    it.each(CLIENTS)(
      'dispatches one HEAD without an anonymous GET probe for $label',
      async (client) => {
        const site = await seedSite({ document: pprDocument() });
        const headers = new Headers(client.headers);
        const request = new Request<unknown, IncomingRequestCfProperties>(ASSET, {
          method: 'HEAD',
          headers,
        });
        const asked: Request[] = [];
        const runtime = standaloneRuntime(env, {
          memory: createEdgeMemory(() => Date.now()),
          dispatchApp: (_scriptName, dispatched) => {
            asked.push(dispatched);
            return Promise.resolve(
              new Response(null, {
                headers: {
                  'cache-control': CACHE_CONTROL,
                  'content-type': 'text/javascript',
                  'content-length': '42',
                  etag: '"asset-v1"',
                },
              }),
            );
          },
        });
        const ctx = createExecutionContext();
        const response = await serveFromPointer(
          {
            request,
            url: new URL(request.url),
            env,
            ctx,
            runtime,
            host: standaloneHost(env),
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
        await waitOnExecutionContext(ctx);

        expect(
          asked.map((sent) => {
            return {
              method: sent.method,
              cookie: sent.headers.get('cookie'),
              authorization: sent.headers.get('authorization'),
            };
          }),
        ).toStrictEqual([
          {
            method: 'HEAD',
            cookie: headers.get('cookie'),
            authorization: headers.get('authorization'),
          },
        ]);
        expect(response.body).toBeNull();
        expect(response.headers.get('x-arkor-edge')).toBe('passthrough;reason=head');
        // Passthroughs preserve browser caching and prohibit a shared cache's independent copy.
        expect(response.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
        expect(response.headers.get('content-length')).toBe('42');
        expect(response.headers.get('etag')).toBe('"asset-v1"');
      },
    );
  },
);
