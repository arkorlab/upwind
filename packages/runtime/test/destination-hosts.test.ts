import type { Route } from '@stayingupwind/core/bundle';
import { PLATFORM_HEADER_PREFIX } from '@stayingupwind/core/request';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleRequest } from '../src/handle.ts';
import { fetchRewrite } from '../src/rewrite-fetch.ts';
import { getStore, type Store } from '../src/store.ts';

/**
 * A rule of `next.config` that puts something of the request in the host it sends a request to,
 * with the router running for real: the host it names is the only one it sends the request to. A
 * value with what ends a host in it — `/`, `#`, `@` — is refused, rather than moving what the rule
 * wrote out of the host and sending the request elsewhere (GHSA-p9j2-gv94-2wf4). The rules are
 * written as `next build` hands them to an adapter: the path's parameters by place, a `has`
 * condition's by name.
 */

vi.mock(import('../src/store.ts'), async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, getStore: vi.fn() };
});
vi.mock(import('../src/node-bridge.ts'), () => ({ invokeNodeHandler: vi.fn() }));
vi.mock(import('../src/rewrite-fetch.ts'), () => {
  const upstream = vi.fn(() => Promise.resolve(new Response('upstream')));
  return { fetchRewrite: upstream };
});

const REGION = { type: 'query', key: 'region', value: '(?<region>.*)' } as const;
/** `{ source: '/api/:path*', has: [REGION], destination: 'https://:region.api.example.com/:path*' }` */
const REGIONAL: Route = {
  sourceRegex: '^/api(?:/((?:[^/]+?)(?:/(?:[^/]+?))*))?(?:/)?$',
  has: [REGION],
  destination: 'https://$region.api.example.com/$1',
};
/** `{ source: '/team/:team', destination: 'https://:team.api.example.com/' }` */
const TEAM: Route = {
  sourceRegex: '^/team/([^/]+?)(?:/)?$',
  destination: 'https://$1.api.example.com/',
};
/** `{ source: '/static/:path*', destination: 'https://static.example.com/:path*' }` */
const STATIC: Route = {
  sourceRegex: '^/static(?:/((?:[^/]+?)(?:/(?:[^/]+?))*))?(?:/)?$',
  destination: 'https://static.example.com/$1',
};
/** `{ source: '/go/:path*', has: [REGION], destination: 'https://:region.api.example.com/:path*', permanent: false }` */
const GO: Route = {
  sourceRegex: '^/go(?:/((?:[^/]+?)(?:/(?:[^/]+?))*))?(?:/)?$',
  has: [REGION],
  headers: { Location: 'https://$region.api.example.com/$1' },
  status: 307,
};

function deployment(): Store {
  return {
    manifest: {
      buildId: 'build',
      config: { basePath: '' },
      routing: {
        beforeMiddleware: [GO],
        middlewareMatchers: [],
        beforeFiles: [REGIONAL, TEAM, STATIC],
        afterFiles: [],
        dynamicRoutes: [],
        onMatch: [],
        fallback: [],
        shouldNormalizeNextData: false,
      },
      entrypoints: [],
    },
    pathnames: [],
    slashSpellings: new Map(),
    dynamicRoutes: [],
    staticFiles: new Map(),
    shellsByRoute: new Map(),
    prerendersById: new Map(),
    prerendersByPathname: new Map(),
    readBlob: () => new Uint8Array(),
  } as unknown as Store;
}

function handle(path: string): Promise<Response> {
  return handleRequest({
    app: { entries: {} },
    edge: { entries: {} },
    request: new Request(`https://app.test${path}`),
    waitUntil: () => {
      // Nothing is scheduled for these requests.
    },
  });
}

/** The URLs the runtime fetched a rewrite from. */
function fetched(): string[] {
  return vi.mocked(fetchRewrite).mock.calls.map(([target]) => target.href);
}

/** Whether an answer carries one of the marks routing is handed, which are never sent. */
function marked(response: Response): boolean {
  for (const name of response.headers.keys()) {
    if (name.startsWith(PLATFORM_HEADER_PREFIX)) {
      return true;
    }
  }
  return false;
}

describe('a rule that puts the request in the host it sends a request to', () => {
  beforeEach(() => {
    vi.stubGlobal('__ARKOR_FUNCTION_KIND__', 'app');
    vi.stubGlobal('__ARKOR_FUNCTION_NAME__', 'app');
    vi.mocked(getStore).mockReturnValue(deployment());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it.each([
    { value: 'eu', host: 'eu.api.example.com' },
    // A dot and a capital make what they make in Next.js, under the host the rule names.
    { value: 'eu.west', host: 'eu.west.api.example.com' },
    { value: 'EU', host: 'eu.api.example.com' },
  ])('rewrites to the host its value names, `region=$value`', async ({ value, host }) => {
    const response = await handle(`/api/users?region=${value}`);

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('upstream');
    expect(fetched()).toStrictEqual([`https://${host}/users`]);
    expect(marked(response)).toBe(false);
  });

  it.each([
    // Everything after the `/` is moved out of the host, which is then the value's own.
    'attacker.example%2F%23',
    'attacker.example%3F',
    'attacker.example%5C',
    // A user in front of a host of the value's choosing.
    'user%40attacker.example%23',
    // The host the rule names, with the path moved after it: the path the rule wrote is not there.
    'eu.api.example.com%2Fadmin%23',
  ])('refuses a value that moves the host, `region=%s`', async (value) => {
    const response = await handle(`/api/users?region=${value}`);

    expect(response.status).toBe(400);
    expect(fetched()).toStrictEqual([]);
    expect(marked(response)).toBe(false);
  });

  it('refuses a parameter of the path that puts a user in front of the host', async () => {
    const refused = await handle('/team/user@attacker.example');

    expect(refused.status).toBe(400);
    expect(fetched()).toStrictEqual([]);

    const kept = await handle('/team/acme');

    expect(kept.status).toBe(200);
    expect(fetched()).toStrictEqual(['https://acme.api.example.com/']);
  });

  it('leaves a rule whose host is written out to what it does with the path', async () => {
    const response = await handle('/static/a/b%2Fc');

    expect(response.status).toBe(200);
    expect(fetched()).toStrictEqual(['https://static.example.com/a/b%2Fc']);
    expect(marked(response)).toBe(false);
  });

  it('redirects to the host its value names, and refuses one that moves it', async () => {
    const kept = await handle('/go/users?region=eu');

    expect(kept.status).toBe(307);
    expect(kept.headers.get('location')).toBe('https://eu.api.example.com/users?region=eu');
    expect(marked(kept)).toBe(false);

    const refused = await handle('/go/users?region=attacker.example%2F%23');

    expect(refused.status).toBe(400);
    expect(refused.headers.get('location')).toBeNull();
    expect(marked(refused)).toBe(false);
  });
});
