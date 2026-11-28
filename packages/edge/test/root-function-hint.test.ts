import { DEFAULT_DELIVERY_POLICY } from '@stayingupwind/host/delivery';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { functionOfRequest } from '../src/handlers/upstream.ts';
import { serveFromPointer } from '../src/route.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import { navigation, pprDocument, seedSite } from './helpers/site.ts';

const LANDING = '/welcome';
const OWNER = 'app-2';

async function splitSite() {
  const site = await seedSite({ document: pprDocument(), pathname: LANDING });
  const app = { ...site.manifest.app, functions: { [OWNER]: 'welcome-worker' } };
  const entry = { ...site.manifest.routes[LANDING]!, function: OWNER };
  const manifest = {
    ...site.manifest,
    routes: { [LANDING]: entry },
    app,
    rootRewriteHint: LANDING,
  };
  return { manifest, pointer: { ...site.pointer, app } };
}

describe('root rewrite placement', () => {
  it.each(['en', 'ja'])('sends the original %s request to one Worker', async (language) => {
    const { manifest, pointer } = await splitSite();
    const request = navigation('/?page=1', {
      headers: { accept: 'text/html', cookie: `locale=${language}` },
    });
    request.headers.delete('sec-fetch-dest');
    request.headers.delete('sec-fetch-mode');
    const calls: string[] = [];
    const runtime = standaloneRuntime(env, {
      dispatchApp: (worker, forwarded) => {
        calls.push(worker);
        const url = new URL(forwarded.url);

        expect(url.pathname + url.search).toBe('/?page=1');

        const redirect = forwarded.headers.get('cookie') === 'locale=ja';
        return Promise.resolve(
          new Response(redirect ? null : 'welcome', {
            status: redirect ? 307 : 200,
            headers: { vary: 'Cookie, Accept-Language', ...(redirect && { location: '/ja' }) },
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
        pointer,
        pointerMs: 0,
        privateDelivery: false,
        cspReportingPath: undefined,
      },
      {
        manifestLookup: Promise.resolve({ kind: 'found', value: manifest }),
        policyLookup: Promise.resolve({
          kind: 'found',
          source: 'exact',
          policy: DEFAULT_DELIVERY_POLICY,
        }),
      },
    );

    expect(calls).toStrictEqual(['welcome-worker']);
    expect(response.status).toBe(language === 'ja' ? 307 : 200);
    expect(response.headers.get('location')).toBe(language === 'ja' ? '/ja' : null);
    expect(response.headers.get('vary')).toContain('Accept-Language');
    await expect(response.text()).resolves.toBe(language === 'ja' ? '' : 'welcome');

    await waitOnExecutionContext(ctx);
  });

  it('keeps exact, reserved and non-document requests on their normal path', async () => {
    const { manifest } = await splitSite();
    const { app } = manifest;
    const root = 'https://site.example/';
    const request = new Request(root);
    const select = (input: Request) => functionOfRequest(app, manifest, input, 'sec-fetch-dest');

    expect(select(new Request(root, { method: 'HEAD' }))).toBeUndefined();
    expect(select(new Request(root, { headers: { purpose: 'prefetch' } }))).toBeUndefined();
    expect(select(new Request(root, { headers: { accept: 'application/json' } }))).toBeUndefined();
    expect(select(new Request(root, { headers: { 'sec-fetch-dest': 'image' } }))).toBeUndefined();
    expect(select(new Request(`${root}other`))).toBeUndefined();
    expect(functionOfRequest(app, manifest, request, 'rsc')).toBeUndefined();
    expect(
      functionOfRequest(
        app,
        { ...manifest, exactPathnames: { '/': true } },
        request,
        'sec-fetch-dest',
      ),
    ).toBe('app');
    expect(
      functionOfRequest(
        app,
        { ...manifest, reservedRoutes: [{ sourceRegex: '^/$' }] },
        request,
        'sec-fetch-dest',
      ),
    ).toBeUndefined();
  });
});
