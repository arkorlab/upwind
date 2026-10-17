import type { HeaderRule, ProjectManifest } from '@stayingupwind/core/manifest';
import { DEFAULT_DELIVERY_POLICY } from '@stayingupwind/host/delivery';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { createEdgeMemory } from '../src/memory/caches.ts';
import { serveFromPointer } from '../src/route.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import { navigation, pprDocument, seedSite } from './helpers/site.ts';

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
  /** What an origin the middleware rewrites to answers; absent, a body of its own and nothing else. */
  readonly origin?: (() => Response) | undefined;
}

/**
 * A `GET` of `path` routed by a host of its own, to a deployment whose middleware matches every path
 * and answers as `answering` says. Its Function answers anything handed to it with a body of its own.
 */
async function throughMiddleware(path: string, answering: Answering): Promise<Response> {
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
    dispatchApp: (scriptName: string): Promise<Response> => {
      return Promise.resolve(
        scriptName === MIDDLEWARE_SCRIPT
          ? answering.middleware()
          : new Response('from the Function'),
      );
    },
    fetchImpl: (): Promise<Response> => Promise.resolve(origin()),
  });
  const request = navigation(path);
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
});
