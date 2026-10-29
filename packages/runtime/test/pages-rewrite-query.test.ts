import { MISDIRECTED_STATUS, ROUTED_HEADER } from '@stayingupwind/core/paas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildPassthroughRequest } from '../../edge/src/forwarding.ts';
import type { AppModule, NodeHandler } from '../src/app-module.ts';
import { handleRequest } from '../src/handle.ts';
import { decodeHandOff, encodeHandOff } from '../src/handoff.ts';
import { invokeNodeHandler } from '../src/node-bridge.ts';
import { getStore, routerPathnames, type Store } from '../src/store.ts';

/** A Pages rewrite keeps its effective query apart from the public URL in Next's request metadata. */
vi.mock(import('../src/store.ts'), async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, getStore: vi.fn() };
});
vi.mock(import('../src/node-bridge.ts'), () => {
  const render = vi.fn(() => Promise.resolve(new Response('page')));
  return { invokeNodeHandler: render };
});

const TARGET = '/base/inspect';
const ASKED = '/base/before/first?q=%E8%A8%98%E4%BA%8B&q=%E4%BA%8C';
const QUERY = { q: ['記事', '二'], phase: 'before', slug: 'first' };
const handler: NodeHandler = () => Promise.resolve();
const app: AppModule = { entries: { [TARGET]: () => ({ handler }) } };

function deployment(placedIn?: string): Store {
  const manifest = {
    buildId: 'build',
    config: { basePath: '/base' },
    entrypoints: [
      {
        id: TARGET,
        pathname: TARGET,
        kind: 'pages' as const,
        ...(placedIn !== undefined && { function: placedIn }),
      },
    ],
    prerenders: [],
    staticFiles: [],
    routing: {
      beforeMiddleware: [],
      middlewareMatchers: [],
      beforeFiles: [
        {
          sourceRegex: '^/base/before/(?<slug>[^/]+?)(?:/)?$',
          destination: '/base/inspect?phase=before&slug=$slug',
        },
      ],
      afterFiles: [],
      dynamicRoutes: [],
      onMatch: [],
      fallback: [],
      shouldNormalizeNextData: true,
    },
  };
  return {
    manifest,
    ...routerPathnames(manifest),
    dynamicRoutes: [],
    staticFiles: new Map(),
    shellsByRoute: new Map(),
    prerendersById: new Map(),
    prerendersByPathname: new Map(),
    readBlob: () => new Uint8Array(),
  } as unknown as Store;
}

function handle(request: Request): Promise<Response> {
  return handleRequest({
    app,
    edge: { entries: {} },
    request,
    waitUntil: () => {
      // These responses schedule no background work.
    },
  });
}

function invocation() {
  const input = vi.mocked(invokeNodeHandler).mock.calls[0]?.[0];
  return { url: input?.url, query: input?.requestMeta['query'] };
}

describe('the effective query of a Pages config rewrite', () => {
  beforeEach(() => {
    vi.stubGlobal('__ARKOR_FUNCTION_KIND__', 'app');
    vi.stubGlobal('__ARKOR_FUNCTION_NAME__', 'app');
    vi.mocked(getStore).mockReturnValue(deployment());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('keeps duplicate and UTF-8 query values out of the source URL and ignores client metadata', async () => {
    const forged = encodeHandOff({
      route: TARGET,
      pathname: TARGET,
      url: '/forged',
      query: { phase: 'forged' },
      headers: [],
    });
    const forwarded = buildPassthroughRequest(
      new Request(`https://client.example${ASKED}`, { headers: { [ROUTED_HEADER]: forged } }),
      { previewDomain: 'example.test', previewHost: 'app.example.test', clientIp: undefined },
      { headers: [], cookies: [] },
    );
    const response = await handle(forwarded);

    expect({
      status: response.status,
      header: forwarded.headers.get(ROUTED_HEADER),
      ...invocation(),
    }).toStrictEqual({ status: 200, header: null, url: ASKED, query: QUERY });
  });

  it('carries the query through the existing split handoff without changing its public URL', async () => {
    vi.mocked(getStore).mockReturnValue(deployment('app-2'));
    const request = new Request(`https://app.example.test${ASKED}`);
    const first = await handle(request);
    const value = first.headers.get(ROUTED_HEADER) ?? '';
    const handOff = decodeHandOff(value);

    expect({ status: first.status, url: handOff?.url, query: handOff?.query }).toStrictEqual({
      status: MISDIRECTED_STATUS,
      url: ASKED,
      query: QUERY,
    });

    vi.stubGlobal('__ARKOR_FUNCTION_NAME__', 'app-2');
    const second = await handle(new Request(request, { headers: { [ROUTED_HEADER]: value } }));

    expect({ status: second.status, ...invocation() }).toStrictEqual({
      status: 200,
      url: ASKED,
      query: QUERY,
    });
  });
});
