import { HEADER_RULES_LEFT_HEADER } from '@stayingupwind/core/paas';
import { PLATFORM_HEADER_PREFIX } from '@stayingupwind/core/request';
import { describe, expect, it, vi } from 'vitest';

import { handlePassthrough, type PassthroughInput } from '../src/handlers/passthrough.ts';
import { fetchUpstream } from '../src/handlers/upstream.ts';

vi.mock(import('../src/handlers/upstream.ts'), async (original) => {
  return {
    ...(await original()),
    fetchUpstream: vi.fn(),
  };
});
const MARKER = `${PLATFORM_HEADER_PREFIX}publication-policy`;

async function scenario(layer: 'middleware' | 'rules') {
  const source = new Response('protected', {
    headers: {
      'cache-control': 'private, no-store, no-transform',
      [MARKER]: 'no-store;no-transform',
      ...(layer === 'rules' && { [HEADER_RULES_LEFT_HEADER]: '1' }),
    },
  });
  vi.mocked(fetchUpstream).mockResolvedValueOnce(source);
  const mutable = {
    'cache-control': 'public,max-age=3600',
    'cdn-cache-control': 'public,max-age=3600',
  };
  const request = new Request('https://site.test/items');
  const input: PassthroughInput = {
    request,
    forwarding: { previewDomain: 'test', previewHost: 'site.test', clientIp: undefined },
    runtime: { now: () => 100 } as PassthroughInput['runtime'],
    host: { credentials: { headers: [], cookies: [] } } as unknown as PassthroughInput['host'],
    app: undefined,
    reason: 'publication',
    middleware: {
      kind: 'continue',
      url: new URL(request.url),
      requestHeaders: new Headers(),
      responseHeaders: new Headers(layer === 'middleware' ? mutable : {}),
      judgedRules: { headers: layer === 'rules' ? mutable : {}, conditioned: false },
    },
  };
  return handlePassthrough(input);
}

describe('publication policy after final edge header merging', () => {
  it.each(['middleware', 'rules'] as const)(
    'cannot widen a trusted Function restriction through %s',
    async (layer) => {
      const response = await scenario(layer);

      expect(response.headers.get('cache-control')).toBe('private, no-store, no-transform');
      expect(response.headers.has('cdn-cache-control')).toBe(false);
      expect(response.headers.has(MARKER)).toBe(false);
    },
  );
});
