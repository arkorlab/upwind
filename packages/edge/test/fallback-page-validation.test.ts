import type { ProjectManifest } from '@stayingupwind/core/manifest';
import { NAVIGATION_REQUEST_HEADERS } from '@stayingupwind/core/request';
import { waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { routeRequest } from '../src/route.ts';
import {
  FALLBACK_ROUTE,
  fallbackEdgeFixture,
  type FallbackEdgeFixture,
  LAZY_PATH,
} from './fallback-page-fixture.ts';

/** Enter through classification, with the host's verified candidate state rather than a handler. */
function ask(test: FallbackEdgeFixture, validated: boolean, manifest = test.manifest) {
  const request = new Request<unknown, IncomingRequestCfProperties>(
    `https://site.example${LAZY_PATH}`,
    { headers: { accept: 'text/html', ...NAVIGATION_REQUEST_HEADERS } },
  );
  return routeRequest({
    ...test.edge,
    request,
    url: new URL(request.url),
    state: {
      ...test.edge,
      validated,
      mode: 'edge',
      manifest,
      originHost: 'site.example',
      passthroughReason: 'validation',
    },
  });
}

describe('pages fallback candidate validation', () => {
  afterEach(() => vi.restoreAllMocks());

  it('proves only the build loading HTML without resuming or consulting generation authority', async () => {
    const test = await fallbackEdgeFixture();

    test.dispatch.mockRejectedValue(new Error('a loading shell must not resume'));

    const get = vi.spyOn(env.CACHE_STATE, 'get');
    const put = vi.spyOn(env.CACHE_STATE, 'put');
    const memoryGet = vi.spyOn(test.edge.runtime.memory.generations, 'get');
    const original = structuredClone(test.manifest);

    const response = await ask(test, true);
    const bytes = new Uint8Array(await response.arrayBuffer());
    await waitOnExecutionContext(test.edge.ctx);

    expect(bytes).toStrictEqual(test.native.loading);
    expect({
      status: response.status,
      validated: response.headers.get('x-arkor-edge-validated'),
      debug: response.headers.get('x-arkor-edge')?.split(';'),
    }).toMatchObject({
      status: 200,
      validated: '1',
      debug: expect.arrayContaining(['shell', 'cont=none', `route=${FALLBACK_ROUTE}`]) as unknown,
    });
    expect({
      memory: memoryGet.mock.calls,
      get: get.mock.calls,
      put: put.mock.calls,
      current: test.currentRecord.mock.calls,
      dispatch: test.dispatch.mock.calls,
    }).toStrictEqual({ memory: [], get: [], put: [], current: [], dispatch: [] });
    expect(test.manifest).toStrictEqual(original);
  });

  it('still returns loading HTML to a visitor while its concrete render is pending', async () => {
    const test = await fallbackEdgeFixture();
    const render = Promise.withResolvers<Response>();

    test.dispatch.mockReturnValueOnce(render.promise);

    try {
      const response = await ask(test, false);

      expect(new Uint8Array(await response.arrayBuffer())).toStrictEqual(test.native.loading);
      expect({
        validated: response.headers.get('x-arkor-edge-validated'),
        kind: response.headers.get('x-arkor-edge')?.split(';', 1)[0],
        dispatches: test.dispatch.mock.calls.length,
      }).toStrictEqual({ validated: null, kind: 'pages-fallback', dispatches: 1 });
      expect(test.dispatch.mock.calls[0]?.[1].headers.get('next-resume')).toBeNull();
    } finally {
      render.resolve(new Response(null));
      await waitOnExecutionContext(test.edge.ctx);
    }
  });

  it('continues to resume an ordinary signed class shell', async () => {
    const test = await fallbackEdgeFixture();
    const manifest: ProjectManifest = { ...test.manifest, pagesFallbacks: undefined };

    test.dispatch.mockResolvedValue(new Response('</body></html>'));

    const response = await ask(test, true, manifest);
    await response.text();
    await waitOnExecutionContext(test.edge.ctx);

    expect(response.headers.get('x-arkor-edge')?.split(';')).toContain('cont=resume');
    expect(test.dispatch).toHaveBeenCalledExactlyOnceWith(
      test.edge.app!.scriptName,
      expect.any(Request),
    );
    expect(test.dispatch.mock.calls[0]?.[1].headers.get('next-resume')).toBe('1');
  });
});
