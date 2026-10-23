import { once } from 'node:events';
import { createServer } from 'node:http';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { CheckedStack } from '../src/answers.ts';
import { jarOf, NO_COOKIE_CHANGES } from '../src/cookie-jar.ts';
import { type Answered, redirectsFrom } from '../src/redirects.ts';

const SITE = new URL('https://site.example');
const REFERER = 'https://site.example/from?private=1';
const QUIET: Answered = { changes: NO_COOKIE_CHANGES, account: '', page: false };
const observed: { path: string; referer: string | undefined }[] = [];
const fixture = { origin: new URL('http://127.0.0.1') };

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', fixture.origin);
  observed.push({ path: `${url.pathname}${url.search}`, referer: request.headers.referer });
  if (url.pathname === '/middle') {
    response.writeHead(307, { location: '/finish', 'referrer-policy': 'unsafe-url' }).end();
    return;
  }
  response.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
});

async function following(policy: string, replay?: string) {
  // No router-state field is sent; this actual redirect transport reads only stack.url.
  const stack = { url: fixture.origin } as CheckedStack;
  return redirectsFrom(
    stack,
    {
      answered: { ...QUIET, location: '/middle', referrerPolicy: policy },
      url: new URL('/start?_rsc=original', SITE),
      headers: { referer: REFERER },
      jar: jarOf(undefined, { document: SITE }),
      replay,
    },
    new Map(),
  );
}

describe('referrer reductions across actual redirect requests', () => {
  beforeAll(async () => {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no redirect fixture');
    fixture.origin = new URL(`http://127.0.0.1:${address.port}`);
  });

  beforeEach(() => {
    observed.length = 0;
  });

  afterAll(async () => {
    server.close();
    await once(server, 'close');
  });

  it.each([
    { policy: 'no-referrer', referer: undefined },
    { policy: 'origin', referer: 'https://site.example/' },
    { policy: 'unsafe-url', referer: REFERER },
  ])('preserves $policy when a later hop allows unsafe-url', async (example) => {
    const result = await following(example.policy);

    expect(result.failure).toBeUndefined();
    expect(result.landed?.url.pathname).toBe('/finish');
    expect(observed).toStrictEqual([
      { path: '/middle', referer: example.referer },
      { path: '/finish', referer: example.referer },
    ]);
  });

  it('restores the page context only for a separate router replay', async () => {
    const result = await following('no-referrer', 'computed');

    expect(result.failure).toBeUndefined();
    expect(observed).toStrictEqual([
      { path: '/middle', referer: undefined },
      { path: '/finish', referer: undefined },
      { path: '/finish?_rsc=computed', referer: REFERER },
    ]);
  });
});
