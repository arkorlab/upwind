import type { ImagesConfig } from '@stayingupwind/core/images';
import type { ProjectManifest, StaticFileEntry } from '@stayingupwind/core/manifest';
import { DEFAULT_DELIVERY_POLICY } from '@stayingupwind/host/delivery';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { createEdgeMemory } from '../src/memory/caches.ts';
import { serveFromPointer } from '../src/route.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import { pprDocument, seedSite } from './helpers/site.ts';

const PATH = '/_next/static/media/fallback.hash.png';
const CURRENT = 'current stored fallback bytes';
const PREVIOUS = 'previous stored fallback bytes';
const CURRENT_DPL = 'dpl_current';
const OLD_DPL = 'dpl_previous';
const IMAGE_PATH = '/_next/image';
const CONFIG: ImagesConfig = {
  path: IMAGE_PATH,
  basePath: '',
  dangerouslyAllowLocalIP: false,
  dangerouslyAllowSVG: false,
  sizes: [64],
  qualities: [75],
  formats: ['image/webp'],
  minimumCacheTTL: 60,
  maximumRedirects: 2,
  maximumResponseBody: 1_000_000,
  remotePatterns: [],
  domains: [],
  localPatterns: [{ pathname: '^.*$' }],
  contentDispositionType: 'inline',
  contentSecurityPolicy: "script-src 'none'; sandbox;",
};

type Build = 'current' | 'shared' | 'kept' | 'dpl-only';
interface Options {
  readonly build: Build;
  readonly method?: string;
  readonly target?: string;
  readonly reserved?: 'always' | 'missing-connection' | 'over-budget';
}

function fileFor(
  build: Build,
  current: StaticFileEntry,
  previous: StaticFileEntry,
): StaticFileEntry {
  if (build === 'kept' || build === 'dpl-only') {
    return {
      ...previous,
      deploymentId: OLD_DPL,
      ...(build === 'dpl-only' && { dplOnly: true }),
    };
  }
  return {
    ...current,
    ...(build === 'shared' && { previous: { ...previous, deploymentId: OLD_DPL } }),
  };
}

async function rewrittenFile(options: Options) {
  const site = await seedSite({
    document: pprDocument(),
    images: CONFIG,
    files: { [PATH]: CURRENT, '/previous.png': PREVIOUS },
    headerRules: [{ sourceRegex: '^/_next/image$', headers: { 'X-Original-Rule': 'retained' } }],
  });
  const current = site.manifest.staticFiles?.[PATH];
  const previous = site.manifest.staticFiles?.['/previous.png'];
  if (current === undefined || previous === undefined) {
    throw new Error('both fallback bodies must be stored');
  }
  const manifest: ProjectManifest = {
    ...site.manifest,
    deployment: { ...site.manifest.deployment, dplId: CURRENT_DPL },
    middleware: { matchers: [{ sourceRegex: '^/_next/image$' }] },
    staticFiles: { [PATH]: fileFor(options.build, current, previous) },
    reservedRoutes:
      options.reserved === undefined
        ? undefined
        : [
            {
              sourceRegex: String.raw`^/_next/static/media/fallback\.hash\.png$`,
              beforeFiles: true,
              ...(options.reserved === 'missing-connection' && {
                missing: [{ type: 'header', key: 'connection', value: 'x-private-hop' }],
              }),
              ...(options.reserved === 'over-budget' && {
                has: [{ type: 'header', key: 'x-budget', value: 'a+a+b' }],
              }),
            },
          ],
  };
  // An old pin belongs to the optimizer URL, not to the fallback chosen by its middleware.
  // Invalid optimizer parameters also cease to matter once the request has become a plain file.
  const request = new Request<unknown, IncomingRequestCfProperties>(
    `https://site.example${IMAGE_PATH}?url=%2Foriginal.png&w=64&q=0&dpl=${OLD_DPL}`,
    {
      method: options.method ?? 'GET',
      headers: {
        accept: 'image/webp',
        connection: 'x-private-hop',
        'x-private-hop': 'present',
        ...(options.reserved === 'over-budget' && { 'x-budget': `${'a'.repeat(2000)}bc` }),
      },
    },
  );
  const dispatched: string[] = [];
  const ctx = createExecutionContext();
  try {
    const response = await serveFromPointer(
      {
        request,
        url: new URL(request.url),
        env,
        ctx,
        runtime: standaloneRuntime(env, {
          memory: createEdgeMemory(() => Date.now()),
          dispatchApp: (script) => {
            dispatched.push(script);
            const answer =
              script === 'site-middleware'
                ? new Response(null, {
                    status: 201,
                    headers: {
                      'x-middleware-rewrite': new URL(options.target ?? PATH, request.url).href,
                      'set-cookie': 'mw=1; Path=/',
                    },
                  })
                : new Response('Function fallback', { status: 404 });
            return Promise.resolve(answer);
          },
        }),
        host: standaloneHost(env),
        pointer: {
          ...site.pointer,
          app: {
            deploymentId: 'dpl_site',
            scriptName: 'site-app',
            middlewareScriptName: 'site-middleware',
          },
        },
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
    return { response, body: await response.text(), dispatched };
  } finally {
    await waitOnExecutionContext(ctx);
  }
}

describe('an optimizer request rewritten to a shipped file', () => {
  it.each([
    { build: 'current', expected: CURRENT },
    { build: 'shared', expected: CURRENT },
    { build: 'kept', expected: PREVIOUS },
  ] as const)('serves the eligible $build target from storage', async (example) => {
    const result = await rewrittenFile({ build: example.build });

    expect(result.response.status).toBe(201);
    expect(result.body).toBe(example.expected);
    expect(result.response.headers.get('content-length')).toBe(String(example.expected.length));
    expect(result.response.headers.get('x-original-rule')).toBe('retained');
    expect(result.response.headers.get('set-cookie')).toContain('mw=1');
    expect(result.dispatched).toStrictEqual(['site-middleware']);
  });

  it('sends the stored representation length but no body for HEAD', async () => {
    const result = await rewrittenFile({ build: 'current', method: 'HEAD' });

    expect(result.response.status).toBe(201);
    expect(result.body).toBe('');
    expect(result.response.body).toBeNull();
    expect(result.response.headers.get('content-length')).toBe(String(CURRENT.length));
    expect(result.dispatched).toStrictEqual(['site-middleware']);
  });

  it.each([
    { build: 'dpl-only' },
    { build: 'current', target: '/not-a-shipped-file' },
    { build: 'current', reserved: 'always' },
    { build: 'current', reserved: 'missing-connection' },
    { build: 'current', reserved: 'over-budget' },
  ] as const)('hands an ineligible or reserved target to the Function: %j', async (options) => {
    const result = await rewrittenFile(options);

    expect(result.response.status).toBe(404);
    expect(result.body).toBe('Function fallback');
    expect(result.dispatched).toStrictEqual(['site-middleware', 'site-app']);
  });
});
