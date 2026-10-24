import { createRequire } from 'node:module';

import { readMiddlewareResponse } from '@stayingupwind/core/paas';
import type { adapter as nextAdapter } from 'next/dist/server/web/adapter.js';
import type { NextResponse as ResponseFromNext } from 'next/dist/server/web/spec-extension/response.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

function installedNext() {
  // Next's actual Proxy adapter expects the same AsyncLocalStorage global as its Node server.
  const require = createRequire(import.meta.url);
  require('next/dist/server/node-environment-baseline.js');
  const { adapter } = require('next/dist/server/web/adapter.js') as {
    readonly adapter: typeof nextAdapter;
  };
  const { NextResponse } = require('next/dist/server/web/spec-extension/response.js') as {
    readonly NextResponse: typeof ResponseFromNext;
  };
  return { adapter, NextResponse };
}

/** What installed Next emits, before the edge decodes the same middleware response protocol. */
async function overridden(incoming: string | undefined, wanted: string) {
  const { adapter, NextResponse } = installedNext();
  vi.stubEnv('__NEXT_NO_MIDDLEWARE_URL_NORMALIZE', '');
  vi.stubGlobal('__BUILD_MANIFEST', undefined);
  let exposed: string | null | undefined;
  const result = await adapter({
    page: '/middleware',
    request: {
      url: 'https://site.example/',
      method: 'GET',
      headers: incoming === undefined ? {} : { rsc: incoming },
      signal: new AbortController().signal,
    },
    handler: (request) => {
      exposed = request.headers.get('rsc');
      const headers = new Headers(request.headers);
      headers.set('rsc', wanted);
      return Promise.resolve(NextResponse.next({ request: { headers } }));
    },
  });
  await result.waitUntil;
  const client = new Headers(incoming === undefined ? {} : { rsc: incoming });
  const decoded = readMiddlewareResponse(result.response, new URL('https://site.example/'), client);
  if (decoded.kind !== 'continue') throw new Error('the middleware did not continue');
  return { exposed, left: decoded.requestHeaders.get('rsc') };
}

describe('installed Next Flight request overrides', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('allows a navigation to add a Flight request upstream', async () => {
    await expect(overridden(undefined, '1')).resolves.toStrictEqual({ exposed: null, left: '1' });
  });

  it('restores original Flight after hiding it from Proxy and an attempted override', async () => {
    await expect(overridden('1', '0')).resolves.toStrictEqual({ exposed: null, left: '1' });
  });
});
