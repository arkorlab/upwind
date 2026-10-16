import { EDGE_BYPASS_COOKIE } from '@stayingupwind/core/request';
import type { HostCredentials } from '@stayingupwind/host/credentials';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import type { EdgeHost } from '../src/edge-host.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import type { IncomingRequest } from '../src/request-context.ts';
import { type CopyRequestBody, type PointerRequest, serveFromPointer } from '../src/route.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import { navigation, pprDocument, seedSite, type SiteOptions } from './helpers/site.ts';

/**
 * A host that composes the edge's routing itself (`serveFromPointer`), rather than running the
 * standalone Worker. Nothing in this file runs the standalone Worker, which would bound the tests of
 * the whole isolate for it.
 */

/** Two repetitions that take what the other does: quadratic in the length of what fails them. */
const QUADRATIC = String.raw`^/(?<slug>\w+\w+)!$`;
/** Long enough that the pattern's cost against it is past what a test is allowed. */
const CRAFTED = `/${'a'.repeat(4096)}`;
/** A cookie a host keeps as its own credential, which no application it hosts is handed. */
const HOST_SESSION = 'host_session';
/** A condition of the application's routing on that cookie. */
const ON_HOST_SESSION = [{ type: 'cookie' as const, key: HOST_SESSION }];
/** Any member of a class at the site's root, as Next.js compiles `/[slug]`. */
const SLUG = '^/(?<slug>[^/]+?)(?:/)?$';

/** The standalone host, keeping `HOST_SESSION` as its own (`HostCredentials`). */
function credentialedHost(): EdgeHost {
  return { ...standaloneHost(env), credentials: { cookies: [HOST_SESSION], headers: [] } };
}

/** The standalone host, keeping the `cookie` header whole: no cookie reaches the application. */
function cookielessHost(): EdgeHost {
  return { ...standaloneHost(env), credentials: { cookies: [], headers: ['Cookie'] } };
}

/** The standalone host, keeping `credentials` as its own. */
function hostKeeping(credentials: HostCredentials): EdgeHost {
  return { ...standaloneHost(env), credentials };
}

/** Draft mode's cookie, as Next.js names it: a visitor who sends it is rendered a draft. */
const DRAFT_COOKIE = '__prerender_bypass=draft-secret; theme=dark';

/** A navigation of a visitor who holds the host's cookie beside one of the application's. */
function withHostSession(path: string): IncomingRequest {
  return navigation(path, { headers: { cookie: `${HOST_SESSION}=signed-in; theme=dark` } });
}

/**
 * `request` routed by a host of its own, the site seeded as `site` says, its Function answering:
 * what it was asked for, and the body each request it was asked carried.
 */
async function routed(
  request: IncomingRequest,
  site: Omit<SiteOptions, 'document'>,
  composed: Partial<Pick<PointerRequest, 'host' | 'observePassthrough'>> = {},
): Promise<{
  readonly response: Response;
  readonly body: string;
  readonly asked: string[];
  readonly received: string[];
}> {
  const { pointer } = await seedSite({ document: pprDocument(), ...site });
  const asked: string[] = [];
  const received: string[] = [];
  const runtime = standaloneRuntime(env, {
    memory: createEdgeMemory(() => Date.now()),
    dispatchApp: async (_scriptName: string, dispatched: Request): Promise<Response> => {
      asked.push(new URL(dispatched.url).pathname);
      received.push(await dispatched.text());
      return new Response('from the Function');
    },
  });
  const ctx = createExecutionContext();
  const response = await serveFromPointer({
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
    ...composed,
  });
  const body = await response.text();
  await waitOnExecutionContext(ctx);
  return { response, body, asked, received };
}

/** What an observer is told, which a test does not look at. */
function unheeded(): void {
  // The test reads what the Function received, and what the observer read.
}

describe('the routing a host composes', () => {
  /**
   * Every test of an application's routing pattern is bounded all the same: one that would cost
   * more against the request than a test is allowed is not run, and the request goes to the
   * application's Function.
   */
  it('hands a request a pattern would cost too much to test to the Function', async () => {
    const { response, body, asked } = await routed(navigation(CRAFTED), {
      dynamicRoutes: [{ sourceRegex: QUADRATIC, route: '/[slug]' }],
    });

    expect(response.headers.get('x-arkor-edge')).toBe('passthrough;reason=pattern-budget');
    expect(body).toBe('from the Function');
    expect(asked).toStrictEqual([CRAFTED]);
  });

  /** The host's observer of a passthrough is the host's own code: what it throws changes no answer. */
  it('answers a passthrough whose observer throws as the Function answered it', async () => {
    const throwing = {
      observePassthrough: () => {
        return {
          finish: (): void => {
            throw new Error('the observer broke');
          },
        };
      },
    };

    const { response, body } = await routed(navigation('/api/hello'), {}, throwing);

    expect(response.status).toBe(200);
    expect(body).toBe('from the Function');
  });

  /**
   * And one that throws setting out to observe: it observes nothing, and the request is handed on
   * as one it left alone (Codex, upwind#179).
   */
  it('answers a passthrough whose observer throws before observing as the Function answered it', async () => {
    const throwing = {
      observePassthrough: (): never => {
        throw new Error('the observer broke');
      },
    };

    const { response, body, asked } = await routed(navigation('/api/hello'), {}, throwing);

    expect(response.status).toBe(200);
    expect(body).toBe('from the Function');
    expect(asked).toStrictEqual(['/api/hello']);
  });

  /**
   * And one that throws once it holds a copy of the body: the edge kept the branch it forwards, so
   * the request reaches the Function whole (Codex). So does one that holds a copy and observes
   * nothing, its copy let go of.
   */
  it.each([
    [
      'throws once it holds a copy of the body',
      (copyBody: CopyRequestBody): never => {
        copyBody();
        throw new Error('the observer broke');
      },
    ],
    [
      'holds a copy of the body and observes nothing',
      (copyBody: CopyRequestBody): undefined => {
        copyBody();
      },
    ],
  ])('forwards the whole body of a passthrough whose observer %s', async (_, observe) => {
    const posted = navigation('/api/hello', { method: 'POST', body: 'the visitor’s form' });

    const { response, received } = await routed(
      posted,
      {},
      {
        observePassthrough: (_request, _url, _state, copyBody) => {
          observe(copyBody);
        },
      },
    );

    expect(response.status).toBe(200);
    expect(received).toStrictEqual(['the visitor’s form']);
  });

  /**
   * A copy is taken while the observer is asked: one asked for afterwards, as the body is forwarded,
   * is refused, and the request reaches the Function whole.
   */
  it('refuses a copy of the body asked for once the observer has answered', async () => {
    const posted = navigation('/api/hello', { method: 'POST', body: 'the visitor’s form' });
    const later: (() => unknown)[] = [];

    const { received } = await routed(
      posted,
      {},
      {
        observePassthrough: (_request, _url, _state, copyBody) => {
          later.push(copyBody);
          return { finish: unheeded };
        },
      },
    );

    expect(received).toStrictEqual(['the visitor’s form']);
    expect(later[0]).toThrow(/while the observer is asked/u);
  });

  /** One that reads its copy reads the whole body, and the Function is handed the whole of it. */
  it('hands an observer a copy of the body beside the one it forwards', async () => {
    const posted = navigation('/api/hello', { method: 'POST', body: 'the visitor’s form' });
    const copies: Promise<string>[] = [];

    const { received } = await routed(
      posted,
      {},
      {
        observePassthrough: (_request, _url, _state, copyBody) => {
          copies.push(new Response(copyBody()).text());
          return { finish: unheeded };
        },
      },
    );

    expect(received).toStrictEqual(['the visitor’s form']);
    await expect(Promise.all(copies)).resolves.toStrictEqual(['the visitor’s form']);
  });

  /**
   * The application's rules are judged as its own routing judges them, on a request that never
   * holds the host's credentials: a `missing` that names one holds for every visitor, so a rule
   * ahead of the filesystem claims the page from one who carries it, and the Function answers as
   * the rule says.
   */
  it('hands the Function a page a rule claims for want of a host credential', async () => {
    const { response, body, asked } = await routed(
      withHostSession('/'),
      { reservedRoutes: [{ sourceRegex: '^/$', beforeFiles: true, missing: ON_HOST_SESSION }] },
      { host: credentialedHost() },
    );

    expect(response.headers.get('x-arkor-edge')).toBe('passthrough;reason=route-not-proved');
    expect(body).toBe('from the Function');
    expect(asked).toStrictEqual(['/']);
  });

  /** And a `has` that names one holds for no visitor: the rule claims the page from none. */
  it('serves a page a rule would claim only for a host credential', async () => {
    const { response } = await routed(
      withHostSession('/'),
      { reservedRoutes: [{ sourceRegex: '^/$', beforeFiles: true, has: ON_HOST_SESSION }] },
      { host: credentialedHost() },
    );

    expect(response.headers.get('x-arkor-edge')).toMatch(/^shell;/u);
  });

  /** So is a dynamic route's own condition: its `missing` holds, and the class's shell is served. */
  it('serves a member of a class whose route wants a host credential missing', async () => {
    const { response } = await routed(
      withHostSession('/hello'),
      {
        pathname: '/[slug]',
        dynamicRoutes: [{ sourceRegex: SLUG, route: '/[slug]', missing: ON_HOST_SESSION }],
      },
      { host: credentialedHost() },
    );

    expect(response.headers.get('x-arkor-edge')).toMatch(/^shell;/u);
  });

  /**
   * What a page's prerender is not served under (`bypassFor`) is judged on the same headers: Next.js
   * is never handed the host's cookie, so a condition on it never holds, and the page is served.
   */
  it('serves a page whose prerender is passed over only for a host credential', async () => {
    const { response } = await routed(
      withHostSession('/'),
      { bypassFor: ON_HOST_SESSION },
      { host: credentialedHost() },
    );

    expect(response.headers.get('x-arkor-edge')).toMatch(/^shell;/u);
  });

  /** So for a host that keeps the `cookie` header whole: no cookie the visitor sends is Next.js's. */
  it('serves a page whose prerender is passed over for a cookie the host keeps the header of', async () => {
    const { response } = await routed(
      navigation('/', { headers: { cookie: 'theme=dark' } }),
      { bypassFor: [{ type: 'cookie', key: 'theme' }] },
      { host: cookielessHost() },
    );

    expect(response.headers.get('x-arkor-edge')).toMatch(/^shell;/u);
  });

  /**
   * What the classification reads by name is read on the same headers, conditions or none: a host
   * that keeps draft mode's cookie as its own never hands it on, so its visitor is not in draft
   * mode where Next.js renders the page, and is served it.
   */
  it('serves a page to a visitor whose draft cookie the host keeps as its own', async () => {
    const { response } = await routed(
      navigation('/', { headers: { cookie: DRAFT_COOKIE } }),
      {},
      { host: hostKeeping({ cookies: ['__prerender_bypass'], headers: [] }) },
    );

    expect(response.headers.get('x-arkor-edge')).toMatch(/^shell;/u);
  });

  /** As it does where the host keeps the `cookie` header whole. */
  it('serves a page to a visitor whose draft cookie the host keeps the header of', async () => {
    const { response } = await routed(
      navigation('/', { headers: { cookie: DRAFT_COOKIE } }),
      {},
      { host: cookielessHost() },
    );

    expect(response.headers.get('x-arkor-edge')).toMatch(/^shell;/u);
  });

  /** And of a header it turns a request away for, which Next.js would never be handed either. */
  it('serves a page to a visitor whose internal-looking header the host keeps as its own', async () => {
    const { response } = await routed(
      navigation('/', { headers: { 'x-prerender-token': 'host-secret' } }),
      {},
      { host: hostKeeping({ cookies: [], headers: ['X-Prerender-Token'] }) },
    );

    expect(response.headers.get('x-arkor-edge')).toMatch(/^shell;/u);
  });

  /**
   * The edge's own cookie is no application's, and is read as the visitor sent it whatever the host
   * keeps: a visitor whose page broke and who reloads with it is passed on, not sent the shell
   * again.
   */
  it('passes on a visitor with the edge’s own cookie where the host keeps the header whole', async () => {
    const { response, body } = await routed(
      navigation('/', { headers: { cookie: `${EDGE_BYPASS_COOKIE}=1; theme=dark` } }),
      {},
      { host: cookielessHost() },
    );

    expect(response.headers.get('x-arkor-edge')).toBe('passthrough;reason=bypass-cookie');
    expect(body).toBe('from the Function');
  });
});
