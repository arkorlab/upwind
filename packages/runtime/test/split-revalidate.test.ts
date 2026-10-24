import type { Prerender } from '@stayingupwind/core/bundle';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { requestContextFor } from '../src/cache/context.ts';
import { platformRevalidate } from '../src/cache/revalidate.ts';
import type { CacheRuntime } from '../src/cache/runtime.ts';
import { getStore, type Store } from '../src/store.ts';

vi.mock(import('../src/store.ts'), async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, getStore: vi.fn() };
});

// Nothing here renders; the bridge is Cloudflare's alone.
vi.mock(import('../src/node-bridge.ts'), () => {
  return {
    invokeNodeHandler: () => {
      throw new Error('unexpected render');
    },
  };
});

/**
 * `res.revalidate()` of a Pages Router handler, in a build that split its routes across app
 * Functions, for an App Router page another Function holds: this Function can neither render the
 * page nor ask the one that holds it to, so the page is invalidated, as `revalidatePath`
 * invalidates one, and its own Function renders it for the next request.
 */

const PAGE = '/a';

function shell(): Prerender {
  return {
    id: PAGE,
    route: PAGE,
    pathname: PAGE,
    parentOutputId: PAGE,
    groupId: 1,
    body: { sha256: 'a'.repeat(64), byteLength: 1, contentType: 'text/html' },
  };
}

/** A deployment whose page `/a` is in `app-2`, as this Function — `app` — reads it. */
function deployment(): Store {
  const prerender = shell();
  return {
    manifest: {
      entrypoints: [{ id: PAGE, kind: 'app-page', pathname: PAGE, function: 'app-2' }],
      config: { basePath: '' },
    },
    pathnames: [PAGE],
    slashSpellings: new Map(),
    dynamicRoutes: [],
    staticFiles: new Map(),
    prerendersById: new Map([[PAGE, prerender]]),
    prerendersByPathname: new Map([[PAGE, prerender]]),
    shellsByRoute: new Map([[PAGE, { pages: new Map([[PAGE, prerender]]), patterns: [] }]]),
  } as unknown as Store;
}

/** A cache whose host records what it was asked to invalidate, and nothing else. */
function recordingCache(): { runtime: CacheRuntime; invalidated: string[][] } {
  const invalidated: string[][] = [];
  const runtime = {
    host: {
      invalidate: (input: { readonly tags: readonly string[] }) => {
        invalidated.push([...input.tags]);
        return Promise.resolve({ invalidations: [] });
      },
    },
    tags: {
      applyLocal: () => {
        // Nothing here reads a tag back.
      },
      answerLocal: () => {
        // Nor what the host answered of it.
      },
    },
  } as unknown as CacheRuntime;
  return { runtime, invalidated };
}

function revalidateIn(runtime: CacheRuntime, urlPath: string): Promise<void> {
  const context = requestContextFor({
    tables: { app: { entries: {} }, edge: { entries: {} } },
    runtime,
    request: new Request('https://split.example.test/api/revalidate'),
    startedAt: 0,
    waitUntil: () => {
      // Nothing is left behind the answer.
    },
    clock: undefined,
  });
  return context.run(() => platformRevalidate({ urlPath }));
}

describe('a page another app Function holds, revalidated', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('is invalidated under its own path, for its own Function to render next', async () => {
    vi.stubGlobal('__ARKOR_FUNCTION_NAME__', 'app');
    vi.mocked(getStore).mockReturnValue(deployment());
    const cache = recordingCache();

    await revalidateIn(cache.runtime, `${PAGE}?from=webhook`);

    expect(cache.invalidated).toStrictEqual([[`_N_T_${PAGE}`]]);
  });

  it('is refused where no Function holds it at all', async () => {
    vi.stubGlobal('__ARKOR_FUNCTION_NAME__', 'app-2');
    vi.mocked(getStore).mockReturnValue(deployment());
    const cache = recordingCache();

    await expect(revalidateIn(cache.runtime, PAGE)).rejects.toThrow(/no Node.js entrypoint/u);
    expect(cache.invalidated).toStrictEqual([]);
  });
});

describe('an edge-runtime route another app Function holds, revalidated', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('is refused, as one here is: it has no generation to invalidate', async () => {
    vi.stubGlobal('__ARKOR_FUNCTION_NAME__', 'app');
    const store = deployment();
    const edgeRoute = {
      id: PAGE,
      kind: 'app-page',
      pathname: PAGE,
      function: 'app-2',
      runtime: 'edge',
    };
    vi.mocked(getStore).mockReturnValue({
      ...store,
      manifest: { ...store.manifest, entrypoints: [edgeRoute] },
    } as Store);
    const cache = recordingCache();

    await expect(revalidateIn(cache.runtime, PAGE)).rejects.toThrow(/no Node.js entrypoint/u);
    expect(cache.invalidated).toStrictEqual([]);
  });
});
