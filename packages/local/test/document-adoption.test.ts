import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { brotliCompressSync, gzipSync } from 'node:zlib';

import { deriveEntry, KEY_SCHEMA_VERSION } from '@stayingupwind/core/cache';
import { buildProjectManifest, type RouteEntry } from '@stayingupwind/core/manifest';
import { NO_STORE_CACHE_CONTROL } from '@stayingupwind/core/request';
import { DEFAULT_DELIVERY_POLICY } from '@stayingupwind/host/delivery';
import { afterAll, assert, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { CheckedStack } from '../src/answers.ts';
import { BROWSER_CODINGS } from '../src/codings.ts';
import { documentAnswerAt } from '../src/document-adoption.ts';
import { readDocument } from '../src/document-reading.ts';
import { read } from '../src/reading.ts';
import { documentRedirects } from '../src/redirects.ts';
import { routeFollowUpFailure } from '../src/route-follow-ups.ts';

const AT = '2026-10-19T00:00:00.000Z';
const HTML = 'text/html; charset=utf-8';
const DOCUMENT = '<!doctype html><html><head></head><body>landing</body></html>';
const DIGEST = createHash('sha256').update(DOCUMENT).digest('hex');
const BOT_ACCOUNT = 'passthrough;reason=html-limited-bots';
const BOT_SHELL_FAILURE = `not answered by the edge from its shell (x-arkor-edge: ${BOT_ACCOUNT})`;
const HEADERS = { 'accept-encoding': 'gzip', referer: 'https://site.example/start' };

const fixture = {
  origin: new URL('http://127.0.0.1'),
  bundleDir: '',
  stack: undefined as CheckedStack | undefined,
  status: 200,
  bot: false,
  override: undefined as 'br' | 'gzip' | undefined,
  target: '/landing',
  unknownOpen: false,
  middleClosed: Promise.withResolvers<true>(),
  terminalClosed: Promise.withResolvers<true>(),
};
const visits: { readonly path: string; readonly headers: IncomingMessage['headers'] }[] = [];
const traces: string[] = [];

function codingOf(request: IncomingMessage): 'br' | 'gzip' | undefined {
  if (fixture.override !== undefined) return fixture.override;
  const accepted = request.headers['accept-encoding'];
  if (accepted === 'identity') return undefined;
  return accepted?.includes('br') === true ? 'br' : 'gzip';
}

function landing(request: IncomingMessage, response: ServerResponse): void {
  const coding = codingOf(request);
  let body: Buffer = Buffer.from(DOCUMENT);
  if (coding === 'br') body = brotliCompressSync(body);
  else if (coding === 'gzip') body = gzipSync(body);
  const rendering = coding === undefined ? 'identity' : `${coding}-live`;
  response.writeHead(fixture.status, {
    'content-type': HTML,
    'cache-control': NO_STORE_CACHE_CONTROL,
    vary: 'accept-encoding',
    // A Location on a non-redirect status must not discard this body's evidence.
    location: '/not-a-redirect',
    'x-arkor-edge': fixture.bot
      ? BOT_ACCOUNT
      : `shell;cont=none;policy=default;enc=${rendering};route=/landing`,
    ...(coding !== undefined && { 'content-encoding': coding }),
  });
  response.end(body);
}

function backstage(request: IncomingMessage, response: ServerResponse): void {
  traces.push(request.method ?? '');
  if (request.method === 'GET') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ decision: null, regenerated: null, generations: {} }));
    return;
  }
  response.writeHead(204).end();
}

const server = createServer((request, response) => {
  const pathname = request.url ?? '';
  if (pathname.startsWith('/_backstage/')) {
    backstage(request, response);
    return;
  }
  visits.push({ path: pathname, headers: request.headers });
  if (pathname === '/start') {
    response.writeHead(307, { location: '/middle' }).end();
    return;
  }
  if (pathname === '/middle') {
    response.writeHead(302, {
      location: fixture.target,
      'content-encoding': 'gzip',
      'set-cookie': 'hop=kept; Path=/',
      'referrer-policy': 'no-referrer',
    });
    response.on('close', () => {
      fixture.middleClosed.resolve(true);
    });
    // No body bytes or EOF: following Location must not wait for the response's body deadline.
    response.flushHeaders();
    return;
  }
  if (fixture.unknownOpen && pathname === '/unrecorded') {
    response.writeHead(200, {
      'content-type': HTML,
      'content-encoding': 'gzip',
      'x-arkor-edge': 'passthrough;reason=not-recorded',
    });
    response.on('close', () => {
      fixture.terminalClosed.resolve(true);
    });
    response.flushHeaders();
    return;
  }
  landing(request, response);
});

async function stackAt(origin: URL, bundleDir: string): Promise<CheckedStack> {
  const site = new URL('https://site.example');
  const { entryId } = await deriveEntry('dpl_site', {
    kind: 'app-page',
    route: '/landing',
    pathname: '/landing',
  });
  const route: RouteEntry = {
    pathname: '/landing',
    status: 200,
    headers: { 'content-type': HTML },
    shell: {
      sha256: DIGEST,
      byteLength: Buffer.byteLength(DOCUMENT),
      contentType: HTML,
      encoding: 'identity',
    },
    cache: { entryId, kind: 'app-page', delivery: 'complete' },
  };
  const manifest = buildProjectManifest({
    projectId: 'site',
    runId: 'run',
    generatedAt: AT,
    originHost: site.hostname,
    deployment: { assetSetHash: DIGEST, observedAt: AT },
    app: { deploymentId: 'dpl_site', scriptName: 'app' },
    routes: [route],
    staticFiles: {},
    cache: { keySchemaVersion: KEY_SCHEMA_VERSION, scopeId: 'dpl_site' },
  });
  return {
    url: origin,
    site,
    backstage: new URL('/_backstage/', origin),
    functions: [],
    bundleDir,
    deploymentId: 'dpl_site',
    manifest,
    app: manifest.app,
    policy: { ...DEFAULT_DELIVERY_POLICY, id: 'default' },
    cspNonce: undefined,
    dispose: () => Promise.resolve(),
    bundle: {
      v: 1,
      deploymentId: 'dpl_site',
      nextVersion: '16.4.2',
      buildId: 'build',
      projectDir: '.',
      generatedAt: AT,
      config: {
        basePath: '',
        trailingSlash: false,
        skipTrailingSlashRedirect: true,
        poweredByHeader: false,
      },
      routing: {
        beforeMiddleware: [],
        middlewareMatchers: [],
        beforeFiles: [],
        afterFiles: [],
        dynamicRoutes: [],
        onMatch: [],
        fallback: [],
        shouldNormalizeNextData: false,
        rsc: {
          header: 'rsc',
          varyHeader: 'rsc',
          prefetchHeader: 'next-router-prefetch',
          didPostponeHeader: 'x-nextjs-postponed',
          contentTypeHeader: 'text/x-component',
          suffix: '.rsc',
          prefetchSegmentHeader: 'next-router-segment-prefetch',
          prefetchSegmentSuffix: '.segment.rsc',
          prefetchSegmentDirSuffix: '.segments',
        },
      },
      entrypoints: [],
      prerenders: [],
      staticFiles: [],
      middleware: { matchers: [] },
      functions: {
        app: {
          mainModule: 'index.mjs',
          modules: [],
          compatibilityDate: AT.slice(0, 10),
          compatibilityFlags: [],
        },
      },
    },
  };
}

function stack(): CheckedStack {
  if (fixture.stack === undefined) throw new Error('the HTTP fixture has not started');
  return fixture.stack;
}

function metadataStack(): CheckedStack {
  const original = stack();
  const route = original.manifest.routes['/landing'];
  assert(route?.cache !== undefined, 'the landing has a cache delivery policy');
  const landing = { ...route, cache: { ...route.cache, delivery: 'resume' as const } };
  return {
    ...original,
    manifest: {
      ...original.manifest,
      htmlLimitedBots: '.*',
      routes: {
        ...original.manifest.routes,
        '/landing': landing,
        '/start': { ...landing, pathname: '/start' },
      },
    },
  };
}

describe('redirected documents retain their original request and response', () => {
  beforeAll(async () => {
    fixture.bundleDir = mkdtempSync(path.join(tmpdir(), 'upwind-document-adoption-'));
    mkdirSync(path.join(fixture.bundleDir, 'blobs'));
    writeFileSync(path.join(fixture.bundleDir, 'blobs', DIGEST), DOCUMENT);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no fixture socket');
    fixture.origin = new URL(`http://127.0.0.1:${String(address.port)}`);
    fixture.stack = await stackAt(fixture.origin, fixture.bundleDir);
  });

  beforeEach(() => {
    fixture.status = 200;
    fixture.bot = false;
    fixture.override = undefined;
    fixture.target = '/landing';
    fixture.unknownOpen = false;
    fixture.middleClosed = Promise.withResolvers<true>();
    fixture.terminalClosed = Promise.withResolvers<true>();
    visits.length = 0;
    traces.length = 0;
  });

  afterAll(async () => {
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
    rmSync(fixture.bundleDir, { recursive: true, force: true });
  });

  it.each(['gzip', 'br', BROWSER_CODINGS] as const)(
    'judges the actual landing coding %s instead of deriving it from the agent',
    async (coding) => {
      const own = stack();
      const answered = await documentAnswerAt(
        own,
        Buffer.byteLength(DOCUMENT),
        {
          url: new URL('/landing', own.site),
          headers: { 'accept-encoding': coding, 'user-agent': 'Chrome/' },
        },
        coding,
      );
      assert(typeof answered !== 'string', 'the redirected document was not read');

      await expect(answered.documentFailure?.()).resolves.toBeUndefined();
      expect(answered.whole?.sha256).toBe(DIGEST);
      expect(visits.map(({ headers }) => headers['accept-encoding'])).toStrictEqual([coding]);
      expect(traces).toStrictEqual(['PUT', 'GET', 'DELETE']);
    },
  );

  it('still rejects a Brotli response to the gzip-only request', async () => {
    fixture.override = 'br';
    const own = stack();
    const answered = await documentAnswerAt(
      own,
      Buffer.byteLength(DOCUMENT),
      { url: new URL('/landing', own.site), headers: HEADERS },
      'gzip',
    );
    assert(typeof answered !== 'string', 'the redirected document was not read');

    await expect(answered.documentFailure?.()).resolves.toContain('not the gzip');
    expect(visits).toHaveLength(1);
  });

  it.each([
    { status: 200, nextStatus: 500, expected: undefined },
    { status: 500, nextStatus: 200, expected: 'answered 500' },
  ])('skips an open intermediate body and retains the final $status verdict', async (row) => {
    fixture.status = row.status;
    const own = stack();
    const first = await read(new URL('/start', own.site), {
      via: own.url,
      headers: HEADERS,
      headersOnly: true,
      deadlineMs: 1000,
    });
    const followed = await documentRedirects(own, {
      answer: first,
      url: new URL('/start', own.site),
      headers: HEADERS,
      jar: [],
      documentAnswer: (sent) => documentAnswerAt(own, Buffer.byteLength(DOCUMENT), sent, 'gzip'),
    });
    await fixture.middleClosed.promise;
    // A later request would have a different status. The retained verdict uses neither a refetch
    // nor a trace that has already been deleted.
    fixture.status = row.nextStatus;

    expect(followed.failure).toBeUndefined();
    await expect(followed.last?.documentFailure?.()).resolves.toBe(row.expected);
    expect(visits.map(({ path: pathname }) => pathname)).toStrictEqual([
      '/start',
      '/middle',
      '/landing',
    ]);
    expect(visits.at(-1)?.headers).toMatchObject({ cookie: 'hop=kept' });
    expect(visits.at(-1)?.headers.referer).toBeUndefined();
    expect(traces).toStrictEqual(['PUT', 'DELETE', 'PUT', 'GET', 'DELETE']);
  });

  it.each([
    { delivery: 'resume', agent: 'Chrome/', failure: undefined },
    { delivery: 'complete', agent: 'Chrome/', failure: BOT_SHELL_FAILURE },
    { delivery: 'resume', agent: 'Firefox/', failure: BOT_SHELL_FAILURE },
  ] as const)(
    'uses the original $agent metadata policy for a redirected $delivery page',
    async ({ delivery, agent, failure }) => {
      fixture.bot = true;
      const original = stack();
      const route = original.manifest.routes['/landing'];
      assert(route?.cache !== undefined, 'the landing has a cache delivery policy');
      const own = {
        ...original,
        manifest: {
          ...original.manifest,
          htmlLimitedBots: 'Chrome',
          routes: {
            ...original.manifest.routes,
            '/landing': { ...route, cache: { ...route.cache, delivery } },
          },
        },
      };
      const headers = { ...HEADERS, 'user-agent': agent };
      const first = await read(new URL('/start', own.site), {
        via: own.url,
        headers,
        headersOnly: true,
        deadlineMs: 1000,
      });
      const followed = await documentRedirects(own, {
        answer: first,
        url: new URL('/start', own.site),
        headers,
        jar: [],
        documentAnswer: (sent) => documentAnswerAt(own, Buffer.byteLength(DOCUMENT), sent, 'gzip'),
      });
      await fixture.middleClosed.promise;
      const judge = followed.last?.documentFailure;
      assert(judge !== undefined, 'the adopted landing retains its intentional document verdict');

      expect(followed.failure).toBeUndefined();
      await expect(judge()).resolves.toBe(failure);
      expect(followed.last?.whole?.sha256).toBe(DIGEST);
      expect(visits.at(-1)?.headers['user-agent']).toBe(agent);
      expect(traces).toStrictEqual(['PUT', 'DELETE', 'PUT', 'GET', 'DELETE']);
    },
  );

  it('keeps an intentionally unjudged metadata landing through the actual follow-up verdict', async () => {
    fixture.bot = true;
    const own = metadataStack();
    const route = own.manifest.routes['/start'];
    assert(route !== undefined, 'the starting route is recorded');
    const failure = await routeFollowUpFailure(own, Buffer.byteLength(DOCUMENT), {
      key: '/start',
      route,
      requested: '/start',
      headers: { ...HEADERS, 'user-agent': 'Chrome/' },
      exact: true,
    });

    expect(failure).toBeUndefined();
    expect(visits.some(({ path: pathname }) => pathname === '/landing')).toBe(true);
    expect(traces.includes('GET')).toBe(true);
  });

  it('closes an unrecorded streaming landing at its headers through actual follow-ups', async () => {
    fixture.target = '/unrecorded';
    fixture.unknownOpen = true;
    const own = metadataStack();
    const route = own.manifest.routes['/start'];
    assert(route !== undefined, 'the starting route is recorded');
    const failure = await routeFollowUpFailure(own, Buffer.byteLength(DOCUMENT), {
      key: '/start',
      route,
      requested: '/start',
      headers: { ...HEADERS, 'user-agent': 'Chrome/' },
      exact: true,
    });
    await fixture.terminalClosed.promise;

    expect(failure).toBeUndefined();
    expect(visits.some(({ path: pathname }) => pathname === '/unrecorded')).toBe(true);
    expect(traces.includes('GET')).toBe(false);
  });

  it.each([
    { status: 200, failure: undefined },
    { status: 500, failure: 'answered 500' },
  ])('still reads a $status landing identified only by its response account', async (row) => {
    fixture.status = row.status;
    const own = stack();
    const answered = await documentAnswerAt(
      own,
      Buffer.byteLength(DOCUMENT),
      { url: new URL('/unrecorded', own.site), headers: HEADERS },
      'gzip',
    );
    assert(typeof answered !== 'string', 'the account-scoped document was read');
    const judge = answered.documentFailure;
    assert(judge !== undefined, 'the known account retains a mandatory document verdict');

    await expect(judge()).resolves.toBe(row.failure);
    expect(answered.whole?.sha256).toBe(DIGEST);
    expect(traces).toStrictEqual(['PUT', 'GET', 'DELETE']);
  });

  it('keeps ordinary identity document reading whole despite a non-redirect Location', async () => {
    const own = stack();
    const headers = { 'accept-encoding': 'identity' };
    const answer = await readDocument(
      own,
      Buffer.byteLength(DOCUMENT),
      { requested: '/landing', headers },
      headers,
    );
    assert(typeof answer !== 'string', 'the identity document was not read');

    expect(answer.truncated).toBe(false);
    expect(answer.head.toString()).toBe(DOCUMENT);
    expect(answer.sha256).toBe(DIGEST);
    expect(traces).toStrictEqual([]);
  });
});
