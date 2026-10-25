import type { Prerender } from '@stayingupwind/core/bundle';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import type { AppModule, NodeHandler } from '../src/app-module.ts';
import { handleRequest } from '../src/handle.ts';
import { type InvokeInput, invokeNodeHandler } from '../src/node-bridge.ts';
import { getStore, type Store } from '../src/store.ts';

/**
 * A member of a blocking route of a Cache Components build, asked for where no cache keeps a
 * render. In minimal mode Next.js answers a render it postponed with the static part alone and
 * leaves the resume to the host; Next.js's deploy-mode run found such a page served cut off at
 * its static part (`cache-components-allow-otel-spans`). Rendered as a regeneration renders it, and
 * resumed for the visitor, it is whole.
 */

vi.mock(import('../src/store.ts'), async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, getStore: vi.fn() };
});

/** Next.js, as each test has it answer (`postponing`). */
function nodeBridge(): { invokeNodeHandler: Mock } {
  return { invokeNodeHandler: vi.fn() };
}

vi.mock(import('../src/node-bridge.ts'), nodeBridge);

const ITEMS = '/items/[id]';
const MEMBER = '/items/own';
const STATIC_PART = '<!DOCTYPE html><html><body><main>static part';
const RESUMED = '<p>dynamic part</p></main></body></html>';
const POSTPONED = 'the state the render postponed';
const page: NodeHandler = () => Promise.resolve();
const app: AppModule = { entries: { [ITEMS]: () => ({ handler: page }) } };

/** The route's class, of which the build prerendered nothing: a fallback with no body. */
const fallback: Prerender = {
  id: ITEMS,
  pathname: ITEMS,
  route: ITEMS,
  parentOutputId: ITEMS,
  groupId: 1,
  routeType: 'fallback',
  renderingMode: 'PARTIALLY_STATIC',
};

function deployment(): Store {
  const route = {
    sourceRegex: '^/items/(?<nxtPid>[^/]+?)(?:/)?$',
    destination: `${ITEMS}?nxtPid=$nxtPid`,
  };
  return {
    manifest: {
      buildId: 'build',
      config: { basePath: '', i18n: null, cacheComponents: true },
      routing: {
        beforeMiddleware: [],
        middlewareMatchers: [],
        beforeFiles: [],
        afterFiles: [],
        dynamicRoutes: [route],
        onMatch: [],
        fallback: [],
        shouldNormalizeNextData: false,
      },
      entrypoints: [{ id: ITEMS, kind: 'app-page', pathname: ITEMS }],
    },
    pathnames: [ITEMS],
    slashSpellings: new Map(),
    dynamicRoutes: [route],
    staticFiles: new Map(),
    shellsByRoute: new Map([
      [
        ITEMS,
        { pages: new Map(), patterns: [{ pattern: /^\/items\/[^/]+$/u, prerender: fallback }] },
      ],
    ]),
    prerendersById: new Map([[ITEMS, fallback]]),
    prerendersByPathname: new Map([[ITEMS, fallback]]),
    renderedPages: new Set(),
  } as unknown as Store;
}

/**
 * Next.js in minimal mode, for a page that postpones: a capture where one is asked for, its resume
 * where it is handed the state, and the static part alone where it is asked as it comes.
 */
async function postponing(input: InvokeInput): Promise<Response> {
  type CacheEntryCallback = (entry: unknown, meta: { url: string | undefined }) => unknown;

  const meta = input.requestMeta;
  const onCacheEntry = meta['onCacheEntry'] as CacheEntryCallback | undefined;
  if (onCacheEntry !== undefined) {
    const html = { toUnchunkedString: () => STATIC_PART };
    const value = { kind: 'APP_PAGE', html, postponed: POSTPONED, headers: {}, status: 200 };
    await onCacheEntry({ value, cacheControl: { revalidate: 60 } }, { url: input.url });
    return new Response(null);
  }
  if (meta['postponed'] === POSTPONED) {
    return new Response(RESUMED);
  }
  return new Response(STATIC_PART, { headers: { 'x-nextjs-postponed': '1' } });
}

function ask(): Promise<Response> {
  return handleRequest({
    app,
    edge: { entries: {} },
    request: new Request(`https://app.test${MEMBER}`),
    waitUntil: () => {
      // Nothing is kept: there is no cache.
    },
  });
}

describe('a blocking member asked for where no cache keeps a render', () => {
  beforeEach(() => {
    vi.stubGlobal('__ARKOR_FUNCTION_KIND__', 'app');
    vi.mocked(getStore).mockReturnValue(deployment());
    vi.mocked(invokeNodeHandler).mockReset().mockImplementation(postponing);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is answered whole: its static part, then its resume', async () => {
    const response = await ask();

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(`${STATIC_PART}${RESUMED}`);
  });

  it('is rendered once and resumed once', async () => {
    await (await ask()).text();

    expect(vi.mocked(invokeNodeHandler)).toHaveBeenCalledTimes(2);
  });
});
