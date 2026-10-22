import { kvArtifactKey } from '@stayingupwind/core/artifact';
import type { ProjectManifest } from '@stayingupwind/core/manifest';
import { NAVIGATION_REQUEST_HEADERS } from '@stayingupwind/core/request';
import { blobObjectKey } from '@stayingupwind/host/storage';
import { waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { routeRequest } from '../src/route.ts';
import { BODY, PATH, staticPageFixture } from './static-page-fixture.ts';

function buildRoute(manifest: ProjectManifest) {
  const entry = manifest.routes[PATH];
  if (entry === undefined) throw new Error('The fixture needs a proved document route');
  return entry;
}

describe('static Pages candidate routing', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    { privacy: 1, initialRevalidate: false },
    { privacy: 2, initialRevalidate: 2 },
  ] as const)(
    'proves the version $privacy build shell without consulting or changing its current generation',
    async ({ privacy, initialRevalidate }) => {
      const test = await staticPageFixture({
        privacy,
        initialRevalidate,
        validated: true,
      });
      const entry = buildRoute(test.manifest);
      await env.EDGE_STATE.put(kvArtifactKey(entry.shell.sha256), BODY);
      await env.ARTIFACTS.put(blobObjectKey(entry.shell.sha256), BODY);
      const get = vi.spyOn(env.CACHE_STATE, 'get');
      const put = vi.spyOn(env.CACHE_STATE, 'put');
      const memoryGet = vi.spyOn(test.edge.runtime.memory.generations, 'get');
      const original = structuredClone(test.manifest);
      const request = new Request<unknown, IncomingRequestCfProperties>(
        `https://site.example${PATH}`,
        { headers: { accept: 'text/html', ...NAVIGATION_REQUEST_HEADERS } },
      );
      const response = await routeRequest({
        ...test.edge,
        request,
        url: new URL(request.url),
        state: {
          ...test.edge,
          mode: 'edge',
          manifest: test.manifest,
          originHost: 'site.example',
          passthroughReason: 'validation',
        },
      });
      const bytes = new Uint8Array(await response.arrayBuffer());
      await waitOnExecutionContext(test.edge.ctx);

      expect(bytes).toStrictEqual(BODY);
      expect({
        status: response.status,
        debug: response.headers.get('x-arkor-edge'),
        validated: response.headers.get('x-arkor-edge-validated'),
        cacheControl: response.headers.get('cache-control'),
      }).toStrictEqual({
        status: 200,
        debug: expect.stringMatching(/^shell;/u) as unknown,
        validated: '1',
        cacheControl: 'private, no-cache, no-transform',
      });
      expect({
        memory: memoryGet.mock.calls,
        get: get.mock.calls,
        put: put.mock.calls,
        dispatch: test.dispatch.mock.calls,
      }).toStrictEqual({ memory: [], get: [], put: [], dispatch: [] });
      expect(test.manifest).toStrictEqual(original);
    },
  );
});
