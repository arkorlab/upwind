import {
  FUNCTION_HEADER,
  HEADER_RULES_JUDGED_HEADER,
  HEADER_RULES_LEFT_HEADER,
  MIDDLEWARE_DONE_HEADER,
  MISDIRECTED_STATUS,
  ORIGINAL_URL_HEADER,
  ROUTED_HEADER,
} from '@stayingupwind/core/paas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppModule, NodeHandler, WebHandler } from '../src/app-module.ts';
import { handleRequest } from '../src/handle.ts';
import { decodeHandOff, encodeHandOff } from '../src/handoff.ts';
import { withRoutingOf } from '../src/resolve-request.ts';
import type { RoutedInput } from '../src/serve.ts';
import { getStore, type Store } from '../src/store.ts';

/**
 * The header rules of `next.config` on a request the edge ran the middleware for, and judged those
 * rules for on the request as the client sent it (`HEADER_RULES_JUDGED_HEADER`): routing leaves them
 * out, for the edge to lay, and the answer says so (`HEADER_RULES_LEFT_HEADER`). Next.js judges them
 * once, ahead of the middleware; judged here, on the request as the middleware left it, the rules of
 * the path the client asked for were lost, and those of the path it was rewritten to were added.
 */

vi.mock(import('../src/store.ts'), async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, getStore: vi.fn() };
});

vi.mock(import('../src/node-bridge.ts'), () => {
  const render = vi.fn(() => Promise.resolve(new Response('page')));
  return { invokeNodeHandler: render };
});

const ASKED = '/asked';
const TARGET = '/target';
const MOVED = '/moved';
const MIDDLEWARE = '/_middleware';

/**
 * The router runs for real: a rule for the path asked for, one for the path the middleware rewrote
 * it to, one for a header the middleware set, and a redirect, all ahead of the middleware.
 */
function deployment(placedIn?: string): Store {
  return {
    manifest: {
      buildId: 'build',
      config: { basePath: '' },
      routing: {
        beforeMiddleware: [
          { sourceRegex: `^${ASKED}$`, headers: { 'x-asked': 'rule' } },
          { sourceRegex: `^${TARGET}$`, headers: { 'x-target': 'rule' } },
          {
            sourceRegex: '^/.*$',
            headers: { 'x-changed': 'rule' },
            has: [{ type: 'header', key: 'x-set-by-middleware' }],
          },
          { sourceRegex: `^${MOVED}$`, headers: { Location: TARGET }, status: 308 },
        ],
        middlewareMatchers: [{ sourceRegex: '^/.*$' }],
        beforeFiles: [],
        afterFiles: [],
        dynamicRoutes: [],
        onMatch: [],
        fallback: [],
        shouldNormalizeNextData: false,
      },
      entrypoints: [
        {
          id: TARGET,
          kind: 'app-page',
          pathname: TARGET,
          ...(placedIn !== undefined && { function: placedIn }),
        },
      ],
    },
    pathnames: [TARGET],
    slashSpellings: new Map(),
    dynamicRoutes: [],
    staticFiles: new Map(),
    shellsByRoute: new Map(),
    prerendersById: new Map(),
    prerendersByPathname: new Map(),
    readBlob: () => new Uint8Array(),
  } as unknown as Store;
}

const page: NodeHandler = () => Promise.resolve();

/** A deployment whose middleware lets every request through, counting the times it runs. */
function passing(): { app: AppModule; runs: () => number } {
  let runs = 0;
  const middleware: WebHandler = () => {
    runs += 1;
    return Promise.resolve(new Response(null, { headers: { 'x-middleware-next': '1' } }));
  };
  return {
    app: {
      entries: {
        [MIDDLEWARE]: () => ({ handler: middleware }),
        [TARGET]: () => ({ handler: page }),
      },
    },
    runs: () => runs,
  };
}

/**
 * The request the edge sends on once its middleware has rewritten `/asked` to `to` and set a
 * request header, with the platform's `headers` beside it.
 */
function fromTheEdge(headers: Record<string, string>, to = TARGET): Request {
  return new Request(`https://app.test${to}`, {
    headers: {
      [ORIGINAL_URL_HEADER]: `https://app.test${ASKED}`,
      'x-set-by-middleware': '1',
      ...headers,
    },
  });
}

const RAN_AND_JUDGED = { [MIDDLEWARE_DONE_HEADER]: '1', [HEADER_RULES_JUDGED_HEADER]: '1' };

function handle(app: AppModule, request: Request): Promise<Response> {
  return handleRequest({
    app,
    edge: { entries: {} },
    request,
    waitUntil: () => {
      // Nothing is scheduled for these renders.
    },
  });
}

describe('the header rules ahead of the middleware, where the edge ran it', () => {
  beforeEach(() => {
    vi.stubGlobal('__ARKOR_FUNCTION_KIND__', 'app');
    vi.stubGlobal('__ARKOR_FUNCTION_NAME__', 'app');
    vi.mocked(getStore).mockReturnValue(deployment());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('leaves them out, and says so, where the edge judged them', async () => {
    const { app, runs } = passing();

    const response = await handle(app, fromTheEdge(RAN_AND_JUDGED));

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('page');
    expect(response.headers.get('x-target')).toBeNull();
    expect(response.headers.get('x-changed')).toBeNull();
    expect(response.headers.get(HEADER_RULES_LEFT_HEADER)).toBe('1');
    expect(runs()).toBe(0);
  });

  /** What an edge from before it sends: the rules are laid here, as they always were. */
  it('lays them, and says nothing, where the edge judged none', async () => {
    const { app } = passing();

    const response = await handle(app, fromTheEdge({ [MIDDLEWARE_DONE_HEADER]: '1' }));

    expect(response.headers.get('x-target')).toBe('rule');
    expect(response.headers.get('x-changed')).toBe('rule');
    expect(response.headers.has(HEADER_RULES_LEFT_HEADER)).toBe(false);
  });

  /** A judging named without the middleware run is no one's: the request is routed whole. */
  it('lays them where the edge did not run the middleware', async () => {
    const { app, runs } = passing();
    const request = new Request(`https://app.test${TARGET}`, {
      headers: { [HEADER_RULES_JUDGED_HEADER]: '1' },
    });

    const response = await handle(app, request);

    expect(response.headers.get('x-target')).toBe('rule');
    expect(response.headers.has(HEADER_RULES_LEFT_HEADER)).toBe(false);
    expect(runs()).toBe(1);
  });

  /**
   * The edge runs the middleware for a path a redirect claims, and hands it on as it came where the
   * middleware leaves it so: the redirect is the one Next.js makes there.
   */
  it('keeps the redirects ahead of the middleware', async () => {
    const { app } = passing();

    const response = await handle(app, fromTheEdge(RAN_AND_JUDGED, MOVED));

    expect(response.status).toBe(308);
    expect(response.headers.get('location')).toBe(TARGET);
    expect(response.headers.get('x-changed')).toBeNull();
    expect(response.headers.get(HEADER_RULES_LEFT_HEADER)).toBe('1');
  });

  /**
   * A request another Function routed is answered with the routing it handed over, which it left
   * the rules out of by the same request's headers.
   */
  it('says so of a request another Function routed and handed over', async () => {
    const { app } = passing();
    const handOff = encodeHandOff({
      route: TARGET,
      pathname: TARGET,
      url: TARGET,
      headers: [['x-collected', 'routing']],
    });

    const judged = await handle(app, fromTheEdge({ ...RAN_AND_JUDGED, [ROUTED_HEADER]: handOff }));
    const unjudged = await handle(
      app,
      fromTheEdge({ [MIDDLEWARE_DONE_HEADER]: '1', [ROUTED_HEADER]: handOff }),
    );

    expect(judged.headers.get('x-collected')).toBe('routing');
    expect(judged.headers.get(HEADER_RULES_LEFT_HEADER)).toBe('1');
    expect(unjudged.headers.has(HEADER_RULES_LEFT_HEADER)).toBe(false);
  });

  /**
   * The answer that says a route is another Function's is known by itself, not by its headers: the
   * edge sends the request on with the routing it hands over, which leaves the rules out, and the
   * Function that holds the route says so.
   */
  it('hands over a route of another Function as it did, its routing without the rules', async () => {
    vi.mocked(getStore).mockReturnValue(deployment('other'));
    const { app } = passing();

    const response = await handle(app, fromTheEdge(RAN_AND_JUDGED));

    expect(response.status).toBe(MISDIRECTED_STATUS);
    expect(response.headers.get(FUNCTION_HEADER)).toBe('other');
    expect(response.headers.has(HEADER_RULES_LEFT_HEADER)).toBe(false);

    const handOff = decodeHandOff(response.headers.get(ROUTED_HEADER) ?? '');

    expect(handOff?.route).toBe(TARGET);
    expect(handOff?.headers.map(([name]) => name)).not.toContain('x-target');
  });

  /** A regeneration in the foreground is routed as the usual path routes the request. */
  it('leaves them out of what routing lays on a regeneration in the foreground', async () => {
    const store = deployment();
    const routed = (request: Request): Promise<Response> =>
      withRoutingOf({ request } as unknown as RoutedInput, store, new Response('render'));

    const judged = await routed(fromTheEdge(RAN_AND_JUDGED));
    const unjudged = await routed(fromTheEdge({ [MIDDLEWARE_DONE_HEADER]: '1' }));

    await expect(judged.text()).resolves.toBe('render');
    expect(judged.headers.get('x-target')).toBeNull();
    expect(judged.headers.get(HEADER_RULES_LEFT_HEADER)).toBe('1');
    expect(unjudged.headers.get('x-target')).toBe('rule');
    expect(unjudged.headers.has(HEADER_RULES_LEFT_HEADER)).toBe(false);
  });
});
