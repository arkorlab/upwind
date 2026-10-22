import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';

import { buildProjectManifest, type RouteEntry } from '@stayingupwind/core/manifest';
import { NAVIGATION_REQUEST_HEADERS } from '@stayingupwind/core/request';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { CheckedStack } from '../src/answers.ts';
import { routeVerdict } from '../src/documents.ts';

/**
 * The edge serves a static page, and a fallback route's loading shell, itself: from the record the
 * runtime cache keeps of the page (`static-page;src=…`) and from the build's loading shell
 * (`pages-fallback;src=…`), shared under the edge's own revalidation. The check holds each to the
 * bytes it stands for and to what makes it shareable, as it holds a handoff to the Function's.
 */

const SITE = new URL('https://site.example');
const AT = '2026-10-23T00:00:00.000Z';
const HTML = 'text/html; charset=utf-8';
const REVALIDATE = 'public, max-age=0, must-revalidate';
const ABOUT = '<!doctype html><html><body>about</body></html>';
const FIRST = '<!doctype html><html><body>first</body></html>';
const LOADING = '<!doctype html><html><body>loading</body></html>';
const CLASS = '/posts/[slug]';
const MEMBER = '/posts/first';
const DATA = '/_next/data/build/posts/first.json';

function shellOf(text: string) {
  return {
    sha256: createHash('sha256').update(text).digest('hex'),
    byteLength: Buffer.byteLength(text),
    contentType: 'text/html',
    encoding: 'identity',
  } as const;
}

const ABOUT_ROUTE: RouteEntry = {
  pathname: '/about',
  status: 200,
  shell: shellOf(ABOUT),
  headers: {},
  cache: { entryId: 'about-entry', kind: 'pages', delivery: 'complete' },
};
const MEMBER_ROUTE: RouteEntry = {
  pathname: MEMBER,
  status: 200,
  shell: shellOf(FIRST),
  headers: {},
  cache: { entryId: 'first-entry', kind: 'pages', delivery: 'complete' },
};
const FALLBACK_ROUTE: RouteEntry = {
  pathname: CLASS,
  status: 200,
  shell: shellOf(LOADING),
  headers: {},
};
const MANIFEST = buildProjectManifest({
  projectId: 'site',
  runId: 'run',
  generatedAt: AT,
  originHost: SITE.hostname,
  deployment: { assetSetHash: 'a'.repeat(64), observedAt: AT, dplId: 'dpl_site' },
  app: { deploymentId: 'dpl_site', scriptName: 'app' },
  routes: [ABOUT_ROUTE, MEMBER_ROUTE, FALLBACK_ROUTE],
  cache: { keySchemaVersion: 1, scopeId: 'dpl_site' },
  pagesDataUnder: { basePath: '', buildId: 'build' },
  staticPages: [
    { pathname: '/about', route: '/about', entryId: 'about-entry' },
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
      shell: { artifact: shellOf(LOADING) },
      headers: {},
    },
  ],
  dynamicRoutes: [{ sourceRegex: '^/posts/([^/]+?)(?:/)?$', route: CLASS }],
});

/** What the stand-in edge answers each path with. */
const fixture = {
  origin: new URL('http://127.0.0.1'),
  answers: new Map<string, { account: string; body: string; headers?: Record<string, string> }>(),
};

const server = createServer((request, response) => {
  const pathname = new URL(request.url ?? '/', fixture.origin).pathname;
  if (pathname.startsWith('/_backstage/')) {
    if (request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ decision: null, regenerated: null, generations: {} }));
      return;
    }
    response.writeHead(204).end();
    return;
  }
  const answer = fixture.answers.get(pathname);
  if (answer === undefined) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, {
    'content-type': HTML,
    'cache-control': REVALIDATE,
    'x-arkor-edge': answer.account,
    ...answer.headers,
  });
  response.end(request.method === 'HEAD' ? undefined : answer.body);
});

function stackOf(): CheckedStack {
  return {
    url: fixture.origin,
    site: SITE,
    backstage: new URL('/_backstage/', fixture.origin),
    manifest: MANIFEST,
    bundle: { config: {} },
    cspNonce: undefined,
  } as CheckedStack;
}

function verdictAt(requested: string, route: RouteEntry) {
  return routeVerdict(stackOf(), 64, {
    key: route.pathname,
    requested,
    route,
    headers: NAVIGATION_REQUEST_HEADERS,
  });
}

describe('pages the edge serves itself', () => {
  beforeAll(async () => {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no Pages fixture');
    fixture.origin = new URL(`http://127.0.0.1:${address.port}`);
  });

  beforeEach(() => {
    fixture.answers.clear();
  });

  afterAll(async () => {
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  });

  it.each([
    {
      requested: '/about',
      route: ABOUT_ROUTE,
      body: ABOUT,
      account: 'static-page;src=kv;m=12345678',
    },
    {
      requested: MEMBER,
      route: MEMBER_ROUTE,
      body: FIRST,
      account: 'static-page;src=memory;m=12345678',
    },
    {
      requested: '/posts/new',
      route: FALLBACK_ROUTE,
      body: LOADING,
      account: 'pages-fallback;src=r2;m=12345678',
    },
  ])('accepts the edge serving $requested itself ($account)', async (example) => {
    fixture.answers.set(example.requested, { account: example.account, body: example.body });

    const verdict = await verdictAt(example.requested, example.route);

    expect(verdict).toStrictEqual({ kind: 'ok' });
  });

  it.each([
    {
      label: 'bytes other than the page record',
      requested: '/about',
      route: ABOUT_ROUTE,
      answer: { account: 'static-page;src=kv;m=12345678', body: FIRST },
      reason: 'not the bytes',
    },
    {
      label: 'a cookie set on a shared page',
      requested: '/about',
      route: ABOUT_ROUTE,
      answer: {
        account: 'static-page;src=kv;m=12345678',
        body: ABOUT,
        headers: { 'set-cookie': 'session=1' },
      },
      reason: 'set-cookie',
    },
    {
      label: 'a shared page held private',
      requested: '/about',
      route: ABOUT_ROUTE,
      answer: {
        account: 'static-page;src=kv;m=12345678',
        body: ABOUT,
        headers: { 'cache-control': 'private, no-store' },
      },
      reason: 'cache-control',
    },
    {
      label: 'a loading shell other than the build wrote',
      requested: '/posts/new',
      route: FALLBACK_ROUTE,
      answer: { account: 'pages-fallback;src=r2;m=12345678', body: ABOUT },
      reason: 'not the bytes',
    },
    {
      label: 'another class than the request is',
      requested: '/about',
      route: ABOUT_ROUTE,
      answer: { account: 'pages-fallback;src=r2;m=12345678', body: ABOUT },
      reason: 'classification static-page',
    },
  ])('rejects $label', async (example) => {
    fixture.answers.set(example.requested, example.answer);

    const verdict = await verdictAt(example.requested, example.route);

    expect(verdict).toMatchObject({
      kind: 'failed',
      reason: expect.stringContaining(example.reason) as unknown,
    });
  });
});
