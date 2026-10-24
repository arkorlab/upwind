import type { Prerender } from '@stayingupwind/core/bundle';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppModule, NodeHandler, WebHandler } from '../src/app-module.ts';
import { handleRequest } from '../src/handle.ts';
import { invokeNodeHandler } from '../src/node-bridge.ts';
import { getStore, type Store } from '../src/store.ts';

/**
 * A client router's request for the payload of a page the build made complete.
 *
 * The build writes the payload beside the document and gives it no status of its own, whatever
 * the page answered: a redirect or a `notFound()` is carried in the payload, and the client's
 * router follows it itself. Asked to render it, the page's handler answered from its cache under
 * the page's own status, which in minimal mode it leaves to the host to take off: a client
 * navigation to a page that redirects was answered 307 (`app-dir/rsc-redirect`).
 */

vi.mock(import('../src/store.ts'), async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, getStore: vi.fn() };
});

// Whether the page's handler is asked at all is the question here.
vi.mock(import('../src/node-bridge.ts'), () => {
  const render = vi.fn(() => Promise.resolve(new Response('rendered')));
  return { invokeNodeHandler: render };
});

const PAGE = '/origin';
const PAYLOAD = '0:["redirect to /dest"]';
const TREE = '0:{"tree":{}}';
const PRELOAD = '</_next/static/media/geist.woff2>; rel=preload; as=font; crossorigin';
const CONFIG_LINK = '</configured.css>; rel=preload; as=style';
const MIDDLEWARE_LINK = '</middleware.css>; rel=preload; as=style';
const encoder = new TextEncoder();
const blobs = new Map([
  ['document', encoder.encode('<html>redirect</html>')],
  ['payload', encoder.encode(PAYLOAD)],
  ['postponed', encoder.encode('{}')],
  ['tree', encoder.encode(TREE)],
]);
const RSC = {
  header: 'rsc',
  varyHeader: 'rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch',
  prefetchSegmentHeader: 'next-router-segment-prefetch',
  prefetchSegmentSuffix: '.segment.rsc',
  prefetchSegmentDirSuffix: '.segments',
};

function prerender(pathname: string, fields: Partial<Prerender>): Prerender {
  return { id: pathname, pathname, route: PAGE, parentOutputId: PAGE, groupId: 1, ...fields };
}

/** A page that redirected while it was prerendered, and its payload as the build wrote it. */
function deployment(shellFields: Partial<Prerender> = {}, linkName = 'LiNk'): Store {
  const recorded = { [linkName]: PRELOAD, 'x-recorded': 'kept' };
  const shell = prerender(PAGE, {
    initialStatus: 307,
    initialHeaders: { location: '/dest', ...recorded },
    body: { sha256: 'document', byteLength: 21, contentType: 'text/html' },
    ...shellFields,
  });
  const payload = prerender(`${PAGE}.rsc`, {
    initialHeaders: { location: '/dest', 'x-nextjs-prerender': '1', ...recorded },
    body: { sha256: 'payload', byteLength: PAYLOAD.length, contentType: 'text/x-component' },
  });
  const tree = prerender(`${PAGE}.segments/_tree.segment.rsc`, {
    initialHeaders: recorded,
    segmentPath: '/_tree',
    body: { sha256: 'tree', byteLength: TREE.length, contentType: 'text/x-component' },
  });
  return {
    manifest: {
      buildId: 'build',
      config: { basePath: '' },
      routing: {
        beforeMiddleware: [],
        middlewareMatchers: [],
        beforeFiles: [],
        afterFiles: [],
        dynamicRoutes: [],
        onMatch: [],
        fallback: [],
        shouldNormalizeNextData: false,
        rsc: RSC,
      },
      entrypoints: [{ id: PAGE, kind: 'app-page', pathname: PAGE }],
    },
    pathnames: [PAGE],
    slashSpellings: new Map(),
    dynamicRoutes: [],
    staticFiles: new Map(),
    shellsByRoute: new Map([[PAGE, { pages: new Map([[PAGE, shell]]), patterns: [] }]]),
    prerendersById: new Map([
      [PAGE, shell],
      [payload.id, payload],
      [tree.id, tree],
    ]),
    prerendersByPathname: new Map([
      [PAGE, shell],
      [payload.pathname, payload],
      [tree.pathname, tree],
    ]),
    readBlob: (sha256: string) => blobs.get(sha256),
    tryReadBlob: (sha256: string) => blobs.get(sha256),
  } as unknown as Store;
}

const page: NodeHandler = () => Promise.resolve();
const middleware: WebHandler = () => {
  return Promise.resolve(
    new Response(null, { headers: { 'x-middleware-next': '1', Link: MIDDLEWARE_LINK } }),
  );
};

function middlewareEntry() {
  return { handler: middleware };
}

const app: AppModule = {
  entries: {
    [PAGE]: () => ({ handler: page }),
    '/_middleware': middlewareEntry,
  },
};

function ask(headers: Record<string, string>): Promise<Response> {
  return handleRequest({
    app,
    edge: { entries: {} },
    request: new Request(`https://app.test${PAGE}?_rsc=abc`, { headers }),
    waitUntil: () => {
      // Nothing is scheduled for these answers.
    },
  });
}

describe("a client router's request for a page's payload", () => {
  beforeEach(() => {
    vi.stubGlobal('__ARKOR_FUNCTION_KIND__', 'app');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('is answered with the payload the build wrote, under no status of the page', async () => {
    vi.mocked(getStore).mockReturnValue(deployment());

    const response = await ask({ rsc: '1' });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/x-component');
    await expect(response.text()).resolves.toBe(PAYLOAD);
    expect(vi.mocked(invokeNodeHandler)).not.toHaveBeenCalled();
  });

  it('is rendered for a page whose document the build left to a resume', async () => {
    vi.mocked(getStore).mockReturnValue(
      deployment({
        initialStatus: 200,
        postponed: { sha256: 'postponed', byteLength: 2, contentType: 'application/json' },
      }),
    );

    const response = await ask({ rsc: '1' });

    await expect(response.text()).resolves.toBe('rendered');
    expect(vi.mocked(invokeNodeHandler)).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ url: `${PAGE}?_rsc=abc` }),
    );
  });

  it.each(['link', 'Link', 'LiNk'])(
    'does not inherit a document %s on payloads or segments',
    async (name) => {
      vi.mocked(getStore).mockReturnValue(deployment({}, name));

      for (const segment of [undefined, '/_tree']) {
        const response = await ask({
          rsc: '1',
          ...(segment !== undefined && { 'next-router-segment-prefetch': segment }),
        });

        expect(response.headers.has('link')).toBe(false);
        expect(response.headers.get('x-recorded')).toBe('kept');
        expect(response.headers.get('content-type')).toBe('text/x-component');
        await expect(response.text()).resolves.toBe(segment === undefined ? PAYLOAD : TREE);
      }

      expect(vi.mocked(invokeNodeHandler)).not.toHaveBeenCalled();
    },
  );

  it.each(['config', 'middleware'] as const)(
    'keeps explicit %s Link on payloads and segments',
    async (source) => {
      const store = deployment();
      vi.mocked(getStore).mockReturnValue({
        ...store,
        manifest: {
          ...store.manifest,
          routing: {
            ...store.manifest.routing,
            beforeMiddleware:
              source === 'config'
                ? [{ sourceRegex: '^/origin$', headers: { Link: CONFIG_LINK } }]
                : [],
            middlewareMatchers: source === 'middleware' ? [{ sourceRegex: '^/origin$' }] : [],
          },
        },
      });

      for (const segment of [undefined, '/_tree']) {
        const response = await ask({
          rsc: '1',
          ...(segment !== undefined && { 'next-router-segment-prefetch': segment }),
        });

        expect(response.headers.get('link')).toBe(
          source === 'config' ? CONFIG_LINK : MIDDLEWARE_LINK,
        );
        expect(response.headers.get('x-recorded')).toBe('kept');
        await expect(response.text()).resolves.toBe(segment === undefined ? PAYLOAD : TREE);
      }

      expect(vi.mocked(invokeNodeHandler)).not.toHaveBeenCalled();
    },
  );

  it('keeps the document resource hints on HTML', async () => {
    vi.mocked(getStore).mockReturnValue(deployment({ initialStatus: 200 }));

    const response = await ask({});

    expect(response.headers.get('link')).toBe(PRELOAD);
    expect(response.headers.get('x-recorded')).toBe('kept');
    await expect(response.text()).resolves.toBe('<html>redirect</html>');
    expect(vi.mocked(invokeNodeHandler)).not.toHaveBeenCalled();
  });

  it('keeps an intentional Link on a built Route Handler even with an RSC content type', async () => {
    const store = deployment({
      initialStatus: 200,
      initialHeaders: { Link: PRELOAD, 'content-type': 'text/x-component' },
    });
    vi.mocked(getStore).mockReturnValue({
      ...store,
      manifest: {
        ...store.manifest,
        entrypoints: [{ id: PAGE, kind: 'app-route', pathname: PAGE }],
      },
    } as unknown as Store);

    const response = await ask({});

    expect(response.headers.get('link')).toBe(PRELOAD);
    expect(response.headers.get('content-type')).toBe('text/x-component');
    await expect(response.text()).resolves.toBe('<html>redirect</html>');
    expect(vi.mocked(invokeNodeHandler)).not.toHaveBeenCalled();
  });
});
