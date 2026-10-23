import type { ProjectManifest } from '@stayingupwind/core/manifest';
import { DEFAULT_DELIVERY_POLICY } from '@stayingupwind/host/delivery';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';

import { createEdgeMemory } from '../src/memory/caches.ts';
import { serveFromPointer } from '../src/route.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import { navigation, pprDocument, seedSite } from './helpers/site.ts';

/** Next.js's compilation of `/:x(a+a+)!`: one test fits, two together do not. */
const QUADRATIC = String.raw`^(?:\/(a+a+))\![\/#\?]?$`;
const FILE_PATH = `/${'a'.repeat(700)}`;
/**
 * What Next.js 16.4 asks of every request to an application with `trailingSlash: true`, as its
 * deployment carries it: the two redirects ahead of every shipped file, the same two among the
 * header rules — each carries the `Location` it answers with — and the rule for the files it names
 * by their content or by the build.
 */
const FILE_REDIRECT = String.raw`^(?:\/((?!\.well-known(?:\/.*)?)(?:[^/]+\/)*[^/]+\.\w+))\/$`;
const PATH_REDIRECT = String.raw`^(?:\/((?!\.well-known(?:\/.*)?)(?:[^/]+\/)*[^/\.]+))$`;
const NOT_DATA = [{ type: 'header' as const, key: 'x-nextjs-data' }];
const BUILD_ID = 'build-3sGqk8vZp1LxQe';
const BUILT = `/_next/static/(?:[^/]+/pages|pages|chunks|immutable|runtime|css|image|media|${BUILD_ID})/.+`;

describe('header rules judged before middleware', () => {
  it('reuses the original request’s headers without spending the routing allowance twice', async () => {
    const site = await seedSite({
      document: pprDocument(),
      files: { [FILE_PATH]: 'the shipped file' },
      headerRules: [
        { sourceRegex: QUADRATIC, headers: { 'x-never': 'matches' } },
        {
          sourceRegex: '^/.*$',
          has: [{ type: 'header', key: 'x-visitor', value: 'original' }],
          headers: { 'x-chosen-for': 'original' },
        },
      ],
    });
    const manifest: ProjectManifest = {
      ...site.manifest,
      middleware: { matchers: [{ sourceRegex: '^/.*$' }] },
    };
    const dispatchApp = vi.fn((script: string) => {
      return Promise.resolve(
        script === 'site-middleware'
          ? new Response(null, {
              headers: {
                'x-middleware-next': '1',
                'x-middleware-override-headers': 'x-visitor',
                'x-middleware-request-x-visitor': 'changed',
              },
            })
          : new Response('from the Function'),
      );
    });
    const runtime = standaloneRuntime(env, {
      memory: createEdgeMemory(() => Date.now()),
      dispatchApp,
    });
    const ctx = createExecutionContext();
    const request = navigation(FILE_PATH, { headers: { 'x-visitor': 'original' } });
    const response = await serveFromPointer(
      {
        request,
        url: new URL(request.url),
        env,
        ctx,
        runtime,
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

    await expect(response.text()).resolves.toBe('the shipped file');
    expect(response.headers.get('x-arkor-edge')).toMatch(/^static;/u);
    expect(response.headers.get('x-chosen-for')).toBe('original');
    expect(dispatchApp).toHaveBeenCalledExactlyOnceWith('site-middleware', expect.any(Request), {
      cpuMs: DEFAULT_DELIVERY_POLICY.middleware.cpuMs,
      subRequests: DEFAULT_DELIVERY_POLICY.middleware.subRequests,
    });

    await waitOnExecutionContext(ctx);
  });

  it('keeps selected headers on an image refusal when its matcher spends the remaining allowance', async () => {
    const site = await seedSite({
      document: pprDocument(),
      images: {
        path: FILE_PATH,
        basePath: '',
        sizes: [64],
        formats: ['image/webp'],
        minimumCacheTTL: 60,
        maximumRedirects: 2,
        maximumResponseBody: 1_000_000,
        remotePatterns: [],
        domains: [],
        localPatterns: [],
        dangerouslyAllowLocalIP: false,
        dangerouslyAllowSVG: false,
        contentSecurityPolicy: "script-src 'none'; frame-src 'none'; sandbox;",
        contentDispositionType: 'attachment',
      },
      headerRules: [
        { sourceRegex: QUADRATIC, headers: { 'x-never': 'matches' } },
        { sourceRegex: '^/.*$', headers: { 'x-selected': 'kept' } },
      ],
    });
    const manifest: ProjectManifest = {
      ...site.manifest,
      middleware: { matchers: [{ sourceRegex: QUADRATIC }] },
    };
    const dispatchApp = vi.fn(() => Promise.resolve(new Response('must not dispatch')));
    const runtime = standaloneRuntime(env, {
      memory: createEdgeMemory(() => Date.now()),
      dispatchApp,
    });
    const ctx = createExecutionContext();
    const request = navigation(FILE_PATH);
    const response = await serveFromPointer(
      {
        request,
        url: new URL(request.url),
        env,
        ctx,
        runtime,
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

    expect(response.status).toBe(400);
    expect(response.headers.get('x-selected')).toBe('kept');
    await expect(response.text()).resolves.toBe('"url" parameter is not allowed');
    expect(dispatchApp).not.toHaveBeenCalled();

    await waitOnExecutionContext(ctx);
  });
});

describe('a shipped file of an application with `trailingSlash: true`', () => {
  /**
   * Read as cubic, the redirect for a file's path, asked twice, left too little of the request's
   * allowance at 63 characters for the rest of its rules, and the file went to the application's
   * Function, which has none to serve: the client middleware manifest answered 404, and no page of
   * the application hydrated.
   */
  it('is served by the edge within the request’s allowance', async () => {
    const path = `/_next/static/${BUILD_ID}/_clientMiddlewareManifest.js`;
    const site = await seedSite({
      document: pprDocument(),
      files: { [path]: 'self.__MIDDLEWARE_MATCHERS = [];' },
      reservedRoutes: [
        { sourceRegex: FILE_REDIRECT, missing: NOT_DATA, beforeFiles: true },
        { sourceRegex: PATH_REDIRECT, beforeFiles: true },
      ],
      headerRules: [
        { sourceRegex: FILE_REDIRECT, missing: NOT_DATA, headers: { Location: '/$1' } },
        { sourceRegex: PATH_REDIRECT, headers: { Location: '/$1/' } },
        { sourceRegex: BUILT, headers: { 'cache-control': 'public,max-age=31536000,immutable' } },
      ],
    });
    const dispatchApp = vi.fn(() => Promise.resolve(new Response('Not Found', { status: 404 })));
    const runtime = standaloneRuntime(env, {
      memory: createEdgeMemory(() => Date.now()),
      dispatchApp,
    });
    const ctx = createExecutionContext();
    const request = navigation(path);
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
          policy: DEFAULT_DELIVERY_POLICY,
        }),
      },
    );

    expect(response.headers.get('x-arkor-edge')).toMatch(/^static;/u);
    await expect(response.text()).resolves.toBe('self.__MIDDLEWARE_MATCHERS = [];');
    expect(dispatchApp).not.toHaveBeenCalled();

    await waitOnExecutionContext(ctx);
  });
});
