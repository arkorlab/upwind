import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';

import { deriveEntry, kvGenerationKey } from '@stayingupwind/core/cache';
import { buildProjectManifest, type RouteEntry } from '@stayingupwind/core/manifest';
import { NAVIGATION_REQUEST_HEADERS } from '@stayingupwind/core/request';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { CheckedStack } from '../src/answers.ts';
import { routeVerdict } from '../src/documents.ts';
import type { Part } from '../src/part-marks.ts';
import { partFailure } from '../src/part-verdicts.ts';
import type { RecordedGeneration } from '../src/workers/protocol.ts';

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
const LAZY = '/posts/new';
const LAZY_DATA = '/_next/data/build/posts/new.json';
const SCOPE = 'dpl_site';
const PROPS = '{"pageProps":{"slug":"first"}}';
const LAZY_PROPS = '{"pageProps":{"slug":"new"}}';
const LAZY_PAGE = '<!doctype html><html><body>new</body></html>';
const JSON_TYPE = 'application/json';
const REFRESHED_PAGE = '<!doctype html><html><body>refreshed</body></html>';
const REFRESHED_PROPS = '{"pageProps":{"slug":"refreshed"}}';

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
  cache: { keySchemaVersion: 1, scopeId: SCOPE },
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

/**
 * What the stand-in edge answers each path with, and the generations of each record it read in
 * answering, as the stack keeps them of the traced request — and, by record, those the cache holds
 * now (`now`), where a refresh or the cache's own room changed them since.
 */
const fixture = {
  origin: new URL('http://127.0.0.1'),
  answers: new Map<string, { account: string; body: string; headers?: Record<string, string> }>(),
  generations: new Map<string, Readonly<Record<string, RecordedGeneration>>>(),
  now: new Map<string, Readonly<Record<string, RecordedGeneration>>>(),
};

/** The generations the edge read in answering, as the stack keeps them of a traced request. */
function readInAnswering(): Record<string, RecordedGeneration> {
  return Object.fromEntries(
    [...fixture.generations].flatMap(([entry, held]) => {
      const key = kvGenerationKey(SCOPE, entry);
      return Object.entries(held).map(
        ([seq, generation]) => [`${key}|${seq}`, generation] as const,
      );
    }),
  );
}

/** A generation of a page's record, holding `props` as its props. */
function generationHolding(props: string, page?: string): RecordedGeneration {
  const { sha256, byteLength } = shellOf(props);
  const html = page === undefined ? undefined : shellOf(page);
  return {
    ...(html !== undefined && { htmlSha256: html.sha256, htmlLength: html.byteLength }),
    headers: {},
    artifacts: [
      {
        role: 'pages-data',
        representationKey: 'pages-data',
        encoding: 'identity',
        sha256,
        byteLength,
      },
    ],
    partial: false,
    source: 'render',
  };
}

/** The record of a fallback route's member the build did not write, as the edge derives it. */
async function lazyEntry(): Promise<string> {
  return (await deriveEntry(SCOPE, { kind: 'pages', route: CLASS, pathname: LAZY })).entryId;
}

const server = createServer((request, response) => {
  const pathname = new URL(request.url ?? '/', fixture.origin).pathname;
  if (pathname.startsWith('/_backstage/generation/')) {
    const entry = decodeURIComponent(pathname.split('/').at(-1) ?? '');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(fixture.now.get(entry) ?? fixture.generations.get(entry) ?? {}));
    return;
  }
  if (pathname.startsWith('/_backstage/')) {
    if (request.method === 'GET') {
      const generations = readInAnswering();
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ decision: null, regenerated: null, generations }));
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

/** A router's request for a page's props, as the Pages Router fetches them. */
function propsOf(url: string, route: RouteEntry): Part {
  return {
    kind: 'data',
    what: 'page props',
    url: new URL(url, SITE),
    headers: { 'x-nextjs-data': '1' },
    route,
    built: undefined,
    builtOn: (on) => on.pagesData?.artifact,
    exact: true,
  };
}

function propsAnswer(body: string) {
  return {
    account: 'pages-data;src=r2;m=12345678',
    body,
    headers: { 'content-type': JSON_TYPE, 'x-nextjs-cache': 'HIT' },
  };
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
    fixture.generations.clear();
    fixture.now.clear();
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
      reason: 'neither those the build wrote',
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
      reason: 'not the loading shell',
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

  // A member's props the edge serves itself from its record (`servePairedPageData`), judged as
  // props rather than as a page or a handoff missing (Codex, greptile).
  it.each([
    {
      label: "a member's",
      url: DATA,
      route: MEMBER_ROUTE,
      props: PROPS,
      entry: () => 'first-entry',
    },
    {
      label: "a fallback route member's",
      url: LAZY_DATA,
      route: FALLBACK_ROUTE,
      props: LAZY_PROPS,
      entry: lazyEntry,
    },
  ])('accepts $label props the edge serves from its record', async (example) => {
    fixture.answers.set(example.url, propsAnswer(example.props));
    fixture.generations.set(await example.entry(), { 1: generationHolding(example.props) });

    await expect(
      partFailure(stackOf(), propsOf(example.url, example.route)),
    ).resolves.toBeUndefined();
  });

  it.each([
    {
      label: 'bytes no generation of its record holds',
      held: { 1: generationHolding(PROPS) },
      reason: 'not those of a generation',
    },
    { label: 'a record holding no generation', held: {}, reason: 'holds no generation' },
  ])("still rejects a member's props served with $label", async (example) => {
    fixture.answers.set(DATA, propsAnswer(LAZY_PROPS));
    fixture.generations.set('first-entry', example.held);

    await expect(partFailure(stackOf(), propsOf(DATA, MEMBER_ROUTE))).resolves.toContain(
      example.reason,
    );
  });

  // A fallback route's member a render completed after the build is served as a page of its own,
  // though its request still classifies as the fallback (greptile): its record says so, and holds
  // the page it is served as.
  it('accepts a completed fallback route member served as the page its record holds', async () => {
    fixture.answers.set(LAZY, { account: 'static-page;src=kv;m=12345678', body: LAZY_PAGE });
    fixture.generations.set(await lazyEntry(), { 1: generationHolding(LAZY_PROPS, LAZY_PAGE) });

    await expect(verdictAt(LAZY, FALLBACK_ROUTE)).resolves.toStrictEqual({ kind: 'ok' });
  });

  it.each([
    { label: "another page's", body: FIRST },
    { label: 'an empty', body: '' },
  ])('still rejects a completed fallback route member served with $label body', async (example) => {
    fixture.answers.set(LAZY, { account: 'static-page;src=kv;m=12345678', body: example.body });
    fixture.generations.set(await lazyEntry(), { 1: generationHolding(LAZY_PROPS, LAZY_PAGE) });

    await expect(verdictAt(LAZY, FALLBACK_ROUTE)).resolves.toMatchObject({
      kind: 'failed',
      reason: expect.stringContaining('nor those of a generation its record holds') as unknown,
    });
  });

  // A member the build wrote, regenerated since: its record holds the page it is served as now.
  it('accepts a regenerated member served as the page its record holds now', async () => {
    fixture.answers.set(MEMBER, { account: 'static-page;src=kv;m=12345678', body: LAZY_PAGE });
    fixture.generations.set('first-entry', { 2: generationHolding(PROPS, LAZY_PAGE) });

    await expect(verdictAt(MEMBER, MEMBER_ROUTE)).resolves.toStrictEqual({ kind: 'ok' });
  });

  it('still rejects a regenerated member served with bytes no generation holds', async () => {
    fixture.answers.set(MEMBER, { account: 'static-page;src=kv;m=12345678', body: ABOUT });
    fixture.generations.set('first-entry', { 2: generationHolding(PROPS, LAZY_PAGE) });

    await expect(verdictAt(MEMBER, MEMBER_ROUTE)).resolves.toMatchObject({
      kind: 'failed',
      reason: expect.stringContaining('nor those of a generation its record holds') as unknown,
    });
  });

  it('still rejects a fallback route member served as a page its record holds nothing of', async () => {
    fixture.answers.set(LAZY, { account: 'static-page;src=kv;m=12345678', body: LAZY_PAGE });

    await expect(verdictAt(LAZY, FALLBACK_ROUTE)).resolves.toMatchObject({
      kind: 'failed',
      reason: expect.stringContaining('its loading shell was due') as unknown,
    });
  });

  // A stale record's page or props, whose refresh replaced — or whose cache let go of — the
  // generation the edge answered from before the check read the record (Codex, greptile): held to
  // that generation, as the edge read it in answering, not to what the record holds now.
  it.each([
    {
      label: 'replaced by a refresh',
      requested: MEMBER,
      route: MEMBER_ROUTE,
      entry: () => 'first-entry',
      read: { 2: generationHolding(PROPS, LAZY_PAGE) },
      now: { 3: generationHolding(REFRESHED_PROPS, REFRESHED_PAGE) },
    },
    {
      label: 'let go of',
      requested: LAZY,
      route: FALLBACK_ROUTE,
      entry: lazyEntry,
      read: { 1: generationHolding(LAZY_PROPS, LAZY_PAGE) },
      now: {},
    },
  ])(
    'accepts a page served from the generation it was answered from, $label since',
    async (example) => {
      fixture.answers.set(example.requested, {
        account: 'static-page;src=kv;m=12345678',
        body: LAZY_PAGE,
      });
      const entry = await example.entry();
      fixture.generations.set(entry, example.read);
      fixture.now.set(entry, example.now);

      await expect(verdictAt(example.requested, example.route)).resolves.toStrictEqual({
        kind: 'ok',
      });
    },
  );

  it.each([
    {
      label: 'replaced by a refresh',
      url: DATA,
      route: MEMBER_ROUTE,
      props: PROPS,
      entry: () => 'first-entry',
      now: { 2: generationHolding(REFRESHED_PROPS) },
    },
    {
      label: 'let go of',
      url: LAZY_DATA,
      route: FALLBACK_ROUTE,
      props: LAZY_PROPS,
      entry: lazyEntry,
      now: {},
    },
  ])(
    'accepts props served from the generation they were answered from, $label since',
    async (example) => {
      fixture.answers.set(example.url, propsAnswer(example.props));
      const entry = await example.entry();
      fixture.generations.set(entry, { 1: generationHolding(example.props) });
      fixture.now.set(entry, example.now);

      await expect(
        partFailure(stackOf(), propsOf(example.url, example.route)),
      ).resolves.toBeUndefined();
    },
  );

  it('still rejects a page served with bytes neither the generation it was answered from nor the one since holds', async () => {
    fixture.answers.set(MEMBER, { account: 'static-page;src=kv;m=12345678', body: ABOUT });
    fixture.generations.set('first-entry', { 2: generationHolding(PROPS, LAZY_PAGE) });
    fixture.now.set('first-entry', { 3: generationHolding(REFRESHED_PROPS, REFRESHED_PAGE) });

    await expect(verdictAt(MEMBER, MEMBER_ROUTE)).resolves.toMatchObject({
      kind: 'failed',
      reason: expect.stringContaining('nor those of a generation its record holds') as unknown,
    });
  });

  it('still rejects props served with bytes neither the generation they were answered from nor the one since holds', async () => {
    fixture.answers.set(DATA, propsAnswer(LAZY_PROPS));
    fixture.generations.set('first-entry', { 1: generationHolding(PROPS) });
    fixture.now.set('first-entry', { 2: generationHolding(REFRESHED_PROPS) });

    await expect(partFailure(stackOf(), propsOf(DATA, MEMBER_ROUTE))).resolves.toContain(
      'not those of a generation',
    );
  });
});
