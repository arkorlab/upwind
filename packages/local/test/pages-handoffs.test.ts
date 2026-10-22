import { once } from 'node:events';
import { createServer } from 'node:http';

import { buildProjectManifest, type RouteEntry } from '@stayingupwind/core/manifest';
import { NAVIGATION_REQUEST_HEADERS } from '@stayingupwind/core/request';
import { afterAll, assert, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { CheckedStack } from '../src/answers.ts';
import { documentAnswerAt } from '../src/document-adoption.ts';
import { routeVerdict } from '../src/documents.ts';
import { flowFailure, flowsOf, seedsOf } from '../src/part-flows.ts';
import type { Part } from '../src/part-marks.ts';
import { partFailure, propsHeadVerdict } from '../src/part-verdicts.ts';

const SITE = new URL('https://site.example');
const AT = '2026-10-21T00:00:00.000Z';
const SHA = 'a'.repeat(64);
const CLASS = '/posts/[slug]';
const MEMBER = '/posts/first';
const DATA = '/_next/data/build/posts/first.json';
const SHELL = {
  sha256: SHA,
  byteLength: 1,
  contentType: 'text/html',
  encoding: 'identity',
} as const;
const MEMBER_ROUTE: RouteEntry = {
  pathname: MEMBER,
  status: 200,
  shell: SHELL,
  headers: {},
  cache: { entryId: 'first-entry', kind: 'pages', delivery: 'complete' },
};
const FALLBACK_ROUTE: RouteEntry = { pathname: CLASS, status: 200, shell: SHELL, headers: {} };
const ORDINARY_ROUTE: RouteEntry = {
  pathname: '/ordinary',
  status: 200,
  shell: SHELL,
  headers: {},
};
const MANIFEST = buildProjectManifest({
  projectId: 'site',
  runId: 'run',
  generatedAt: AT,
  originHost: SITE.hostname,
  deployment: { assetSetHash: SHA, observedAt: AT, dplId: 'dpl_site' },
  app: { deploymentId: 'dpl_site', scriptName: 'app' },
  routes: [MEMBER_ROUTE, FALLBACK_ROUTE, ORDINARY_ROUTE],
  cache: { keySchemaVersion: 1, scopeId: 'dpl_site' },
  pagesDataUnder: { basePath: '', buildId: 'build' },
  staticPages: [
    {
      staticPagePrivacy: 3,
      pathname: MEMBER,
      route: CLASS,
      entryId: 'first-entry',
      dataPathname: DATA,
      parameters: { slug: 'first' },
    },
  ],
  pagesFallbacks: [
    {
      staticPagePrivacy: 3,
      route: CLASS,
      dataPathname: '/_next/data/build/posts/[slug].json',
      shell: { artifact: SHELL },
      headers: {},
    },
  ],
  dynamicRoutes: [{ sourceRegex: '^/posts/([^/]+?)(?:/)?$', route: CLASS }],
});

const fixture = {
  origin: new URL('http://127.0.0.1'),
  account: 'passthrough;reason=static-page',
  status: 200,
  quiet: true,
  closed: Promise.withResolvers<true>(),
  backstageGets: 0,
  requests: 0,
  /** A path the application's middleware redirects, and where to: none where both are empty. */
  redirect: { from: '', to: '' },
};

const server = createServer((request, response) => {
  const pathname = new URL(request.url ?? '/', fixture.origin).pathname;
  if (pathname.startsWith('/_backstage/')) {
    if (request.method === 'GET') {
      fixture.backstageGets += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ decision: null, regenerated: null, generations: {} }));
      return;
    }
    response.writeHead(204).end();
    return;
  }
  if (pathname === fixture.redirect.from) {
    response.writeHead(307, {
      location: fixture.redirect.to,
      'x-arkor-edge': 'passthrough;reason=middleware;mw=hit',
    });
    response.end();
    return;
  }
  fixture.requests += 1;
  const { closed } = fixture;
  response.once('close', () => {
    closed.resolve(true);
  });
  response.writeHead(fixture.status, {
    'content-type': pathname.startsWith('/_next/data/') ? 'application/json' : 'text/html',
    'x-arkor-edge': fixture.account,
  });
  if (fixture.quiet) response.flushHeaders();
  else response.end('{}');
});

/** All handoffs here are classified before middleware, so no broader running-stack fixture is needed. */
function stackOf(): CheckedStack {
  return {
    url: fixture.origin,
    site: SITE,
    backstage: new URL('/_backstage/', fixture.origin),
    manifest: MANIFEST,
    // No middleware: a redirect here is a stand-in's, which the flows read as the middleware's.
    bundle: { config: {} },
    cspNonce: undefined,
  } as CheckedStack;
}

function dataPart(): Part {
  return {
    kind: 'data',
    what: 'page props',
    url: new URL(DATA, SITE),
    headers: { 'x-nextjs-data': '1' },
    route: MEMBER_ROUTE,
    built: undefined,
    builtOn: (route) => route.pagesData?.artifact,
    exact: true,
  };
}

/** A router's request for `/ordinary`'s payload, which the middleware redirects onto a member. */
function payloadPart(): Part {
  return {
    kind: 'payload',
    what: 'its payload',
    url: new URL('/ordinary?_rsc=abc', SITE),
    headers: { rsc: '1' },
    route: ORDINARY_ROUTE,
    built: undefined,
    builtOn: (route) => route.pagesData?.artifact,
    exact: true,
  };
}

/** The flows a browser's router asks `part` in, from a page holding no cookies. */
async function flowed(part: Part): Promise<readonly (string | undefined)[]> {
  const answered = { judged: new Map(), followed: new Map() };
  const { seeds } = seedsOf({ page: new URL('/ordinary', SITE), sent: undefined });
  const failures: (string | undefined)[] = [];
  for (const flow of flowsOf(seeds)) {
    failures.push(await flowFailure(stackOf(), [part], flow, answered));
  }
  return failures;
}

describe('pages requests owned by the Function under the current shared classifier', () => {
  beforeAll(async () => {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no Pages fixture');
    fixture.origin = new URL(`http://127.0.0.1:${address.port}`);
  });

  beforeEach(() => {
    fixture.account = 'passthrough;reason=static-page';
    fixture.status = 200;
    fixture.quiet = true;
    fixture.closed = Promise.withResolvers<true>();
    fixture.backstageGets = 0;
    fixture.requests = 0;
    fixture.redirect = { from: '', to: '' };
  });

  afterAll(async () => {
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  });

  it.each([
    {
      requested: MEMBER,
      route: MEMBER_ROUTE,
      reason: 'static-page',
      headers: NAVIGATION_REQUEST_HEADERS,
    },
    {
      requested: '/posts/new',
      route: FALLBACK_ROUTE,
      reason: 'pages-fallback',
      headers: NAVIGATION_REQUEST_HEADERS,
    },
    {
      requested: MEMBER,
      route: MEMBER_ROUTE,
      reason: 'static-page-bypass',
      headers: { ...NAVIGATION_REQUEST_HEADERS, cookie: 'session=1' },
    },
  ])('accepts a valid $reason handoff without waiting for an application body', async (example) => {
    fixture.account = `passthrough;reason=${example.reason}`;
    const verdict = await routeVerdict(stackOf(), 64, {
      key: example.route.pathname,
      requested: example.requested,
      route: example.route,
      headers: example.headers,
    });
    await fixture.closed.promise;

    expect(verdict.kind).toBe('skipped');
    expect(fixture.backstageGets).toBe(0);
    expect(fixture.requests).toBe(1);
  });

  it('rejects a server failure even for a valid Pages handoff', async () => {
    fixture.status = 503;
    const verdict = await routeVerdict(stackOf(), 64, {
      key: MEMBER,
      requested: MEMBER,
      route: MEMBER_ROUTE,
      headers: NAVIGATION_REQUEST_HEADERS,
    });

    expect(verdict).toStrictEqual({ kind: 'failed', reason: 'answered 503' });
  });

  it.each([
    { requested: MEMBER, reason: 'static-page', status: 200, headers: NAVIGATION_REQUEST_HEADERS },
    {
      requested: '/posts/new',
      reason: 'pages-fallback',
      status: 200,
      headers: NAVIGATION_REQUEST_HEADERS,
    },
    {
      requested: MEMBER,
      reason: 'static-page-bypass',
      status: 200,
      headers: { ...NAVIGATION_REQUEST_HEADERS, cookie: 'session=1' },
    },
    { requested: MEMBER, reason: 'static-page', status: 503, headers: NAVIGATION_REQUEST_HEADERS },
  ])('retains the adopted $reason document verdict with status $status', async (example) => {
    fixture.account = `passthrough;reason=${example.reason}`;
    fixture.status = example.status;
    const answer = await documentAnswerAt(
      stackOf(),
      64,
      { url: new URL(example.requested, SITE), headers: example.headers },
      'gzip',
    );

    assert(
      typeof answer !== 'string' && answer.documentFailure !== undefined,
      'the adopted Pages response lost its own document verdict',
    );

    const failure = await answer.documentFailure();
    await fixture.closed.promise;

    expect(failure).toBe(example.status === 503 ? 'answered 503' : undefined);
    expect(fixture.requests).toBe(1);
    expect(fixture.backstageGets).toBe(0);
  });

  it('rejects a Pages handoff account on an ordinary document', async () => {
    fixture.quiet = false;
    const verdict = await routeVerdict(stackOf(), 64, {
      key: '/ordinary',
      requested: '/ordinary',
      route: ORDINARY_ROUTE,
      headers: NAVIGATION_REQUEST_HEADERS,
    });

    expect(verdict).toMatchObject({
      kind: 'failed',
      reason: expect.stringContaining('classification none') as unknown,
    });
  });

  it('rejects the wrong Pages handoff reason for an exact member', async () => {
    fixture.quiet = false;
    fixture.account = 'passthrough;reason=pages-fallback';
    const verdict = await routeVerdict(stackOf(), 64, {
      key: MEMBER,
      requested: MEMBER,
      route: MEMBER_ROUTE,
      headers: NAVIGATION_REQUEST_HEADERS,
    });

    expect(verdict).toMatchObject({
      kind: 'failed',
      reason: expect.stringContaining('classification static-page') as unknown,
    });
  });

  it('accepts paired props without treating the Function body as a build artifact', async () => {
    const failure = await partFailure(stackOf(), dataPart());

    expect(failure).toBeUndefined();
    expect(fixture.requests).toBeGreaterThan(0);
    expect(fixture.backstageGets).toBe(0);
  });

  // A redirect a router's fetch follows onto a Pages answer the Function owns is read for its
  // headers alone, as a direct request for it is: its body may stay open (greptile).
  it.each([
    {
      label: 'a known part',
      part: payloadPart,
      from: '/ordinary',
      to: MEMBER,
      account: 'passthrough;reason=static-page-bypass',
    },
    {
      label: 'a hop of no known part',
      part: () => ({ ...dataPart(), url: new URL('/_next/data/build/ordinary.json', SITE) }),
      from: '/_next/data/build/ordinary.json',
      to: DATA,
      account: 'passthrough;reason=static-page',
    },
  ])(
    'follows a redirect onto an open Pages answer through $label without waiting for its body',
    async (example) => {
      fixture.redirect = { from: example.from, to: example.to };
      fixture.account = example.account;
      const failures = await flowed(example.part());
      await fixture.closed.promise;

      expect(failures.every((failure) => failure === undefined)).toBe(true);
      expect(fixture.requests).toBeGreaterThan(0);
    },
    15_000,
  );

  it('still fails a server failure a redirect lands on, though the Function owns the answer', async () => {
    fixture.redirect = { from: '/ordinary', to: MEMBER };
    fixture.account = 'passthrough;reason=static-page-bypass';
    fixture.status = 503;
    fixture.quiet = false;
    const failures = await flowed(payloadPart());

    expect(failures[0]).toBe('its payload, redirected to /posts/first, answered 503');
  });

  it('uses the same Pages contract for a paired props HEAD', async () => {
    fixture.quiet = false;
    const result = await propsHeadVerdict(stackOf(), dataPart());

    expect(result.verdict.kind).toBe('skipped');
    expect(fixture.backstageGets).toBe(0);
  });
});
