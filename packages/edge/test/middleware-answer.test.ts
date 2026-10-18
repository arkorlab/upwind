import type { HeaderRule, ProjectManifest } from '@stayingupwind/core/manifest';
import { PLATFORM_HEADER_PREFIX } from '@stayingupwind/core/request';
import { DEFAULT_DELIVERY_POLICY } from '@stayingupwind/host/delivery';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { createEdgeMemory } from '../src/memory/caches.ts';
import { serveFromPointer } from '../src/route.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import { htmlResponse, navigation, pprDocument, seedSite } from './helpers/site.ts';

/**
 * What the edge hands a client where the application's middleware answered the request itself — a
 * redirect, a whole response — or sent it to another origin, through the routing a host composes
 * (`serveFromPointer`).
 */

/** Where the application's middleware runs, beside its Function. */
const MIDDLEWARE_SCRIPT = 'site-middleware';
/** A file the deployment ships, which the edge serves from storage once the middleware lets it. */
const FILE = '/robots.txt';
/** A rule of `next.config` `headers()` on every path. */
const EVERY_PATH = '^/.*$';

interface Answering {
  /** What the middleware answers. */
  readonly middleware: () => Response;
  /** The rules of `next.config` `headers()`; none, absent. */
  readonly headerRules?: readonly HeaderRule[] | undefined;
  /**
   * What an origin the middleware rewrites to answers the request it is sent; absent, a body of its
   * own and nothing else.
   */
  readonly origin?: ((request: Request) => Response) | undefined;
  /** The application's answer, after the middleware; absent, a plain response. */
  readonly application?: ((request: Request) => Response) | undefined;
}

/**
 * A `GET` of `path` routed by a host of its own, to a deployment whose middleware matches every path
 * and answers as `answering` says. Its Function answers anything handed to it with a body of its own.
 * `init` is the visitor's, as a navigation's.
 */
async function throughMiddleware(
  path: string,
  answering: Answering,
  init: RequestInit = {},
): Promise<Response> {
  const site = await seedSite({
    document: pprDocument(),
    files: { [FILE]: 'User-agent: *' },
    headerRules: answering.headerRules,
  });
  const manifest: ProjectManifest = {
    ...site.manifest,
    middleware: { matchers: [{ sourceRegex: EVERY_PATH }] },
  };
  const origin = answering.origin ?? ((): Response => new Response('from the origin'));
  const runtime = standaloneRuntime(env, {
    memory: createEdgeMemory(() => Date.now()),
    dispatchApp: (scriptName: string, request: Request): Promise<Response> => {
      return Promise.resolve(
        scriptName === MIDDLEWARE_SCRIPT
          ? answering.middleware()
          : (answering.application?.(request) ?? new Response('from the Function')),
      );
    },
    fetchImpl: (request: Request): Promise<Response> => Promise.resolve(origin(request)),
  });
  const request = navigation(path, init);
  const ctx = createExecutionContext();
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
          middlewareScriptName: MIDDLEWARE_SCRIPT,
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
  if (answering.application !== undefined) {
    await response.clone().arrayBuffer();
  }
  await waitOnExecutionContext(ctx);
  return response;
}

/** A redirect the middleware answers with, a header and a cookie of its own on it. */
function redirectToLogin(): Response {
  return new Response(null, {
    status: 307,
    headers: {
      location: 'https://site.example/login',
      'x-set-by': 'middleware',
      'set-cookie': 'mw=1; Path=/',
    },
  });
}

/** A whole response the middleware answers with, likewise. */
function refusal(): Response {
  return new Response('denied', {
    status: 401,
    headers: {
      'content-type': 'text/plain',
      'x-set-by': 'middleware',
      'set-cookie': 'mw=1; Path=/',
    },
  });
}

describe('an answer the middleware gives', () => {
  it.each([FILE, '/api/hello'])(
    'drops fields nominated by continuing middleware Connection on %s',
    async (path) => {
      const response = await throughMiddleware(path, {
        middleware: () => {
          return new Response(null, {
            headers: {
              'x-middleware-next': '1',
              connection: 'X-Internal',
              'x-internal': 'one hop only',
              'x-visible': 'retained',
            },
          });
        },
      });

      expect(response.headers.get('x-internal')).toBeNull();
      expect(response.headers.get('connection')).toBeNull();
      expect(response.headers.get('x-visible')).toBe('retained');
    },
  );

  /**
   * The headers a rule of `next.config` sets are collected by Next.js's router before the
   * middleware runs, and laid on a redirect or a whole response the middleware answers with, under
   * the middleware's own (greptile, Codex, upwind#179): a CORS allowance stays on a redirect a
   * cross-origin caller is to follow, a header both set is the middleware's, and a rule's cookie
   * goes out ahead of the middleware's, scoped as any is.
   */
  it.each([
    ['a redirect', 'a document', { path: '/', middleware: redirectToLogin, status: 307 }],
    ['a whole response', 'a document', { path: '/', middleware: refusal, status: 401 }],
    ['a redirect', 'a shipped file', { path: FILE, middleware: redirectToLogin, status: 307 }],
    ['a whole response', 'a shipped file', { path: FILE, middleware: refusal, status: 401 }],
  ] as const)(
    'lays the headers a rule sets under %s the middleware answers %s with',
    async (_answer, _asked, { path, middleware, status }) => {
      const response = await throughMiddleware(path, {
        middleware,
        headerRules: [
          {
            sourceRegex: EVERY_PATH,
            headers: {
              'Access-Control-Allow-Origin': '*',
              'X-Set-By': 'rule',
              'Set-Cookie': 'rule=1; Path=/',
            },
          },
        ],
      });

      expect({
        status: response.status,
        edge: response.headers.get('x-arkor-edge'),
        allowed: response.headers.get('access-control-allow-origin'),
        setBy: response.headers.get('x-set-by'),
        cookies: response.headers.getSetCookie(),
      }).toStrictEqual({
        status,
        edge: 'passthrough;reason=middleware',
        allowed: '*',
        setBy: 'middleware',
        cookies: ['rule=1; Path=/', 'mw=1; Path=/'],
      });
    },
  );

  /**
   * What of the middleware protocol its own answer still carries — the copy of a cookie
   * `NextResponse` writes beside each it sets, the request headers it overrode, the markers of what
   * it decided — Next.js's router reads off and hands no client (Codex, upwind#179). A header under
   * the same prefix that is not the protocol's stays: Next.js's own client router reads
   * `x-middleware-cache` off an answer.
   */
  it('hands the client none of the middleware protocol its own answer carries', async () => {
    const response = await throughMiddleware('/', {
      middleware: () => {
        return new Response(null, {
          status: 307,
          headers: {
            location: 'https://site.example/login',
            'set-cookie': 'mw=1; Path=/',
            'x-middleware-set-cookie': 'mw=1; Path=/',
            'x-middleware-override-headers': 'x-user',
            'x-middleware-request-x-user': 'someone',
            'x-middleware-next': '1',
            'x-middleware-refresh': '1',
            'x-middleware-cache': 'no-cache',
          },
        });
      },
    });

    expect({
      status: response.status,
      location: response.headers.get('location'),
      cookies: response.headers.getSetCookie(),
      prefixed: [...response.headers.keys()].filter((name) => name.startsWith('x-middleware-')),
    }).toStrictEqual({
      status: 307,
      location: 'https://site.example/login',
      cookies: ['mw=1; Path=/'],
      prefixed: ['x-middleware-cache'],
    });
  });

  /**
   * Another origin's answer to a rewrite is that origin's body, of the type it names: Next.js's proxy
   * writes the origin's own headers over what routing set before it proxied. Where the origin names
   * none, what routing set stands — the middleware's type, else a rule's (cubic, upwind#179).
   */
  it.each([
    ['names its own', { origin: 'text/html', middleware: undefined, type: 'text/html' }],
    ['names none', { origin: undefined, middleware: undefined, type: 'application/rss+xml' }],
    [
      'names none, the middleware naming one',
      { origin: undefined, middleware: 'text/csv', type: 'text/csv' },
    ],
  ] as const)(
    'answers a rewrite to an origin that %s under the type Next.js gives it',
    async (_case, { origin, middleware, type }) => {
      const response = await throughMiddleware('/', {
        middleware: () => {
          return new Response(null, {
            headers: {
              'x-middleware-rewrite': 'https://elsewhere.example/feed',
              ...(middleware !== undefined && { 'content-type': middleware }),
            },
          });
        },
        headerRules: [
          { sourceRegex: EVERY_PATH, headers: { 'Content-Type': 'application/rss+xml' } },
        ],
        // Bytes rather than a string, which would name a type of its own.
        origin: () => {
          return new Response(new TextEncoder().encode('<rss/>'), {
            headers: origin === undefined ? {} : { 'content-type': origin },
          });
        },
      });

      expect({
        edge: response.headers.get('x-arkor-edge'),
        type: response.headers.get('content-type'),
      }).toStrictEqual({ edge: 'passthrough;reason=external-rewrite', type });
    },
  );

  /**
   * Another origin is sent what Next.js's proxy sends it: the request its middleware was handed, as
   * the middleware left it, under `x-forwarded-host` naming the host the client asked on whatever
   * the middleware made of it (`proxyRequest`). The middleware is handed the edge's forwarding
   * headers — the client's address as the edge observed it, not one a client wrote — and none of a
   * client's `x-forwarded-*` or `cf-*`, so the origin is sent none either; nor the edge's own
   * headers, nor one that belongs to a single connection (Codex, upwind#179).
   */
  it('sends another origin the request its middleware was handed, as the middleware left it', async () => {
    const sent: Request[] = [];
    await throughMiddleware(
      '/',
      {
        middleware: () => {
          return new Response(null, {
            headers: {
              'x-middleware-rewrite': 'https://elsewhere.example/feed',
              'x-forwarded-host': 'middleware.example',
            },
          });
        },
        origin: (request) => {
          sent.push(request);
          return new Response('from the origin');
        },
      },
      {
        headers: {
          'accept-language': 'ja',
          'cf-connecting-ip': '203.0.113.7',
          'cf-ray': 'written-by-the-client',
          'x-forwarded-for': '198.51.100.66',
          'x-forwarded-proto': 'http',
          'x-arkor-ip-country': 'XX',
          'proxy-authorization': 'Basic c2VjcmV0',
          te: 'trailers',
        },
      },
    );
    const headers = sent[0]?.headers ?? new Headers();

    expect({
      language: headers.get('accept-language'),
      forwardedFor: headers.get('x-forwarded-for'),
      forwardedHost: headers.get('x-forwarded-host'),
      forwardedProto: headers.get('x-forwarded-proto'),
      cloudflare: [...headers.keys()].filter((name) => name.startsWith('cf-')),
      edge: [...headers.keys()].filter((name) => name.startsWith(PLATFORM_HEADER_PREFIX)),
      proxyAuthorization: headers.get('proxy-authorization'),
      te: headers.get('te'),
    }).toStrictEqual({
      language: 'ja',
      forwardedFor: '203.0.113.7',
      forwardedHost: 'site.example',
      forwardedProto: 'https',
      cloudflare: [],
      edge: [],
      proxyAuthorization: null,
      te: null,
    });
  });

  /** What a request's `Connection` names is its one hop's, and goes with it (RFC 9110 §7.6.1). */
  it('sends another origin none of what the request’s Connection names', async () => {
    const sent: Request[] = [];
    await throughMiddleware('/', {
      middleware: () => {
        return new Response(null, {
          headers: {
            'x-middleware-rewrite': 'https://elsewhere.example/feed',
            'x-middleware-override-headers': 'connection,x-internal,accept-language',
            'x-middleware-request-connection': 'X-Internal',
            'x-middleware-request-x-internal': 'secret',
            'x-middleware-request-accept-language': 'ja',
          },
        });
      },
      origin: (request) => {
        sent.push(request);
        return new Response('from the origin');
      },
    });
    const headers = sent[0]?.headers ?? new Headers();

    expect({
      internal: headers.get('x-internal'),
      connection: headers.get('connection'),
      language: headers.get('accept-language'),
    }).toStrictEqual({ internal: null, connection: null, language: 'ja' });
  });
});

/** A middleware tag removed before every response decision. */
function discardedTag(): Response {
  return new Response(null, {
    headers: { 'x-middleware-next': '1', connection: 'ETag', etag: '"discarded"' },
  });
}

describe('connection semantics across middleware consumers', () => {
  it.each([
    ['if-match', 200],
    ['if-none-match', 304],
  ] as const)('judges %s under the tag the file actually sends', async (condition, status) => {
    const first = await throughMiddleware(FILE, { middleware: discardedTag });
    const tag = first.headers.get('etag') ?? '';
    const response = await throughMiddleware(
      FILE,
      { middleware: discardedTag },
      {
        headers: { [condition]: tag },
      },
    );

    expect(response.status).toBe(status);
    expect(response.headers.get('etag')).toBe(tag);
  });

  it('judges If-Range under the retained file tag', async () => {
    const first = await throughMiddleware(FILE, { middleware: discardedTag });
    const tag = first.headers.get('etag') ?? '';
    const response = await throughMiddleware(
      FILE,
      { middleware: discardedTag },
      {
        headers: { 'if-range': tag, range: 'bytes=0-3' },
      },
    );

    expect(response.status).toBe(206);
    await expect(response.text()).resolves.toBe('User');
  });

  it('does not reinstate a nominated cache lifetime or modification date on a file', async () => {
    const response = await throughMiddleware(
      FILE,
      {
        middleware: () => {
          return new Response(null, {
            headers: {
              'x-middleware-next': '1',
              connection: 'Cache-Control, Last-Modified',
              'cache-control': 'public, max-age=1234',
              'last-modified': 'Tue, 15 Nov 1994 12:45:26 GMT',
            },
          });
        },
      },
      { headers: { 'if-modified-since': 'Wed, 16 Nov 1994 12:45:26 GMT' } },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, max-age=0, must-revalidate');
    expect(response.headers.get('last-modified')).toBeNull();
  });

  it('keeps discarded CSP and timing out of document decisions and headers', async () => {
    const document = pprDocument();
    const handed: Headers[] = [];
    const response = await throughMiddleware(
      '/',
      {
        middleware: () => {
          return new Response(null, {
            headers: {
              'x-middleware-next': '1',
              connection: 'Content-Security-Policy, Server-Timing, Set-Cookie, X-Source',
              'content-security-policy': 'sandbox',
              'server-timing': 'private-hop;dur=7',
              'set-cookie': 'discarded=1; Path=/',
              'x-source': 'middleware hop',
              'x-middleware-set-cookie': 'handed=1; Path=/',
            },
          });
        },
        application: (request) => {
          handed.push(request.headers);
          return htmlResponse(document.suffix);
        },
      },
      { headers: { 'x-source': 'client' } },
    );

    expect(response.headers.get('x-arkor-edge')).toContain('cont=resume');
    expect(response.headers.get('content-security-policy')).toBeNull();
    expect(response.headers.get('server-timing')).not.toContain('private-hop');
    expect(response.headers.getSetCookie()).toStrictEqual([]);
    expect(handed.map((headers) => headers.get('x-source'))).toStrictEqual(['client']);
    expect(handed[0]?.get('x-middleware-set-cookie')).toBe('handed=1; Path=/');

    await response.text();
  });

  it('does not resurrect a nominated content type on an external rewrite', async () => {
    const response = await throughMiddleware('/', {
      middleware: () => {
        return new Response(null, {
          headers: {
            'x-middleware-rewrite': 'https://elsewhere.example/feed',
            connection: 'Content-Type, Location',
            'content-type': 'text/csv',
            location: 'https://site.example/login',
          },
        });
      },
      origin: () => new Response(new Uint8Array([1, 2, 3])),
    });

    expect(response.headers.get('x-arkor-edge')).toBe('passthrough;reason=external-rewrite');
    expect(response.headers.get('content-type')).toBeNull();
    expect(response.headers.get('location')).toBeNull();
  });

  it('preserves a nominated Location as a local response decision before stripping it', async () => {
    const response = await throughMiddleware(FILE, {
      middleware: () => {
        return new Response('denied', {
          status: 401,
          headers: {
            'x-middleware-next': '1',
            connection: 'Location',
            location: 'https://site.example/login',
          },
        });
      },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('location')).toBeNull();
    await expect(response.text()).resolves.toBe('denied');
  });

  it('preserves explicit request overrides while removing nominated ordinary additions', async () => {
    const forwarded: string[] = [];
    const response = await throughMiddleware(
      '/api/hello',
      {
        middleware: () => {
          return new Response(null, {
            headers: {
              'x-middleware-next': '1',
              connection: 'X-Source, X-Middleware-Next, X-Middleware-Request-X-Source',
              'x-source': 'middleware hop',
              'x-middleware-override-headers': 'x-source',
              'x-middleware-request-x-source': 'explicit',
            },
          });
        },
        application: (request) => {
          forwarded.push(request.headers.get('x-source') ?? '');
          return new Response('from the Function');
        },
      },
      { headers: { 'x-source': 'client' } },
    );

    expect(forwarded).toStrictEqual(['explicit']);
    await expect(response.text()).resolves.toBe('from the Function');
  });

  it('retains an ordinary middleware tag when no Connection option nominates it', async () => {
    const response = await throughMiddleware(
      FILE,
      {
        middleware: () =>
          new Response(null, { headers: { 'x-middleware-next': '1', etag: '"kept"' } }),
      },
      { headers: { 'if-none-match': '"kept"' } },
    );

    expect(response.status).toBe(304);
    expect(response.headers.get('etag')).toBe('"kept"');
  });
});
