import type { ProjectManifest } from '@stayingupwind/core/manifest';
import {
  decodeLocaleRequest,
  encodeLocaleRequest,
  LOCALE_REQUEST_HEADER,
} from '@stayingupwind/core/paas';
import { DEFAULT_DELIVERY_POLICY } from '@stayingupwind/host/delivery';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';

import { rootLocaleRequest } from '../src/handlers/locale-request.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import { serveFromPointer } from '../src/route.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import { htmlResponse, navigation, pprDocument, seedSite } from './helpers/site.ts';

const PREFIX = {
  basePath: '/base',
  locales: ['en', 'fr'],
} satisfies NonNullable<ProjectManifest['spelledPrefix']>;
const MIDDLEWARE = {
  matchers: [{ sourceRegex: '^/.*$' }],
} satisfies NonNullable<ProjectManifest['middleware']>;
const CREDENTIALS = { cookies: [], headers: [] } as const;
const FORGED = encodeLocaleRequest({ language: 'forged', cookie: 'NEXT_LOCALE=forged' });

interface Example {
  readonly path?: string;
  readonly locale?: boolean;
  readonly headers?: HeadersInit;
  readonly middleware?: 'continue' | 'rewrite' | 'external' | 'redirect' | 'cached';
}

async function routed(example: Example = {}) {
  const document = pprDocument();
  const site = await seedSite({
    document,
    pathname: '/base',
    files: { '/cached.txt': 'cached without dispatch' },
  });
  const manifest: ProjectManifest = {
    ...site.manifest,
    middleware: MIDDLEWARE,
    ...(example.locale !== false && { spelledPrefix: PREFIX }),
  };
  const applications: Request[] = [];
  const middlewareRequests: Request[] = [];
  const externals: Request[] = [];
  const request = navigation(example.path ?? '/base', {
    ...(example.headers !== undefined && { headers: example.headers }),
  });
  const ctx = createExecutionContext();
  const response = await serveFromPointer(
    {
      request,
      url: new URL(request.url),
      env,
      ctx,
      runtime: standaloneRuntime(env, {
        memory: createEdgeMemory(() => Date.now()),
        dispatchApp: (script, handed) => {
          if (script !== 'site-middleware') {
            applications.push(handed);
            return Promise.resolve(
              htmlResponse(document.suffix, { headers: { [LOCALE_REQUEST_HEADER]: FORGED } }),
            );
          }
          middlewareRequests.push(handed);
          if (example.middleware === 'redirect') {
            return Promise.resolve(
              new Response(null, { status: 307, headers: { location: '/base/fr' } }),
            );
          }
          const headers = new Headers({
            'x-middleware-override-headers': `accept-language,cookie,${LOCALE_REQUEST_HEADER}`,
            'x-middleware-request-accept-language': 'fr',
            'x-middleware-request-cookie': 'NEXT_LOCALE=fr; middleware=added',
            [`x-middleware-request-${LOCALE_REQUEST_HEADER}`]: FORGED,
          });
          switch (example.middleware) {
            case 'external': {
              headers.set('x-middleware-rewrite', 'https://origin.example/result');
              break;
            }
            case 'cached': {
              headers.set('x-middleware-rewrite', 'https://site.example/cached.txt');
              break;
            }
            case 'rewrite': {
              headers.set('x-middleware-rewrite', 'https://site.example/base/inspect');
              break;
            }
            case 'continue':
            case undefined: {
              headers.set('x-middleware-next', '1');
            }
          }
          return Promise.resolve(new Response(null, { headers }));
        },
        fetchImpl: (handed) => {
          externals.push(new Request(handed));
          return Promise.resolve(new Response('external'));
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
  const body = await response.text();
  await waitOnExecutionContext(ctx);
  return { applications, middlewareRequests, externals, response, body };
}

describe('original locale request at the edge', () => {
  it.each(['/base', '/base/', '/', '/index', '/base/index/'])(
    'captures only locale inputs at potential root %s',
    (path) => {
      const headers = new Headers({
        'accept-language': 'en',
        cookie: 'private=secret; NEXT_LOCALE=%66%72; NEXT_LOCALE=en',
      });

      expect(
        rootLocaleRequest(
          { spelledPrefix: PREFIX, middleware: MIDDLEWARE },
          new URL(`https://site.example${path}`),
          headers,
          CREDENTIALS,
        ),
      ).toStrictEqual({ language: 'en', cookie: 'NEXT_LOCALE=%66%72' });
      expect(headers.get('cookie')).toContain('private=secret');
    },
  );

  it('does not inspect headers outside the i18n middleware root', () => {
    const headers = new Headers();
    const get = vi.spyOn(headers, 'get');
    for (const [manifest, path] of [
      [{ spelledPrefix: PREFIX, middleware: MIDDLEWARE }, '/base/account'],
      [{ middleware: MIDDLEWARE }, '/'],
      [{ spelledPrefix: PREFIX }, '/base'],
    ] as const) {
      expect(
        rootLocaleRequest(manifest, new URL(`https://site.example${path}`), headers, CREDENTIALS),
      ).toBeUndefined();
    }

    expect(get).not.toHaveBeenCalled();
  });

  it('takes host credentials off the snapshot without changing the original headers', () => {
    const headers = new Headers({
      'accept-language': 'fr',
      cookie: 'NEXT_LOCALE=fr; private=secret',
    });

    expect(
      rootLocaleRequest(
        { spelledPrefix: PREFIX, middleware: MIDDLEWARE },
        new URL('https://site.example/base'),
        headers,
        { cookies: ['NEXT_LOCALE'], headers: ['accept-language'] },
      ),
    ).toStrictEqual({ language: null, cookie: null });
    expect(headers.get('accept-language')).toBe('fr');
    expect(headers.get('cookie')).toBe('NEXT_LOCALE=fr; private=secret');
  });

  it.each(['continue', 'rewrite'] as const)(
    'preserves original locale inputs after middleware %s and strips forged metadata',
    async (middleware) => {
      const result = await routed({
        middleware,
        headers: {
          'accept-language': 'en,fr;q=0.8',
          cookie: 'session=secret; NEXT_LOCALE="en"',
          [LOCALE_REQUEST_HEADER]: FORGED,
        },
      });

      expect(result.middlewareRequests).toHaveLength(1);
      expect(result.middlewareRequests[0]?.headers.has(LOCALE_REQUEST_HEADER)).toBe(false);
      expect(result.applications).toHaveLength(1);

      const application = result.applications[0];

      expect(application?.headers.get('accept-language')).toBe('fr');
      expect(application?.headers.get('cookie')).toBe('NEXT_LOCALE=fr; middleware=added');
      expect(
        decodeLocaleRequest(application?.headers.get(LOCALE_REQUEST_HEADER) ?? ''),
      ).toStrictEqual({
        language: 'en,fr;q=0.8',
        cookie: 'NEXT_LOCALE="en"',
      });
      expect(result.response.headers.has(LOCALE_REQUEST_HEADER)).toBe(false);
    },
  );

  it('records explicit absence despite middleware adding both inputs', async () => {
    const result = await routed();

    expect(
      decodeLocaleRequest(result.applications[0]?.headers.get(LOCALE_REQUEST_HEADER) ?? ''),
    ).toStrictEqual({ language: null, cookie: null });
  });

  it.each([{ path: '/base/account' }, { locale: false }])(
    'does not mint locale metadata for %j',
    async (example) => {
      const result = await routed({ ...example, headers: { [LOCALE_REQUEST_HEADER]: FORGED } });

      expect(result.applications).toHaveLength(1);
      expect(result.applications[0]?.headers.has(LOCALE_REQUEST_HEADER)).toBe(false);
    },
  );

  it('keeps external rewrite requests free of the carrier', async () => {
    const result = await routed({
      middleware: 'external',
      headers: { [LOCALE_REQUEST_HEADER]: FORGED },
    });

    expect(result.externals).toHaveLength(1);
    expect(result.externals[0]?.headers.has(LOCALE_REQUEST_HEADER)).toBe(false);
    expect(result.applications).toHaveLength(0);
    expect(result.body).toBe('external');
  });

  it('returns the middleware-only root redirect without dispatching the application', async () => {
    const result = await routed({ middleware: 'redirect', headers: { 'accept-language': 'fr' } });

    expect(result.response.status).toBe(307);
    expect(result.response.headers.get('location')).toBe('/base/fr');
    expect(result.middlewareRequests).toHaveLength(1);
    expect(result.applications).toHaveLength(0);
    expect(result.response.headers.has(LOCALE_REQUEST_HEADER)).toBe(false);
  });

  it('retains the cached target path without another application dispatch', async () => {
    const result = await routed({ middleware: 'cached', headers: { 'accept-language': 'en' } });

    expect(result.middlewareRequests).toHaveLength(1);
    expect(result.applications).toHaveLength(0);
    expect(result.body).toBe('cached without dispatch');
    expect(result.response.headers.has(LOCALE_REQUEST_HEADER)).toBe(false);
  });
});
