import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import {
  createServer,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { brotliCompressSync, gzipSync } from 'node:zlib';

import { deriveEntry, KEY_SCHEMA_VERSION } from '@stayingupwind/core/cache';
import {
  buildProjectManifest,
  type RouteEntry,
  type StaticFileEntry,
} from '@stayingupwind/core/manifest';
import { NO_STORE_CACHE_CONTROL } from '@stayingupwind/core/request';
import { DEFAULT_DELIVERY_POLICY } from '@stayingupwind/host/delivery';
import { afterAll, assert, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { CheckedStack } from '../src/answers.ts';
import { askedAgain } from '../src/asked-again.ts';
import { BROWSER_CODINGS } from '../src/codings.ts';
import { documentAnswerAt } from '../src/document-adoption.ts';
import { readDocument } from '../src/document-reading.ts';
import { routeVerdict } from '../src/documents.ts';
import { fileVerdict } from '../src/files.ts';
import type { Part } from '../src/part-marks.ts';
import { partFailure } from '../src/part-verdicts.ts';
import { read, type Reading } from '../src/reading.ts';
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
const direct = {
  headers: undefined as OutgoingHttpHeaders | undefined,
  prefix: '',
  opened: Promise.withResolvers<ServerResponse>(),
  closed: Promise.withResolvers<true>(),
  responses: [] as ServerResponse[],
  closures: [] as Promise<true>[],
};

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

/** A direct response whose headers arrive now and whose body only the test may finish. */
function directResponse(request: IncomingMessage, response: ServerResponse): boolean {
  if (request.url !== '/landing' || direct.headers === undefined) return false;
  const closed = Promise.withResolvers<true>();
  direct.responses.push(response);
  direct.closures.push(closed.promise);
  response.writeHead(200, direct.headers);
  response.once('close', () => {
    direct.closed.resolve(true);
    closed.resolve(true);
  });
  response.flushHeaders();
  if (direct.prefix !== '') response.write(direct.prefix);
  direct.opened.resolve(response);
  return true;
}

const server = createServer((request, response) => {
  const pathname = request.url ?? '';
  if (pathname.startsWith('/_backstage/')) {
    backstage(request, response);
    return;
  }
  visits.push({ path: pathname, headers: request.headers });
  if (directResponse(request, response)) return;
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
  if (pathname === '/unrecorded' && fixture.unknownOpen) {
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

const SIBLING_FILE: StaticFileEntry = {
  sha256: DIGEST,
  byteLength: Buffer.byteLength(DOCUMENT),
  contentType: HTML,
  immutable: false,
};
const SIBLING_ACCOUNT = 'passthrough;reason=external-rewrite;mw=hit';
const CHANGED_BODY = DOCUMENT.replaceAll('landing', 'changed');
const CHANGED_LENGTH = Buffer.byteLength(CHANGED_BODY);
const CHANGED_DIGEST = createHash('sha256').update(CHANGED_BODY).digest('hex');

/** The same real HTTP endpoint as a shipped file, its follow-up, or a direct router part. */
function siblingStack(): CheckedStack {
  const own = stack();
  return {
    ...own,
    manifest: { ...own.manifest, staticFiles: { '/landing': SIBLING_FILE } },
  };
}

/** Browser sampling is covered by check.test; direct stream controls keep one unclaimed checker. */
function singleFileSampleStack(): CheckedStack {
  const own = siblingStack();
  return {
    ...own,
    manifest: {
      ...own.manifest,
      reservedRoutes: [
        ...(own.manifest.reservedRoutes ?? []),
        {
          sourceRegex: '^/landing$',
          beforeFiles: true,
          has: [{ type: 'header', key: 'user-agent', value: 'Mozilla/.*' }],
        },
      ],
    },
  };
}

function siblingPart(own: CheckedStack): Part {
  const route = own.manifest.routes['/landing'];
  assert(route !== undefined, 'the direct part has a recorded route');
  const built = {
    sha256: DIGEST,
    byteLength: Buffer.byteLength(DOCUMENT),
    contentType: 'text/x-component',
  };
  return {
    kind: 'segment',
    what: 'its direct segment',
    url: new URL('/landing', own.site),
    headers: { 'accept-encoding': 'identity', rsc: '1', 'next-router-segment-prefetch': '/_tree' },
    built,
    route,
    builtOn: () => built,
    exact: true,
  };
}

type SiblingRead = 'file' | 'file follow-up' | 'router part';

function readSibling(own: CheckedStack, reader: SiblingRead) {
  if (reader === 'file') {
    return fileVerdict(own, '/landing', { file: SIBLING_FILE, prover: 'checker' });
  }
  if (reader === 'file follow-up') {
    return askedAgain(own, new URL('/landing', own.site), {
      sent: { 'if-none-match': '"another-file"' },
      what: 'on its entity tag',
    });
  }
  return partFailure(own, siblingPart(own));
}

function metadataStack(): CheckedStack {
  const original = stack();
  const route = original.manifest.routes['/landing'];
  assert(route?.cache !== undefined, 'the landing has a cache delivery policy');
  const landingRoute = { ...route, cache: { ...route.cache, delivery: 'resume' as const } };
  return {
    ...original,
    manifest: {
      ...original.manifest,
      htmlLimitedBots: '.*',
      routes: {
        ...original.manifest.routes,
        '/landing': landingRoute,
        '/start': { ...landingRoute, pathname: '/start' },
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
    direct.headers = undefined;
    direct.prefix = '';
    direct.opened = Promise.withResolvers<ServerResponse>();
    direct.closed = Promise.withResolvers<true>();
    direct.responses.length = 0;
    direct.closures.length = 0;
    visits.length = 0;
    traces.length = 0;
  });

  afterAll(async () => {
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
    rmSync(fixture.bundleDir, { recursive: true, force: true });
  });

  it.each([
    { reason: 'external-rewrite', coding: undefined, prefix: '' },
    { reason: 'middleware', coding: 'gzip', prefix: 'not a gzip stream' },
    { reason: 'rewritten', coding: undefined, prefix: '' },
    { reason: 'rewrite-not-proved', coding: 'gzip', prefix: 'not a gzip stream' },
  ] as const)(
    'releases a direct application-owned $reason stream at its headers',
    async ({ reason, coding, prefix }) => {
      const account = `passthrough;reason=${reason};mw=hit`;
      direct.headers = {
        'content-type': 'text/event-stream',
        'x-arkor-edge': account,
        ...(coding !== undefined && { 'content-encoding': coding }),
      };
      direct.prefix = prefix;
      const own = stack();
      const route = own.manifest.routes['/landing'];
      assert(route !== undefined, 'the directly requested route is recorded');
      const readings: Reading[] = [];
      let response: ServerResponse | undefined;
      try {
        const pending = routeVerdict(own, Buffer.byteLength(DOCUMENT), {
          key: '/landing',
          route,
          requested: '/landing',
          headers: { 'accept-encoding': coding ?? 'identity' },
          coding,
          answered: (answer) => {
            readings.push(answer);
          },
        });
        response = await direct.opened.promise;
        const verdict = await pending;
        await direct.closed.promise;

        expect(verdict).toStrictEqual({
          kind: 'skipped',
          reason: `answered by the application's middleware (${account})`,
        });
        expect(readings).toHaveLength(1);
        expect(readings[0]).toMatchObject({ truncated: true, length: 0 });
        expect(visits.map(({ path: pathname }) => pathname)).toStrictEqual(['/landing']);
        expect(traces).toStrictEqual(['PUT', 'DELETE']);
      } finally {
        response?.destroy();
      }
    },
  );

  it.each([
    {
      reader: 'file',
      makeStack: singleFileSampleStack,
      expected: {
        kind: 'skipped',
        reason: `answered by the application's middleware (${SIBLING_ACCOUNT})`,
      },
      requests: 1,
    },
    {
      reader: 'file follow-up',
      makeStack: siblingStack,
      expected: { kind: 'theirs' },
      requests: 1,
    },
    { reader: 'router part', makeStack: stack, expected: undefined, requests: 4 },
  ] as const)(
    'releases a middleware-owned open gzip stream for a direct $reader read',
    async ({ reader, makeStack, expected, requests }) => {
      direct.headers = {
        'content-type': 'text/event-stream',
        'content-encoding': 'gzip',
        'x-arkor-edge': SIBLING_ACCOUNT,
      };
      direct.prefix = 'not a gzip stream';
      const own = makeStack();
      try {
        const pending = readSibling(own, reader);
        await direct.opened.promise;
        const result = await pending;
        const closed = await Promise.all(direct.closures);

        expect(result).toStrictEqual(expected);
        expect(direct.responses).toHaveLength(requests);
        expect(closed).toStrictEqual(direct.closures.map(() => true));
        expect(traces).toStrictEqual(direct.responses.flatMap(() => ['PUT', 'DELETE']));
      } finally {
        for (const response of direct.responses) response.destroy();
      }
    },
  );

  it.each([
    {
      reader: 'file',
      makeStack: singleFileSampleStack,
      type: HTML,
      account: 'static;policy=default;mw=miss;enc=identity',
      expected: {
        kind: 'failed',
        reason: `answered ${Buffer.byteLength(CHANGED_BODY)} bytes other than its own ${SIBLING_FILE.byteLength}`,
      },
    },
    {
      reader: 'file follow-up',
      makeStack: siblingStack,
      type: HTML,
      account: 'static;policy=default;mw=miss;enc=identity',
      expected: expect.objectContaining({
        kind: 'answered',
        answer: expect.objectContaining({
          truncated: false,
          length: CHANGED_LENGTH,
          sha256: CHANGED_DIGEST,
        }) as unknown,
      }) as unknown,
    },
    {
      reader: 'router part',
      makeStack: stack,
      type: 'text/x-component',
      account: 'segment;policy=default;mw=miss;enc=identity',
      expected: `answered ${Buffer.byteLength(CHANGED_BODY)} bytes other than the ${SIBLING_FILE.byteLength} the build wrote`,
    },
  ] as const)(
    'still reads an ordinary direct $reader body and retains its byte evidence',
    async ({ reader, makeStack, type, account, expected }) => {
      direct.headers = {
        'content-type': type,
        'content-length': Buffer.byteLength(CHANGED_BODY),
        'cache-control': 'public, max-age=0, must-revalidate',
        'x-arkor-edge': account,
      };
      const own = makeStack();
      try {
        const pending = readSibling(own, reader);
        const response = await direct.opened.promise;
        response.end(CHANGED_BODY);
        const result = await pending;
        await direct.closed.promise;

        expect(result).toStrictEqual(expected);
        expect(traces).toStrictEqual(['PUT', 'GET', 'DELETE']);
      } finally {
        for (const response of direct.responses) response.destroy();
      }
    },
  );

  it('still rejects an ordinary direct part sent in a coding its request did not accept', async () => {
    direct.headers = {
      'content-type': 'text/x-component',
      'content-encoding': 'gzip',
      'x-arkor-edge': 'segment;policy=default;mw=miss;enc=gzip',
    };
    try {
      const pending = partFailure(stack(), siblingPart(stack()));
      const response = await direct.opened.promise;
      response.end('not a gzip stream');
      const failure = await pending;
      await direct.closed.promise;

      expect(failure).toBe(
        'answered with Content-Encoding gzip to a request that accepts identity alone',
      );
      expect(traces).toStrictEqual(['PUT', 'GET', 'DELETE']);
    } finally {
      for (const response of direct.responses) response.destroy();
    }
  });

  it.each([
    { label: 'valid', body: DOCUMENT, type: HTML, verdict: { kind: 'ok' } },
    {
      label: 'changed shell bytes',
      body: DOCUMENT.replaceAll('landing', 'changed'),
      type: HTML,
      verdict: { kind: 'failed', reason: 'does not begin with the shell the build wrote for it' },
    },
    {
      label: 'wrong media type',
      body: DOCUMENT,
      type: 'text/plain',
      verdict: {
        kind: 'failed',
        reason: `answered as text/plain, not ${HTML}`,
      },
    },
  ])('still reads and judges an ordinary direct document with $label', async (row) => {
    direct.headers = {
      'content-type': row.type,
      'content-encoding': 'gzip',
      'cache-control': NO_STORE_CACHE_CONTROL,
      vary: 'accept-encoding',
      location: '/not-a-redirect',
      'x-arkor-edge': 'shell;cont=none;policy=default;enc=gzip-live;route=/landing',
    };
    const own = stack();
    const route = own.manifest.routes['/landing'];
    assert(route !== undefined, 'the directly requested route is recorded');
    const readings: Reading[] = [];
    let response: ServerResponse | undefined;
    try {
      const pending = routeVerdict(own, Buffer.byteLength(DOCUMENT), {
        key: '/landing',
        route,
        requested: '/landing',
        headers: HEADERS,
        coding: 'gzip',
        answered: (answer) => {
          readings.push(answer);
        },
      });
      response = await direct.opened.promise;
      response.end(gzipSync(row.body));
      const verdict = await pending;
      await direct.closed.promise;

      expect(verdict).toStrictEqual(row.verdict);
      expect(readings).toHaveLength(1);
      expect(readings[0]).toMatchObject({
        truncated: false,
        length: Buffer.byteLength(row.body),
        sha256: createHash('sha256').update(row.body).digest('hex'),
      });
      expect(traces).toStrictEqual(['PUT', 'GET', 'DELETE']);
    } finally {
      response?.destroy();
    }
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
    expect(traces).toContain('GET');
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
    expect(traces).not.toContain('GET');
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
