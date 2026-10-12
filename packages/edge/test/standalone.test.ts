import type { ImagesConfig } from '@stayingupwind/core/images';
import { concatBytes, encodeUtf8 } from '@stayingupwind/core/util';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { createEdgeMemory } from '../src/memory/caches.ts';
import type { IncomingRequest } from '../src/request-context.ts';
import {
  functionBinding,
  handleStandalone,
  STANDALONE_NAMES,
  standaloneHost,
  type StandaloneEnv,
  standaloneRuntime,
} from '../src/standalone/index.ts';
import { htmlResponse, navigation, pprDocument, seedSite } from './helpers/site.ts';

type Dispatch = (request: Request) => Response | Promise<Response>;

/** The hostnames `vitest.config.mts` routes to the edge: the site's own, and its `workers.dev` one. */
const SITE = 'site.example';
const ALIAS = 'site-edge.example.workers.dev';
/**
 * `next/image` as a build configures it: sources on the site, on a name beneath it, and on the
 * edge's own `workers.dev` hostname — allowed, so that only the edge's own refusal stands between
 * a request and a fetch from itself.
 */
const IMAGES: ImagesConfig = {
  path: '/_next/image',
  basePath: '',
  dangerouslyAllowLocalIP: false,
  sizes: [64],
  qualities: [75],
  formats: ['image/webp'],
  minimumCacheTTL: 60,
  maximumRedirects: 2,
  maximumResponseBody: 1_000_000,
  remotePatterns: [
    {
      protocol: 'https',
      hostname: String.raw`^(?:^(?:(?:cdn\.)?site\.example|site-edge\.example\.workers\.dev)$)$`,
      pathname: '^.*$',
    },
  ],
  domains: [],
  localPatterns: [{ pathname: '^.*$', search: '' }],
  dangerouslyAllowSVG: false,
  contentSecurityPolicy: "script-src 'none'; frame-src 'none'; sandbox;",
  contentDispositionType: 'attachment',
};
const PNG = concatBytes([
  new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  encodeUtf8('png'),
]);

/** A browser's request for an optimized image of `source`, on the hostname given. */
function imageRequest(source: string, hostname: string): IncomingRequest {
  const query = `url=${encodeURIComponent(source)}&w=64&q=75`;
  return new Request(`https://${hostname}/_next/image?${query}`, {
    headers: { accept: 'image/webp,image/*,*/*;q=0.8', 'sec-fetch-dest': 'image' },
  });
}

/** A runtime of the edge's own, with memory no other test held, and the Function `dispatch` is. */
function runtimeOf(site: StandaloneEnv, dispatch?: Dispatch): ReturnType<typeof standaloneRuntime> {
  return standaloneRuntime(site, {
    memory: createEdgeMemory(() => Date.now()),
    ...(dispatch !== undefined && {
      dispatchApp: async (_scriptName: string, request: Request): Promise<Response> =>
        dispatch(request),
    }),
  });
}

async function serve(
  site: StandaloneEnv,
  request: IncomingRequest,
  runtime = runtimeOf(site),
): Promise<{ readonly response: Response; readonly body: string }> {
  const ctx = createExecutionContext();
  const response = await handleStandalone(request, site, ctx, runtime);
  const body = await response.text();
  await waitOnExecutionContext(ctx);
  return { response, body };
}

describe('a standalone edge', () => {
  it('serves the shell its pinned pointer names first, and the Function’s resume after it', async () => {
    const document = pprDocument();
    const { pointer } = await seedSite({ document });
    const site = { ...env, POINTER: JSON.stringify(pointer) };

    const { response, body } = await serve(
      site,
      navigation('/'),
      runtimeOf(site, () => htmlResponse(document.suffix)),
    );

    expect(response.status).toBe(200);
    expect(body).toBe(document.shellText + document.suffixText);
    expect(response.headers.get('x-arkor-edge')).toMatch(/^shell;/u);
    expect(response.headers.has('reporting-endpoints')).toBe(false);
  });

  it('reads a pointer kept in EDGE_STATE under its key', async () => {
    const document = pprDocument('From KV');
    const { pointer } = await seedSite({ document, pathname: '/kv' });
    await env.EDGE_STATE.put('site:pointer', JSON.stringify(pointer));
    const site = { ...env, POINTER_KEY: 'site:pointer' };

    const { response, body } = await serve(
      site,
      navigation('/kv'),
      runtimeOf(site, () => htmlResponse(document.suffix)),
    );

    expect(response.status).toBe(200);
    expect(body).toBe(document.shellText + document.suffixText);
  });

  it('serves nothing without a pointer, and nothing from one that is not a pointer', async () => {
    const none = await serve({ ...env }, navigation('/'));
    const broken = await serve({ ...env, POINTER: '{' }, navigation('/'));

    expect(none.response.status).toBe(404);
    expect(broken.response.status).toBe(503);
    expect(broken.response.headers.get('x-arkor-edge')).toContain('pointer-unavailable');
  });

  it('hands what the build does not answer to the Function, as it answered it', async () => {
    const { pointer } = await seedSite({ document: pprDocument() });
    const site = { ...env, POINTER: JSON.stringify(pointer) };
    const asked: string[] = [];

    const { response, body } = await serve(
      site,
      navigation('/api/hello'),
      runtimeOf(site, (request) => {
        asked.push(new URL(request.url).pathname);
        return new Response('hello', { headers: { 'cache-control': 'no-store' } });
      }),
    );

    expect(asked).toStrictEqual(['/api/hello']);
    expect(response.status).toBe(200);
    expect(body).toBe('hello');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('reaches a Function over the binding named after it, and answers 502 for one not bound', async () => {
    const { pointer } = await seedSite({ document: pprDocument() });
    const unbound = { ...env, POINTER: JSON.stringify(pointer) };
    const bound = {
      ...unbound,
      APP__site_app: {
        fetch: (): Promise<Response> => Promise.resolve(new Response('bound')),
      } as unknown as Fetcher,
    };

    const missing = await serve(unbound, navigation('/api/hello'));
    const reached = await serve(bound, navigation('/api/hello'));

    expect(missing.response.status).toBe(502);
    expect(missing.response.headers.get('x-arkor-edge')).toBe('error;reason=app-unreachable');
    expect(reached.body).toBe('bound');
  });

  it('serves a file of the build from the bucket', async () => {
    const { pointer } = await seedSite({
      document: pprDocument(),
      files: { '/robots.txt': 'User-agent: *' },
    });
    const site = { ...env, POINTER: JSON.stringify(pointer) };

    const { response, body } = await serve(site, navigation('/robots.txt'));

    expect(response.status).toBe(200);
    expect(body).toBe('User-agent: *');
  });

  it('fetches no image source on a hostname it is routed, whichever one a request came in on', async () => {
    const { pointer } = await seedSite({ document: pprDocument(), images: IMAGES });
    const site = { ...env, POINTER: JSON.stringify(pointer) };
    const fetched: string[] = [];
    const runtime = standaloneRuntime(site, {
      memory: createEdgeMemory(() => Date.now()),
      fetchImpl: (request): Promise<Response> => {
        fetched.push(new Request(request).url);
        return Promise.resolve(new Response(PNG, { headers: { 'content-type': 'image/png' } }));
      },
    });

    const alias = await serve(site, imageRequest(`https://${ALIAS}/a.png`, SITE), runtime);
    const own = await serve(site, imageRequest(`https://${SITE}/a.png`, ALIAS), runtime);
    const beneath = await serve(site, imageRequest(`https://cdn.${SITE}/a.png`, SITE), runtime);

    expect(alias.response.status).toBe(400);
    expect(own.response.status).toBe(400);
    expect(beneath.response.status).toBe(200);
    expect(fetched).toStrictEqual([`https://cdn.${SITE}/a.png`]);
  });

  it('follows no redirect to a hostname it is routed', async () => {
    const { pointer } = await seedSite({ document: pprDocument(), images: IMAGES });
    const site = { ...env, POINTER: JSON.stringify(pointer) };
    const fetched: string[] = [];
    // An optimizer request back on the alias, for the source the redirect came from.
    const looped = encodeURIComponent(`https://cdn.${SITE}/moved.png`);
    const back = `https://${ALIAS}/_next/image?url=${looped}&w=64&q=75`;
    const runtime = standaloneRuntime(site, {
      memory: createEdgeMemory(() => Date.now()),
      fetchImpl: (request): Promise<Response> => {
        fetched.push(new Request(request).url);
        return Promise.resolve(new Response(null, { status: 302, headers: { location: back } }));
      },
    });

    const { response } = await serve(
      site,
      imageRequest(`https://cdn.${SITE}/moved.png`, SITE),
      runtime,
    );

    expect(response.status).toBe(400);
    expect(fetched).toStrictEqual([`https://cdn.${SITE}/moved.png`]);
  });

  it('keeps what it caches under names of its own, and binds a Function by a name a binding holds', () => {
    const { names } = standaloneHost(env);

    expect(names).toStrictEqual(STANDALONE_NAMES);
    expect(Object.values(STANDALONE_NAMES).every((name) => name.includes('upwind'))).toBe(true);
    expect(functionBinding('site-app')).toBe('APP__site_app');
  });

  it('reads the hostnames it is routed as a URL writes them, and none where none are listed', async () => {
    const listed = ' Site.Example, ,www.site.example, Bücher.Example, not a host ';
    const document = pprDocument('Unlisted');
    const { pointer } = await seedSite({ document, pathname: '/unlisted' });
    const unlisted = { ...env, HOSTNAMES: undefined, POINTER: JSON.stringify(pointer) };

    const { response, body } = await serve(
      unlisted,
      navigation('/unlisted'),
      runtimeOf(unlisted, () => htmlResponse(document.suffix)),
    );

    // An internationalized one as a request names it, in its ASCII form.
    expect(standaloneHost({ ...env, HOSTNAMES: listed }).ownHostnames).toStrictEqual([
      'site.example',
      'www.site.example',
      'xn--bcher-kva.example',
    ]);
    expect(standaloneHost(unlisted).ownHostnames).toStrictEqual([]);
    expect(response.status).toBe(200);
    expect(body).toBe(document.shellText + document.suffixText);
  });
});
