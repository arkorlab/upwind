import { describe, expect, it } from 'vitest';

import { buildProjectManifest } from '../src/manifest/manifest.ts';
import type { ProjectManifest, RouteEntry, StaticFileEntry } from '../src/manifest/schema.ts';
import { classifyRequest, type RequestClass } from '../src/request/classify.ts';
import { ROUTER_REQUEST_HEADERS } from '../src/request/constants.ts';

const OBSERVED_AT = '2026-09-15T00:00:00.000Z';
const entry: RouteEntry = {
  pathname: '/about',
  status: 200,
  shell: { sha256: 'a'.repeat(64), byteLength: 10, contentType: 'text/html', encoding: 'identity' },
  headers: {},
};
const deployment = { dplId: 'dpl_active', assetSetHash: 'h', observedAt: OBSERVED_AT };
const manifest = buildProjectManifest({
  crawlersStreamed: true,
  projectId: 's',
  runId: 'r',
  generatedAt: OBSERVED_AT,
  originHost: 'example.com',
  deployment,
  routes: [entry],
  app: { deploymentId: 'dpl_active', scriptName: 'app-1' },
});

interface ClassifyInit {
  method?: string;
  headers?: Record<string, string>;
}

const NAVIGATION = { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' };
/** Googlebot as it announces itself for a smartphone, with the Chromium it renders pages in. */
const GOOGLEBOT_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

/** A browser navigation by default: the edge serves a shell to nothing less. */
function classify(path: string, init: ClassifyInit = {}): RequestClass {
  return classifyRequest({
    method: init.method ?? 'GET',
    url: new URL(`https://site.example.app${path}`),
    headers: new Headers({ ...NAVIGATION, ...init.headers }),
    manifest,
    deployment,
  });
}

function reasonOf(result: RequestClass): string | undefined {
  return result.kind === 'passthrough' ? result.reason : undefined;
}

/** What a hosted app's manifest holding `files` answers a GET of `path` with: the file, or why not. */
function staticFileOf(
  files: Record<string, StaticFileEntry>,
  path: string,
): StaticFileEntry | string | undefined {
  const hosted = { ...manifest, staticFiles: files };
  const classified = classifyRequest({
    method: 'GET',
    url: new URL(`https://site.example.app${path}`),
    headers: new Headers(),
    manifest: hosted,
    deployment,
  });
  return classified.kind === 'static-file' ? classified.file : reasonOf(classified);
}

/** The same application with a page the build finished at `/built`, served whole. */
const withStaticDocument = buildProjectManifest({
  crawlersStreamed: true,
  projectId: 's',
  runId: 'r',
  generatedAt: OBSERVED_AT,
  originHost: 'example.com',
  deployment,
  routes: [entry, { ...entry, pathname: '/built' }],
  app: { deploymentId: 'dpl_active', scriptName: 'app-1' },
});

/** What that application answers a navigation to `path` with: the class, or why it is passed on. */
function completed(path: string, headers: Record<string, string> = {}): string {
  const classified = classifyRequest({
    method: 'GET',
    url: new URL(`https://site.example.app${path}`),
    headers: new Headers({ ...NAVIGATION, ...headers }),
    manifest: withStaticDocument,
    deployment,
  });
  return reasonOf(classified) ?? classified.kind;
}

/** A fetch of a page with no Fetch Metadata: what a crawler's own fetch carries. */
function bareFetch(headers: Record<string, string>): RequestClass {
  return classifyRequest({
    method: 'GET',
    url: new URL('https://site.example.app/about'),
    headers: new Headers({ accept: 'text/html,application/xhtml+xml', ...headers }),
    manifest,
    deployment,
  });
}

describe('classifyRequest', () => {
  /**
   * A page is the filesystem step of Next.js's routing: a redirect or a `beforeFiles` rewrite
   * runs before it and claims the path, an `afterFiles` rewrite runs after it and does not.
   */
  it('leaves a page a rule ahead of the filesystem claims to the application', () => {
    const withRules = buildProjectManifest({
      crawlersStreamed: true,
      projectId: 's',
      runId: 'r',
      generatedAt: OBSERVED_AT,
      originHost: 'example.com',
      deployment,
      routes: [entry, { ...entry, pathname: '/built' }, { ...entry, pathname: '/late' }],
      app: { deploymentId: 'dpl_active', scriptName: 'app-1' },
      reservedRoutes: [
        { sourceRegex: '^/about$', beforeFiles: true },
        { sourceRegex: '^/built$', beforeFiles: true },
        // An `afterFiles` rewrite: the page answers, and the rule never runs.
        { sourceRegex: '^/late$' },
      ],
    });
    const answer = (path: string): string => {
      const classified = classifyRequest({
        method: 'GET',
        url: new URL(`https://site.example.app${path}`),
        headers: new Headers(NAVIGATION),
        manifest: withRules,
        deployment,
      });
      return reasonOf(classified) ?? classified.kind;
    };

    expect(answer('/about')).toBe('route-not-proved');
    expect(answer('/built')).toBe('route-not-proved');
    expect(answer('/late')).toBe('document');
  });

  it('serves a document the build finished, under the admission every document has', () => {
    expect(completed('/built')).toBe('document');
    expect(completed('/about')).toBe('document');
    // A draft-mode visitor, a route parameter smuggled into the query, a `<link rel=prefetch>`: what
    // belongs with the application belongs with it whether or not the build finished the page.
    expect(completed('/built', { cookie: '__prerender_bypass=1' })).toBe('bypass-cookie');
    expect(completed('/built?nxtPid=1')).toBe('bypass-query');
    expect(completed('/built', { 'sec-fetch-dest': 'empty' })).toBe('sec-fetch-dest');
  });

  it('serves proved documents and delegates unknown routes', () => {
    expect(classify('/about').kind).toBe('document');
    expect(reasonOf(classify('/about/'))).toBe('route-not-proved');
    expect(reasonOf(classify('/other'))).toBe('route-not-proved');
  });

  /**
   * Not a route the middleware may be run for on the chance of a rewrite, as an unknown one is:
   * Next.js redirects a repeated slash ahead of it, and so does the Worker the request is left to.
   */
  it('leaves a path that repeats a slash to the Worker, before anything is asked of it', () => {
    expect(reasonOf(classify('//about'))).toBe('repeated-slash');
    expect(reasonOf(classify('/about//'))).toBe('repeated-slash');
    expect(reasonOf(classify('/a//b'))).toBe('repeated-slash');
  });

  it('passes through methods other than GET and HEAD, and actions', () => {
    expect(classify('/about', { method: 'POST', headers: { 'next-action': 'abc' } }).kind).toBe(
      'action',
    );

    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH']) {
      expect(reasonOf(classify('/about', { method }))).toBe('method');
    }
  });

  /**
   * `HEAD` is answered with the headers `GET` would carry, and Next.js routes it as it routes
   * `GET`: whatever the request says of itself decides as it would for `GET`.
   */
  it('classifies HEAD as it classifies GET', () => {
    const cases: [string, ClassifyInit][] = [
      ['/about', {}],
      ['/other', {}],
      ['/about', { headers: { 'sec-fetch-dest': 'empty' } }],
      ['/about', { headers: { 'sec-fetch-mode': 'cors' } }],
      ['/about', { headers: { rsc: '1' } }],
      ['/about', { headers: { 'next-router-prefetch': '1' } }],
      ['/about', { headers: { cookie: '__prerender_bypass=1' } }],
      ['/about?__nextDataReq=1', {}],
      ['/about', { headers: { accept: 'application/json' } }],
      ['/_next/data/x/about.json', {}],
      ['//about', {}],
    ];
    for (const [path, init] of cases) {
      expect(classify(path, { ...init, method: 'HEAD' })).toStrictEqual(
        classify(path, { ...init, method: 'GET' }),
      );
    }

    expect(classify('/about', { method: 'HEAD' }).kind).toBe('document');
  });

  it('recognises the router protocol', () => {
    expect(classify('/about', { headers: { rsc: '1' } }).kind).toBe('rsc');
    expect(
      classify('/about', { headers: { rsc: '1', 'next-router-segment-prefetch': '/_tree' } }).kind,
    ).toBe('segment-prefetch');
    expect(reasonOf(classify('/about', { headers: { 'next-router-prefetch': '1' } }))).toBe(
      'router-header',
    );
  });

  /**
   * Each of the router's own headers, with any value, keeps a request from a document: the list a
   * rule's condition is read against (`mayHoldForDocument`), so a rule that requires one of them
   * cannot hold for a request the edge answers with a document.
   */
  it.each(ROUTER_REQUEST_HEADERS)('answers no request carrying %s with a document', (name) => {
    for (const value of ['1', '0', 'anything']) {
      expect(classify('/about', { headers: { [name]: value } }).kind).not.toBe('document');
    }
  });

  it('never trusts internal or bypass signals from clients', () => {
    expect(reasonOf(classify('/about', { headers: { 'next-resume': '1' } }))).toBe(
      'internal-header',
    );
    expect(reasonOf(classify('/about', { headers: { 'x-middleware-prefetch': '1' } }))).toBe(
      'internal-header',
    );
    expect(reasonOf(classify('/about', { headers: { cookie: '__prerender_bypass=1' } }))).toBe(
      'bypass-cookie',
    );
    expect(reasonOf(classify('/about', { headers: { cookie: '__arkor_edge_bypass=1' } }))).toBe(
      'bypass-cookie',
    );
    expect(reasonOf(classify('/about?__prerender_bypass=x'))).toBe('bypass-query');
  });

  it('honours deployment pins in cookies and queries', () => {
    expect(classify('/about', { headers: { cookie: '__vdpl=dpl_active' } }).kind).toBe('document');
    expect(reasonOf(classify('/about', { headers: { cookie: '__vdpl=dpl_old' } }))).toBe(
      'vdpl-mismatch',
    );
    expect(classify('/about?dpl=dpl_active').kind).toBe('document');
    expect(reasonOf(classify('/about?dpl=dpl_old'))).toBe('dpl-mismatch');
    expect(reasonOf(classify('/about?_rsc=abc'))).toBe('bypass-query');
  });

  /**
   * Next.js's router sends `x-deployment-id` with every request it makes once the build has a
   * deployment id, segment prefetches included: on one it is a pin like `dpl`, not a header only a
   * host may send. Read as internal, every prefetch a browser made was handed on.
   */
  it("judges a segment prefetch's x-deployment-id as a pin, and a document's as internal", () => {
    const prefetch = { rsc: '1', 'next-router-segment-prefetch': '/_tree' };

    expect(
      classify('/about', { headers: { ...prefetch, 'x-deployment-id': 'dpl_active' } }).kind,
    ).toBe('segment-prefetch');
    expect(
      reasonOf(classify('/about', { headers: { ...prefetch, 'x-deployment-id': 'dpl_old' } })),
    ).toBe('dpl-mismatch');
    expect(
      reasonOf(
        classify('/about', {
          headers: { ...prefetch, 'x-deployment-id': 'dpl_active, dpl_active' },
        }),
      ),
    ).toBe('dpl-mismatch');
    // Only the deployment id is let through: what else a client may not send still turns it away.
    expect(
      reasonOf(
        classify('/about', {
          headers: { ...prefetch, 'x-deployment-id': 'dpl_active', 'next-resume': '1' },
        }),
      ),
    ).toBe('internal-header');
    expect(reasonOf(classify('/about', { headers: { 'x-deployment-id': 'dpl_active' } }))).toBe(
      'internal-header',
    );
    // An empty segment header names no part: a plain RSC request, which carries the header freely.
    expect(
      classify('/about', {
        headers: { rsc: '1', 'next-router-segment-prefetch': '', 'x-deployment-id': 'dpl_old' },
      }).kind,
    ).toBe('rsc');
  });

  /** Every occurrence has to name the deployment being served; one that names another does not. */
  it('judges every occurrence of a deployment pin', () => {
    expect(reasonOf(classify('/about?dpl=dpl_active&dpl=dpl_old'))).toBe('dpl-mismatch');
    expect(classify('/about?dpl=dpl_active&dpl=dpl_active').kind).toBe('document');
    expect(
      reasonOf(classify('/about', { headers: { cookie: '__vdpl=dpl_active; __vdpl=dpl_old' } })),
    ).toBe('vdpl-mismatch');
    expect(
      classify('/about', { headers: { cookie: '__vdpl=dpl_active; __vdpl=dpl_active' } }).kind,
    ).toBe('document');
  });

  /**
   * A crawler's own fetch carries no Fetch Metadata: Googlebot fetches a page with crawl
   * infrastructure, not a browser navigation, and renders the document it got after. Taken for the
   * navigation it is by its agent, it is served the shell, as Next.js streams to it; a crawler on
   * the HTML-limited list is passed on, and an agent that names no crawler still needs the hints.
   */
  it('takes a crawler’s fetch without Fetch Metadata for the navigation it is', () => {
    expect(bareFetch({ 'user-agent': GOOGLEBOT_USER_AGENT }).kind).toBe('document');
    expect(reasonOf(bareFetch({ 'user-agent': 'Twitterbot/1.0' }))).toBe('bot');
    expect(reasonOf(bareFetch({ 'user-agent': 'curl/8.9.1' }))).toBe('sec-fetch-dest');
    expect(
      reasonOf(bareFetch({ 'user-agent': GOOGLEBOT_USER_AGENT, accept: 'application/json' })),
    ).toBe('accept');
    // An agent that says what it fetches is read by what it says, whatever it calls itself.
    expect(
      reasonOf(bareFetch({ 'user-agent': GOOGLEBOT_USER_AGENT, 'sec-fetch-dest': 'empty' })),
    ).toBe('sec-fetch-dest');
  });

  /**
   * Next.js renders the page whole for a crawler it sends blocking metadata to, and streams to
   * every other visitor — Googlebot included, which runs a browser — so that one gets the shell.
   */
  it('passes on the crawlers Next.js renders whole, and reads the navigation hints', () => {
    expect(
      classify('/about', {
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' },
      }).kind,
    ).toBe('document');
    expect(classify('/about', { headers: { 'user-agent': GOOGLEBOT_USER_AGENT } }).kind).toBe(
      'document',
    );
    expect(reasonOf(classify('/about', { headers: { 'user-agent': 'Twitterbot/1.0' } }))).toBe(
      'bot',
    );
    expect(
      reasonOf(
        classify('/about', {
          headers: { 'user-agent': 'AdsBot-Google (+http://www.google.com/adsbot.html)' },
        }),
      ),
    ).toBe('bot');
    expect(classify('/about', { headers: { 'user-agent': 'Mozilla/5.0 Chrome/140' } }).kind).toBe(
      'document',
    );
    expect(reasonOf(classify('/about', { headers: { 'sec-fetch-dest': 'empty' } }))).toBe(
      'sec-fetch-dest',
    );
    expect(reasonOf(classify('/about', { headers: { accept: 'application/json' } }))).toBe(
      'accept',
    );
  });

  it('requires the client to say it is navigating to a document', () => {
    const bare = classifyRequest({
      method: 'GET',
      url: new URL('https://site.example.app/about'),
      headers: new Headers({ accept: 'text/html' }),
      manifest,
      deployment,
    });

    const destinationOnly = classifyRequest({
      method: 'GET',
      url: new URL('https://site.example.app/about'),
      headers: new Headers({ 'sec-fetch-dest': 'document' }),
      manifest,
      deployment,
    });

    expect(reasonOf(bare)).toBe('sec-fetch-dest');
    expect(reasonOf(classify('/about', { headers: { 'sec-fetch-mode': 'cors' } }))).toBe(
      'sec-fetch-mode',
    );
    expect(reasonOf(destinationOnly)).toBe('sec-fetch-mode');
  });

  /**
   * A browser adopts a prefetch or a prerender still in flight as the navigation the visitor then
   * makes, so the shell goes to it as to that navigation, in every spelling.
   */
  it('serves a speculative navigation as the navigation it is', () => {
    expect(classify('/about', { headers: { 'sec-purpose': 'prefetch' } }).kind).toBe('document');
    expect(classify('/about', { headers: { 'sec-purpose': 'prefetch;prerender' } }).kind).toBe(
      'document',
    );
    expect(classify('/about', { headers: { purpose: 'prefetch' } }).kind).toBe('document');
    expect(classify('/about', { headers: { 'x-moz': 'prefetch' } }).kind).toBe('document');
  });

  /**
   * Firefox sends a speculation rule's prefetch with a resource fetch's metadata (`empty`,
   * `no-cors`; Mozilla bug 2074629), as browsers send a `<link rel=prefetch>`, and adopts it as
   * the navigation all the same: it is that navigation, where it asks for a document. A resource
   * fetched with the same metadata and no prefetch hint, or with a hint and CORS, is no page's.
   */
  it('serves a prefetch with a resource fetch’s metadata as the navigation it is for', () => {
    const resource = { 'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'no-cors' };
    const prefetch = { ...resource, 'sec-purpose': 'prefetch', accept: 'text/html' };

    expect(classify('/about', { headers: prefetch }).kind).toBe('document');
    expect(classify('/about', { headers: { ...resource, 'x-moz': 'prefetch' } }).kind).toBe(
      'document',
    );
    expect(
      reasonOf(classify('/about', { headers: { ...prefetch, accept: 'application/json' } })),
    ).toBe('accept');
    expect(reasonOf(classify('/about', { headers: resource }))).toBe('sec-fetch-dest');
    expect(
      reasonOf(classify('/about', { headers: { ...prefetch, 'sec-fetch-mode': 'cors' } })),
    ).toBe('sec-fetch-dest');
  });

  /**
   * An application's shell came out of its build, where anything reading a cookie or a search
   * parameter is rendered after it, so no name is judged — only the bypass names and the pins.
   */
  it('serves a shell alongside any cookie and any query key', () => {
    expect(classify('/about', { headers: { cookie: 'session=abc; _ga=1' } }).kind).toBe('document');
    expect(classify('/about?page=2&anything=1').kind).toBe('document');
    expect(classify('/about?&').kind).toBe('document');
    expect(classify('/about?=1').kind).toBe('document');
    expect(classify('/about', { headers: { cookie: 'a=1; a=2' } }).kind).toBe('document');
    // The pins are judged against the deployment, not against a list.
    expect(classify('/about?dpl=dpl_active&utm_source=x').kind).toBe('document');
    expect(classify('/about', { headers: { cookie: '__vdpl=dpl_active; _gid=2' } }).kind).toBe(
      'document',
    );
  });

  /** Judging no name does not admit the two that ask for the draft the build never rendered. */
  it('still refuses a bypass cookie and a bypass query key', () => {
    expect(reasonOf(classify('/about', { headers: { cookie: '__prerender_bypass=1' } }))).toBe(
      'bypass-cookie',
    );
    expect(reasonOf(classify('/about?nxtPslug=x'))).toBe('bypass-query');
  });

  /**
   * Recovery from a failed continuation reloads with a `SameSite=Lax` cookie, which a cross-site
   * frame does not send; the reload would hit the same splice and the loop guard would then leave
   * the frame on a truncated document. Proxying costs an embedded document its shell, never more.
   */
  it('proxies an embedded document instead of serving it a shell', () => {
    expect(reasonOf(classify('/about', { headers: { 'sec-fetch-dest': 'iframe' } }))).toBe(
      'sec-fetch-dest',
    );
    expect(reasonOf(classify('/about', { headers: { 'sec-fetch-dest': 'frame' } }))).toBe(
      'sec-fetch-dest',
    );
    expect(classify('/about', { headers: { 'sec-fetch-dest': 'document' } }).kind).toBe('document');
  });

  it('routes static assets and framework internals', () => {
    expect(classify('/_next/static/chunks/main-abc.js').kind).toBe('immutable-asset-candidate');
    expect(classify('/_next/static/immutable/chunks/x.js').kind).toBe('immutable-asset-candidate');
    expect(reasonOf(classify('/_next/image?url=x'))).toBe('next-internal');
    expect(reasonOf(classify('/_next/static/development/x.js'))).toBe('next-internal');
    expect(reasonOf(classify('/.well-known/acme-challenge/x'))).toBe('well-known');
    expect(reasonOf(classify('/sw.js', { headers: { 'service-worker': 'script' } }))).toBe(
      'service-worker',
    );
    expect(reasonOf(classify('/about', { headers: { range: 'bytes=0-1' } }))).toBe('range');
  });

  /**
   * A hosted app's manifest names files by content. Those are the same bytes for anyone, so they
   * are decided before cookies, query keys or navigation hints are looked at — and a `dpl` naming
   * another deployment is the one thing that sends the request elsewhere.
   */
  it('serves a file the manifest holds, whoever asks', () => {
    const file = {
      sha256: 'b'.repeat(64),
      byteLength: 3,
      contentType: 'text/plain',
      immutable: false,
    };
    const hosted = {
      ...manifest,
      staticFiles: { '/robots.txt': file, '/_next/static/x.js': file },
    };
    const classifyHosted = (path: string, init: ClassifyInit = {}): RequestClass => {
      return classifyRequest({
        method: init.method ?? 'GET',
        url: new URL(`https://site.example.app${path}`),
        headers: new Headers(init.headers),
        manifest: hosted,
        deployment,
      });
    };

    expect(classifyHosted('/robots.txt', { headers: { cookie: 'session=1' } })).toStrictEqual({
      kind: 'static-file',
      pathname: '/robots.txt',
      file,
    });
    expect(classifyHosted('/robots.txt', { method: 'HEAD' }).kind).toBe('static-file');
    expect(classifyHosted('/_next/static/x.js?dpl=dpl_active').kind).toBe('static-file');
    expect(reasonOf(classifyHosted('/_next/static/x.js?dpl=dpl_other'))).toBe('dpl-mismatch');
    expect(reasonOf(classifyHosted('/_next/static/x.js?dpl=dpl_active&dpl=dpl_active'))).toBe(
      'dpl-mismatch',
    );
    expect(reasonOf(classifyHosted('/robots.txt', { method: 'POST' }))).toBe('method');
    expect(reasonOf(classifyHosted('/missing.txt'))).toBe('sec-fetch-dest');
  });

  /**
   * The documents of the deployment before, still open in browsers, ask for their files by that
   * deployment: a file only it built is kept under its id, and a content-addressed name is the
   * same bytes for whichever deployment asks.
   */
  it('serves a file kept from the deployment before, by that deployment', () => {
    const kept = {
      sha256: 'c'.repeat(64),
      byteLength: 3,
      contentType: 'text/javascript',
      immutable: false,
      deploymentId: 'dpl_previous',
    };
    const shared = {
      sha256: 'f'.repeat(64),
      byteLength: 6,
      contentType: 'text/javascript',
      immutable: true,
    };
    const files = {
      '/_next/static/build/old.js': kept,
      '/_next/static/immutable/chunks/shared.js': shared,
    };

    // Its documents ask with the deployment they came from, or with nothing.
    expect(staticFileOf(files, '/_next/static/build/old.js?dpl=dpl_previous')).toBe(kept);
    expect(staticFileOf(files, '/_next/static/build/old.js')).toBe(kept);
    expect(staticFileOf(files, '/_next/static/build/old.js?dpl=dpl_active')).toBe('dpl-mismatch');
    expect(staticFileOf(files, '/_next/static/immutable/chunks/shared.js?dpl=dpl_previous')).toBe(
      shared,
    );
    expect(staticFileOf(files, '/_next/static/immutable/chunks/shared.js?dpl=dpl_other')).toBe(
      shared,
    );
  });

  /**
   * A name both builds gave a file that is not content-addressed — a build manifest under a
   * build id that stays the same — answers each deployment with the bytes its own build gave it.
   */
  it('serves each deployment its own build of a name both builds have', () => {
    const buildManifest = {
      sha256: 'd'.repeat(64),
      byteLength: 5,
      contentType: 'text/javascript',
      immutable: false,
      previous: {
        sha256: 'e'.repeat(64),
        byteLength: 4,
        contentType: 'text/javascript',
        deploymentId: 'dpl_previous',
      },
    };
    const files = { '/_next/static/build/_buildManifest.js': buildManifest };

    expect(staticFileOf(files, '/_next/static/build/_buildManifest.js?dpl=dpl_active')).toBe(
      buildManifest,
    );
    expect(staticFileOf(files, '/_next/static/build/_buildManifest.js')).toBe(buildManifest);
    expect(
      staticFileOf(files, '/_next/static/build/_buildManifest.js?dpl=dpl_previous'),
    ).toStrictEqual({ ...buildManifest.previous, immutable: false });
    expect(staticFileOf(files, '/_next/static/build/_buildManifest.js?dpl=dpl_other')).toBe(
      'dpl-mismatch',
    );
  });

  it('passes through when no manifest is active', () => {
    const result = classifyRequest({
      method: 'GET',
      url: new URL('https://site.example.app/about'),
      headers: new Headers(NAVIGATION),
      manifest: undefined,
      deployment: undefined,
    });

    expect(reasonOf(result)).toBe('no-manifest');
  });
});

/**
 * What the application answers a navigation by `userAgent` with, when its `htmlLimitedBots` is
 * `pattern`: the class, or why it is passed on. `undefined` sends no user agent at all.
 */
function underList(pattern: string, userAgent: string | undefined): string {
  const listed = buildProjectManifest({
    crawlersStreamed: true,
    projectId: 's',
    runId: 'r',
    generatedAt: OBSERVED_AT,
    originHost: 'example.com',
    deployment,
    routes: [entry],
    app: { deploymentId: 'dpl_active', scriptName: 'app-1' },
    htmlLimitedBots: pattern,
  });
  const classified = classifyRequest({
    method: 'GET',
    url: new URL('https://site.example.app/about'),
    headers: new Headers({
      ...NAVIGATION,
      ...(userAgent !== undefined && { 'user-agent': userAgent }),
    }),
    manifest: listed,
    deployment,
  });
  return reasonOf(classified) ?? classified.kind;
}

/** `MyBot` and one more plain name, `length` characters of pattern in all. */
function plainNames(length: number): string {
  return `MyBot|${'Crawler'.padEnd(length - 'MyBot|'.length, 'x')}`;
}

describe('an application’s own htmlLimitedBots', () => {
  /** Tested as Next.js tests it — case-insensitively, anywhere in the value — in place of its list. */
  it('replaces Next.js’s own list, as it does in Next.js', () => {
    expect(underList('MyBot|OtherBot', 'Mozilla/5.0 (compatible; mybot/2.1)')).toBe('bot');
    expect(underList('MyBot|OtherBot', 'Twitterbot/1.0')).toBe('document');
    expect(underList('MyBot|OtherBot', 'Mozilla/5.0 Chrome/140')).toBe('document');
  });

  /**
   * How Next.js's documentation turns streamed metadata off. A request that names no agent is
   * still streamed to, and an empty pattern is none at all, as Next.js reads either.
   */
  it('names every agent under a pattern that matches anything, and never an empty one', () => {
    expect(underList('.*', 'Mozilla/5.0 Chrome/140')).toBe('bot');
    expect(underList('.*', '')).toBe('document');
    expect(underList('.*', undefined)).toBe('document');
    expect(underList('', 'Twitterbot/1.0')).toBe('bot');
    expect(underList('', 'Mozilla/5.0 Chrome/140')).toBe('document');
  });

  /**
   * The edge runs the pattern for every application it serves, so one that backtracks is never
   * run, nor one that does not compile. No other list stands in for it: any agent may be one it
   * names, and a shell resumed for such a visitor would be resumed with the blocking metadata tree
   * against a state made for the streamed one. Every visitor that names an agent is passed on, for
   * the list; one that names none is streamed to whatever the pattern, and served the shell.
   */
  it('passes every agent on under a pattern the edge will not run', () => {
    const backtracking = '(?:MyBot|Crawler+)+';

    for (const pattern of [backtracking, '(MyBot', String.raw`MyBot|\w+\w+!`]) {
      for (const userAgent of [
        'MyBot/1.0',
        'Twitterbot/1.0',
        'Mozilla/5.0 (compatible; SomeBot/1.0)',
      ]) {
        expect([pattern, userAgent, underList(pattern, userAgent)]).toStrictEqual([
          pattern,
          userAgent,
          'html-limited-bots',
        ]);
      }

      expect([pattern, underList(pattern, '')]).toStrictEqual([pattern, 'document']);
      expect([pattern, underList(pattern, undefined)]).toStrictEqual([pattern, 'document']);
    }
  });

  /**
   * Repetitions side by side backtrack polynomially in the agent's length, to a degree the
   * application picks: `a.*.*.*.*!` takes seconds against a browser's own user agent. Nor is a
   * group run that is not the whole of an alternative, or more than two repetitions the engine
   * backtracks over, each of which costs the square of the agent's length.
   */
  it('runs only a list of plain alternatives, each with one repetition at most', () => {
    const refused = [
      String.raw`MyBot|\w+\w+!`,
      'MyBot|a.*.*.*.*!',
      String.raw`MyBot|\w*\w*\w*\w*\w*\w*!`,
      String.raw`MyBot|\w+!|\w+#|\w+%`,
      'MyBot|(?:OtherBot)+',
      'MyBot|Other(?:Bot)',
      String.raw`MyBot|Other\1`,
    ];

    for (const pattern of refused) {
      expect([pattern, underList(pattern, 'Mozilla/5.0 Chrome/140')]).toStrictEqual([
        pattern,
        'html-limited-bots',
      ]);
    }
  });

  /**
   * Next.js tests the pattern anywhere in the agent, and a user agent holds no line terminator, so
   * a run of anything that begins or ends an alternative only asks for as many characters as it
   * takes at least, and a group that is the whole of one is its alternatives. Simplified so, the
   * shapes applications write — and `.*.*.*.*!`, which as written takes seconds — are run, and name
   * the agents they name as written.
   */
  it('runs what a run of anything at either end of an alternative, or a group around it, hides', () => {
    const asked: readonly (readonly [pattern: string, userAgent: string, answer: string])[] = [
      ['.*bot.*', 'Mozilla/5.0 (compatible; SomeBot/1.0)', 'bot'],
      ['.*bot.*', 'Mozilla/5.0 Chrome/140', 'document'],
      ['.*(bot|crawler).*', 'AcmeCrawler/2.0', 'bot'],
      ['.*(bot|crawler).*', 'Mozilla/5.0 Chrome/140', 'document'],
      ['(?:MyBot)', 'MyBot/1.0', 'bot'],
      ['^.*MyBot$', 'Mozilla/5.0 MyBot', 'bot'],
      ['^.*MyBot$', 'MyBot/1.0', 'document'],
      ['.+MyBot', 'MyBot/1.0', 'document'],
      ['.+MyBot', 'Acme MyBot/1.0', 'bot'],
      ['.*.*.*.*!', 'Mozilla/5.0 Chrome/140', 'document'],
      ['.*.*.*.*!', 'Hello!', 'bot'],
      ['(?:.*)', 'Mozilla/5.0 Chrome/140', 'bot'],
    ];
    const started = performance.now();

    expect(
      asked.map(([pattern, userAgent]) => [pattern, userAgent, underList(pattern, userAgent)]),
    ).toStrictEqual(asked);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  /**
   * A counted repetition is backtracked over wherever it stands, since the engine tries each count
   * it allows: it counts against the two even where it ends its alternative, and `\w{0,9}` names
   * every agent there is, so running it shows.
   */
  it('counts a counted repetition that ends its alternative', () => {
    const one = String.raw`MyBot|\w{0,9}`;
    const three = String.raw`MyBot|\w{0,9}|\w{0,9}|\w{0,9}`;

    expect(underList(one, 'Mozilla/5.0 Chrome/140')).toBe('bot');
    expect(underList(three, 'Mozilla/5.0 Chrome/140')).toBe('html-limited-bots');
  });

  /** Plain alternatives cost their own length at each position, so their length is bounded too. */
  it('runs a list of plain names only up to 4096 characters of it', () => {
    const longest = plainNames(4096);
    const longer = plainNames(4097);

    expect([longest.length, longer.length]).toStrictEqual([4096, 4097]);
    expect(underList(longest, 'MyBot/1.0')).toBe('bot');
    expect(underList(longest, 'Mozilla/5.0 Chrome/140')).toBe('document');
    expect(underList(longer, 'Mozilla/5.0 Chrome/140')).toBe('html-limited-bots');
  });

  it('runs Next.js’s list with an application’s own names added to it', () => {
    const extended = String.raw`[\w-]+-Google|Google-[\w-]+|Twitterbot|[\w-]+-Crawler|MyBot.*`;

    expect(underList(extended, 'Acme-Crawler/2.0')).toBe('bot');
    expect(underList(extended, 'mybot')).toBe('bot');
    expect(underList(extended, 'Discordbot/2.0')).toBe('document');
    expect(underList(extended, GOOGLEBOT_USER_AGENT)).toBe('document');
  });

  /**
   * What nearly every build records, since loading the config fills Next.js's own list in where an
   * application names none: read as the edge reads that list, whatever the agent's length.
   */
  it('reads Next.js’s own list as a build records it', () => {
    const recorded = String.raw`[\w-]+-Google|Google-[\w-]+|Chrome-Lighthouse|Slurp|DuckDuckBot|baiduspider|yandex|sogou|bitlybot|tumblr|vkShare|quora link preview|redditbot|ia_archiver|Bingbot|BingPreview|applebot|facebookexternalhit|facebookcatalog|Twitterbot|LinkedInBot|Slackbot|Discordbot|WhatsApp|SkypeUriPreview|Yeti|googleweblight`;

    expect(underList(recorded, 'Twitterbot/1.0')).toBe('bot');
    expect(underList(recorded, 'AdsBot-Google (+http://www.google.com/adsbot.html)')).toBe('bot');
    expect(underList(recorded, GOOGLEBOT_USER_AGENT)).toBe('document');
    expect(underList(recorded, `Mozilla/5.0 ${'x'.repeat(600)}`)).toBe('document');
  });

  /** Run anywhere in the value, a pattern the shape check admits is still quadratic in its length. */
  it('leaves an agent too long to run the pattern against to the Function', () => {
    const long = `Mozilla/5.0 ${'x'.repeat(600)}`;

    expect(underList('MyBot', long)).toBe('bot');
    // Next.js's own list is read whatever the length: it is read without backtracking, where its
    // `[\w-]+-Google` compiled would backtrack from every position of an agent it does not name.
    expect(classify('/about', { headers: { 'user-agent': long } }).kind).toBe('document');
    expect(classify('/about', { headers: { 'user-agent': 'x'.repeat(128 * 1024) } }).kind).toBe(
      'document',
    );
  });
});

describe('a build of Next.js 16.2', () => {
  /**
   * Next.js 16.2 renders a partially prerendered page whole for every crawler, Googlebot among them
   * (`shouldWaitOnAllReady`): no crawler is served its shell. A page the build finished is served
   * whole to it, and a browser the shell, as on any build; a manifest from before the field existed
   * is read the same, as every reader did before it.
   */
  it('passes every crawler on, and serves a browser the shell', () => {
    const before = buildProjectManifest({
      projectId: 's',
      runId: 'r',
      generatedAt: OBSERVED_AT,
      originHost: 'example.com',
      deployment,
      routes: [
        entry,
        {
          ...entry,
          pathname: '/built',
          cache: { entryId: 'e', kind: 'pages', delivery: 'complete' },
        },
      ],
      app: { deploymentId: 'dpl_active', scriptName: 'app-1' },
    });
    const answered = (path: string, userAgent: string): string => {
      const classified = classifyRequest({
        method: 'GET',
        url: new URL(`https://site.example.app${path}`),
        headers: new Headers({ ...NAVIGATION, 'user-agent': userAgent }),
        manifest: before,
        deployment,
      });
      return reasonOf(classified) ?? classified.kind;
    };

    expect(answered('/about', GOOGLEBOT_USER_AGENT)).toBe('bot');
    expect(answered('/built', GOOGLEBOT_USER_AGENT)).toBe('document');
    expect(answered('/about', 'Mozilla/5.0 Chrome/140')).toBe('document');
  });
});

describe('a manifest made before the list was recorded', () => {
  /**
   * Such a manifest still carries the list, as the crawler condition `next build` wrote into its
   * routes. Read off them, an application's own list leaves out the agents of Next.js's that it
   * leaves out, and they are served the shell, as the application streams to them.
   */
  it('reads the application’s list off its routes', () => {
    const legacy = buildProjectManifest({
      crawlersStreamed: true,
      projectId: 's',
      runId: 'r',
      generatedAt: OBSERVED_AT,
      originHost: 'example.com',
      deployment,
      routes: [{ ...entry, bypassFor: [{ type: 'header', key: 'user-agent', value: 'MyBot' }] }],
      app: { deploymentId: 'dpl_active', scriptName: 'app-1' },
    });
    const answered = (userAgent: string): string => {
      const classified = classifyRequest({
        method: 'GET',
        url: new URL('https://site.example.app/about'),
        headers: new Headers({ ...NAVIGATION, 'user-agent': userAgent }),
        manifest: legacy,
        deployment,
      });
      return reasonOf(classified) ?? classified.kind;
    };

    expect(answered('Twitterbot/1.0')).toBe('document');
    expect(answered('Mozilla/5.0 (compatible; mybot/2.1)')).toBe('bot');
  });
});

describe('a visitor Next.js sends blocking metadata to', () => {
  /** `/about` resumes its shell, `/built` the build finished, and `/elsewhere` names no route. */
  const finished = buildProjectManifest({
    crawlersStreamed: true,
    projectId: 's',
    runId: 'r',
    generatedAt: OBSERVED_AT,
    originHost: 'example.com',
    deployment,
    routes: [
      entry,
      {
        ...entry,
        pathname: '/built',
        cache: { entryId: 'e', kind: 'pages', delivery: 'complete' },
      },
    ],
    app: { deploymentId: 'dpl_active', scriptName: 'app-1' },
    htmlLimitedBots: '.*',
  });
  const answer = (
    path: string,
    headers: Record<string, string>,
    listed: ProjectManifest = finished,
  ): string => {
    const classified = classifyRequest({
      method: 'GET',
      url: new URL(`https://site.example.app${path}`),
      headers: new Headers({ ...NAVIGATION, ...headers }),
      manifest: listed,
      deployment,
    });
    return reasonOf(classified) ?? classified.kind;
  };
  const browser = { 'user-agent': 'Mozilla/5.0 Chrome/140' };

  /**
   * Next.js renders only a partially prerendered page whole for it, and a prerendered page's
   * metadata is resolved at build time: the document the build finished is what it is sent.
   */
  it('is served a page the build finished, and no shell', () => {
    expect(answer('/built', browser)).toBe('document');
    expect(answer('/about', browser)).toBe('bot');
  });

  /** Under a list the edge will not run, too: every agent may be named, and no shell is served. */
  it('is served a page the build finished under a list the edge will not run', () => {
    const grouped: ProjectManifest = { ...finished, htmlLimitedBots: '(?:MyBot|Crawler+)+' };

    expect(answer('/built', browser, grouped)).toBe('document');
    expect(answer('/about', browser, grouped)).toBe('html-limited-bots');
    expect(answer('/elsewhere', browser, grouped)).toBe('html-limited-bots');
  });

  /** The middleware may rewrite a pathname no route names onto a shell. */
  it('is passed on from a pathname that names no route', () => {
    expect(answer('/elsewhere', browser)).toBe('bot');
    expect(answer('/elsewhere', {})).toBe('route-not-proved');
  });

  /** Only a navigation the edge would answer is judged by the application's pattern. */
  it('is judged after everything else that sends a request on', () => {
    expect(answer('/about', { ...browser, 'sec-fetch-dest': 'empty' })).toBe('sec-fetch-dest');
    expect(answer('/about', { ...browser, cookie: '__prerender_bypass=1' })).toBe('bypass-cookie');
  });
});

describe('accept negotiation', () => {
  it('proxies a request that scored HTML zero', () => {
    // The origin would negotiate something else or answer 406; a shell would replace that.
    expect(
      reasonOf(classify('/about', { headers: { accept: 'application/json, text/html;q=0' } })),
    ).toBe('accept');
  });

  it('still serves a browser navigation', () => {
    const accept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

    expect(classify('/about', { headers: { accept } }).kind).toBe('document');
  });
});

/** The application, with the whole payload of `/about` held for the edge to answer with. */
const PAYLOAD: RouteEntry['payload'] = {
  artifact: {
    sha256: 'b'.repeat(64),
    byteLength: 20,
    contentType: 'text/x-component',
    encoding: 'identity',
  },
};
const PAYLOAD_SITE = {
  crawlersStreamed: true,
  projectId: 's',
  runId: 'r',
  generatedAt: OBSERVED_AT,
  originHost: 'example.com',
  deployment,
  routes: [
    { ...entry, payload: PAYLOAD },
    { ...entry, pathname: '/other' },
  ],
  app: { deploymentId: 'dpl_active', scriptName: 'app-1' },
} as const;
const withPayload = buildProjectManifest(PAYLOAD_SITE);

/** A request of the client's router for `path`, which carries no navigation's metadata. */
function routerRequest(
  path: string,
  init: ClassifyInit = {},
  site: ProjectManifest = withPayload,
): RequestClass {
  return classifyRequest({
    method: init.method ?? 'GET',
    url: new URL(`https://site.example.app${path}`),
    headers: new Headers({ rsc: '1', ...init.headers }),
    manifest: site,
    deployment,
  });
}

describe('a router’s request for a page’s whole payload', () => {
  it('is one at a route that holds the payload, as the router sends it', () => {
    const asked = routerRequest('/about?_rsc=1x2y3', {
      headers: {
        'next-router-state-tree': '%5B%22%22%5D',
        'next-url': '/',
        'x-deployment-id': 'dpl_active',
      },
    });

    expect(asked).toStrictEqual({ kind: 'rsc-payload', entry: withPayload.routes['/about'] });
    expect(routerRequest('/about', { headers: { 'next-router-prefetch': '1' } }).kind).toBe(
      'rsc-payload',
    );
  });

  /** As every other request for React Server Components: straight to the Function. */
  it('stays rsc at a route that holds none, and at a pathname that names none', () => {
    expect(routerRequest('/other').kind).toBe('rsc');
    expect(routerRequest('/missing').kind).toBe('rsc');
  });

  it('can select a cache-backed partial route before the build has a whole RSC payload', () => {
    const cached = buildProjectManifest({
      ...PAYLOAD_SITE,
      cache: { keySchemaVersion: 1, scopeId: 'dpl_parts' },
      routes: [{ ...entry, cache: { entryId: 'ent_parts', kind: 'app-page', delivery: 'resume' } }],
    });

    expect(routerRequest('/about', {}, cached).kind).toBe('rsc-payload');
    expect(routerRequest('/about', { headers: { 'next-resume': '1' } }, cached).kind).toBe('rsc');
  });

  /** Reported as they were: a request the gates turn away is what it always was. */
  it('stays rsc where a gate a prefetch passes turns it away', () => {
    expect(routerRequest('/about', { headers: { 'x-deployment-id': 'dpl_old' } }).kind).toBe('rsc');
    expect(routerRequest('/about', { headers: { cookie: '__prerender_bypass=1' } }).kind).toBe(
      'rsc',
    );
    expect(routerRequest('/about', { headers: { 'next-resume': '1' } }).kind).toBe('rsc');
    expect(routerRequest('/about?dpl=dpl_old').kind).toBe('rsc');
    expect(routerRequest('/about?__prerender_bypass=x').kind).toBe('rsc');
    expect(routerRequest('//about').kind).toBe('rsc');
  });

  it('is a HEAD as it is a GET, and leaves a prefetch of part of the page to its own class', () => {
    expect(routerRequest('/about', { method: 'HEAD' }).kind).toBe('rsc-payload');
    expect(
      routerRequest('/about', { headers: { 'next-router-segment-prefetch': '/_tree' } }).kind,
    ).toBe('segment-prefetch');
    // An empty one names no part, and Next.js answers it as a part it has none of: not the page.
    expect(routerRequest('/about', { headers: { 'next-router-segment-prefetch': '' } }).kind).toBe(
      'rsc',
    );
  });

  /**
   * Only an exact route holds a payload, so only the exact routes are looked in: a member of a
   * dynamic route is never served its class's, and no dynamic pattern is tested for the request.
   */
  it('stays rsc at a member of a dynamic route, whatever its class holds', () => {
    const classed = buildProjectManifest({
      ...PAYLOAD_SITE,
      routes: [...PAYLOAD_SITE.routes, { ...entry, pathname: '/blog/[slug]', payload: PAYLOAD }],
      dynamicRoutes: [{ sourceRegex: '^/blog/(?<slug>[^/]+?)(?:/)?$', route: '/blog/[slug]' }],
    });

    expect(routerRequest('/blog/post', {}, classed).kind).toBe('rsc');
    expect(routerRequest('/about', {}, classed).kind).toBe('rsc-payload');
  });

  /** An intercepting route answers the router there, by `next-url`: a rule ahead of the filesystem. */
  it('stays rsc where a rule ahead of the filesystem claims the page for the request', () => {
    const intercepted = buildProjectManifest({
      ...PAYLOAD_SITE,
      reservedRoutes: [
        {
          sourceRegex: '^/about$',
          beforeFiles: true,
          has: [{ type: 'header', key: 'next-url', value: '/feed' }],
        },
      ],
    });

    expect(routerRequest('/about', { headers: { 'next-url': '/feed' } }, intercepted).kind).toBe(
      'rsc',
    );
    expect(routerRequest('/about', { headers: { 'next-url': '/' } }, intercepted).kind).toBe(
      'rsc-payload',
    );
  });
});

const PROPS: RouteEntry['pagesData'] = {
  artifact: {
    sha256: 'c'.repeat(64),
    byteLength: 30,
    contentType: 'application/json',
    encoding: 'identity',
  },
};
const PAGES_DATA_ROUTES = [
  { ...entry, pagesData: PROPS },
  { ...entry, pathname: '/' },
];
/** The application with the props of its Pages Router page `/about` held for the edge. */
const PAGES_DATA_SITE = buildProjectManifest({
  ...PAYLOAD_SITE,
  routes: PAGES_DATA_ROUTES,
  pagesDataUnder: { basePath: '', buildId: 'build-1' },
});

/** The application keeping its pages behind the slash, `/about/` holding props. */
const SLASHED_SITE = buildProjectManifest({
  ...PAYLOAD_SITE,
  routes: [{ ...entry, pathname: '/about/', pagesData: PROPS }],
  trailingSlash: true,
  pagesDataUnder: { basePath: '', buildId: 'build-1' },
});

/** The application under a base path a request percent-encodes, `/日本/about` holding props. */
const ENCODED_SITE = buildProjectManifest({
  ...PAYLOAD_SITE,
  routes: [{ ...entry, pathname: '/日本/about', pagesData: PROPS }],
  pagesDataUnder: { basePath: '/日本', buildId: 'build-1' },
});

/** The application with its page `/index/foo` holding props. */
const INDEXED_SITE = buildProjectManifest({
  ...PAYLOAD_SITE,
  routes: [{ ...entry, pathname: '/index/foo', pagesData: PROPS }],
  pagesDataUnder: { basePath: '', buildId: 'build-1' },
});

/** The application under a base path that holds `/_next/data/`, its `about` page holding props. */
const SHOP_SITE = buildProjectManifest({
  ...PAYLOAD_SITE,
  routes: [{ ...entry, pathname: '/shop/_next/data/archive/about', pagesData: PROPS }],
  pagesDataUnder: { basePath: '/shop/_next/data/archive', buildId: 'build-1' },
});

/** The application with a dynamic route whose class shell, as no build writes it, holds props. */
const CLASSED_SITE = buildProjectManifest({
  ...PAYLOAD_SITE,
  routes: [...PAGES_DATA_ROUTES, { ...entry, pathname: '/blog/[slug]', pagesData: PROPS }],
  dynamicRoutes: [{ sourceRegex: '^/blog/(?<slug>[^/]+?)(?:/)?$', route: '/blog/[slug]' }],
  pagesDataUnder: { basePath: '', buildId: 'build-1' },
});

/** A Pages Router client's request for the props at `path`, as its router sends one. */
function dataRequest(
  path: string,
  init: ClassifyInit = {},
  site: ProjectManifest = PAGES_DATA_SITE,
): RequestClass {
  return classifyRequest({
    method: init.method ?? 'GET',
    url: new URL(`https://site.example.app${path}`),
    headers: new Headers({ 'x-nextjs-data': '1', ...init.headers }),
    manifest: site,
    deployment,
  });
}

const ABOUT_DATA = '/_next/data/build-1/about.json';

/** The application, with a rule ahead of the filesystem for every path `sourceRegex` matches. */
function claiming(sourceRegex: string): ProjectManifest {
  return { ...PAGES_DATA_SITE, reservedRoutes: [{ sourceRegex, beforeFiles: true }] };
}

/** The application, with a rule ahead of the filesystem for its data path that has, or misses, `x-nextjs-data`. */
function onDataHeader(condition: 'has' | 'missing'): ProjectManifest {
  const rule = {
    sourceRegex: '^/_next/data/(.*)$',
    beforeFiles: true as const,
    [condition]: [{ type: 'header' as const, key: 'x-nextjs-data' }],
  };
  return { ...PAGES_DATA_SITE, reservedRoutes: [rule] };
}

describe('a Pages Router client’s request for a page’s props', () => {
  it('is one at the build’s own data path of a page that holds them', () => {
    expect(dataRequest('/_next/data/build-1/about.json')).toStrictEqual({
      kind: 'pages-data',
      entry: PAGES_DATA_SITE.routes['/about'],
    });
    expect(dataRequest('/_next/data/build-1/about.json', { method: 'HEAD' }).kind).toBe(
      'pages-data',
    );
  });

  /** Another build's, a page with no props here, a spelling the build never writes: the Function's. */
  it('stays with the Function for anything else under the data path', () => {
    expect(reasonOf(dataRequest('/_next/data/build-0/about.json'))).toBe('next-internal');
    expect(reasonOf(dataRequest('/_next/data/build-1/index.json'))).toBe('next-internal');
    expect(reasonOf(dataRequest('/_next/data/build-1/index/about.json'))).toBe('next-internal');
    expect(reasonOf(dataRequest('/_next/data/build-1/about'))).toBe('next-internal');
  });

  it('stays with the Function where a gate turns it away', () => {
    expect(reasonOf(dataRequest(ABOUT_DATA, { headers: { cookie: '__prerender_bypass=1' } }))).toBe(
      'next-internal',
    );
    expect(reasonOf(dataRequest(ABOUT_DATA, { headers: { 'next-resume': '1' } }))).toBe(
      'next-internal',
    );
    expect(reasonOf(dataRequest(`${ABOUT_DATA}?dpl=dpl_old`))).toBe('next-internal');
  });

  /**
   * The client sends the deployment it was built for with each request for props (`fetchNextData`),
   * a prefetch's as well: the one this host serves is a request like any, and another is the
   * Function's to settle, as a router's request is.
   */
  it('reads the deployment the client names as a pin, and a prefetch as a request', () => {
    const current = { 'x-deployment-id': 'dpl_active', purpose: 'prefetch' };

    expect(dataRequest(ABOUT_DATA, { headers: current }).kind).toBe('pages-data');
    expect(reasonOf(dataRequest(ABOUT_DATA, { headers: { 'x-deployment-id': 'dpl_old' } }))).toBe(
      'next-internal',
    );
  });

  /**
   * Next.js's routing matches a data URL as it is in a build that holds props (`routePagesData`):
   * a rule ahead of the filesystem claims one it holds for, and one that holds for the page alone
   * leaves the page's props to the build.
   */
  it('is claimed by a rule ahead of the filesystem that holds for its own URL', () => {
    const claimsData = claiming('^/_next/data/(.*)$');
    const claimsPage = claiming('^/about$');

    expect(reasonOf(dataRequest(ABOUT_DATA, {}, claimsData))).toBe('next-internal');
    expect(dataRequest(ABOUT_DATA, {}, claimsPage).kind).toBe('pages-data');
  });

  /** Where the application keeps its pages behind the slash, its routes are named with it. */
  it('finds the page by the spelling the manifest names it by', () => {
    expect(dataRequest(ABOUT_DATA, {}, SLASHED_SITE)).toStrictEqual({
      kind: 'pages-data',
      entry: SLASHED_SITE.routes['/about/'],
    });
  });

  /** Next.js writes a page's props under its own name, which a slash before `.json` is not. */
  it('stays with the Function for a slash before `.json`', () => {
    const slashedData = '/_next/data/build-1/about/.json';

    expect(reasonOf(dataRequest(slashedData, {}, SLASHED_SITE))).toBe('next-internal');
  });

  /** A base path a request percent-encodes: the prefix is spelled so, and the route found decoded. */
  it('is one under a base path the request percent-encodes', () => {
    const asked = '/日本/_next/data/build-1/about.json';

    expect(dataRequest(asked, {}, ENCODED_SITE)).toStrictEqual({
      kind: 'pages-data',
      entry: ENCODED_SITE.routes['/日本/about'],
    });
  });

  /** A base path may hold `/_next/data/` itself: the page is named under the one the manifest names. */
  it('is one under a base path that holds `/_next/data/`', () => {
    const asked = '/shop/_next/data/archive/_next/data/build-1/about.json';

    expect(dataRequest(asked, {}, SHOP_SITE)).toStrictEqual({
      kind: 'pages-data',
      entry: SHOP_SITE.routes['/shop/_next/data/archive/about'],
    });
  });

  /**
   * An escaped slash keeps a parameter's value in one segment, as Next.js names the page: it asks
   * for no page whose name has the slash, `/index/foo` among them, whose props are asked for at
   * `/index/index/foo.json`.
   */
  it('looks a page up by its name exactly, an escaped slash and all', () => {
    const escaped = '/_next/data/build-1/index%2Ffoo.json';

    expect(reasonOf(dataRequest(escaped, {}, INDEXED_SITE))).toBe('next-internal');
    expect(dataRequest('/_next/data/build-1/index/index/foo.json', {}, INDEXED_SITE).kind).toBe(
      'pages-data',
    );
  });

  /** Only an exact route holds props: a member of a class is never answered with its class's. */
  it('stays with the Function at a member of a dynamic route, whatever its class holds', () => {
    const member = dataRequest('/_next/data/build-1/blog/post.json', {}, CLASSED_SITE);

    expect(reasonOf(member)).toBe('next-internal');
    expect(dataRequest(ABOUT_DATA, {}, CLASSED_SITE).kind).toBe('pages-data');
  });

  /** A manifest that names no prefix holds no props for a reader, whatever its routes say. */
  it('stays with the Function on a manifest that names no prefix', () => {
    const unnamed = { ...PAGES_DATA_SITE, pagesDataPrefix: undefined };

    expect(reasonOf(dataRequest(ABOUT_DATA, {}, unnamed))).toBe('next-internal');
  });

  /**
   * The deployment's routing takes `x-nextjs-data` from no client: it drops the client's and puts
   * its own on a request at a data path. A rule conditioned on it is judged so.
   */
  it('judges a rule on `x-nextjs-data` as the routing sets it, not as the client sent it', () => {
    const withoutHeader = { headers: { 'x-nextjs-data': '' } };
    const claimed = dataRequest(ABOUT_DATA, withoutHeader, onDataHeader('has'));
    const left = dataRequest(ABOUT_DATA, withoutHeader, onDataHeader('missing'));

    expect(reasonOf(claimed)).toBe('next-internal');
    expect(left.kind).toBe('pages-data');
  });
});

/** The application's props held as `PAGES_DATA_ROUTES` holds them, with `fields` over the input. */
function propsSite(fields: {
  routes?: RouteEntry[];
  pagesDataUnder?: { basePath: string; buildId: string };
}): ProjectManifest {
  return buildProjectManifest({ ...PAYLOAD_SITE, routes: PAGES_DATA_ROUTES, ...fields });
}

/** Where a manifest says a client asks for a page's props, and which routes hold them. */
describe('a manifest that holds a page’s props', () => {
  /** Props asked for at no URL would leave every data request with the Function, unsaid. */
  it('is refused where it is built when it names props and nowhere to ask for them', () => {
    expect(() => propsSite({})).toThrow(/no pagesDataUnder/u);
  });

  it.each([
    ['', ''],
    ['', 'build-1/'],
    ['', '/build-1'],
    ['', 'release//123'],
    ['', 'a/../b'],
    ['', String.raw`a\b`],
    ['docs', 'build-1'],
    ['/docs/', 'build-1'],
    ['/a//b', 'build-1'],
    ['/a/../b', 'build-1'],
  ])('is refused where it is built under base path %j and build %j', (basePath, buildId) => {
    expect(() => propsSite({ pagesDataUnder: { basePath, buildId } })).toThrow(/names no prefix/u);
  });

  it('names nowhere to ask where no route’s props sit', () => {
    const routes = [entry, { ...entry, pathname: '/' }];
    const under = { basePath: '', buildId: 'build-1' };

    expect(propsSite({ routes, pagesDataUnder: under }).pagesDataPrefix).toBeUndefined();
  });

  /** The prefix as a request spells it, and the base path beside it as the build wrote it. */
  it('names the prefix, and the base path it is under', () => {
    const plain = propsSite({ pagesDataUnder: { basePath: '', buildId: 'build-1' } });
    const based = propsSite({ pagesDataUnder: { basePath: '/日本', buildId: 'release/123' } });

    expect(plain.pagesDataPrefix).toBe('/_next/data/build-1');
    expect(plain.pagesDataBasePath).toBeUndefined();
    expect(based.pagesDataPrefix).toBe('/%E6%97%A5%E6%9C%AC/_next/data/release/123');
    expect(based.pagesDataBasePath).toBe('/日本');
  });
});

/** What a navigation to `path` of `hosted` is served: a route, a file, or why it is passed on. */
function served(hosted: ProjectManifest, path: string): string {
  const classified = classifyRequest({
    method: 'GET',
    url: new URL(`https://site.example.app${path}`),
    headers: new Headers(NAVIGATION),
    manifest: hosted,
    deployment,
  });
  if (classified.kind === 'document') {
    return `document ${classified.entry.pathname}`;
  }
  return classified.kind === 'static-file' ? 'static-file' : (reasonOf(classified) ?? '');
}

/**
 * Next.js's router reads the base path, and the locale behind it, as a path writes them, before it
 * decodes anything: it finds no locale in front of `/%65n/about` and routes it as `/en/%65n/about`,
 * and no base path in front of `/b%61se/about`, and answers both 404. The edge decodes no page or
 * file out of such a path, and leaves it to the Function, which routes it as Next.js does.
 */
describe('a path that writes the base path or a locale escaped', () => {
  const FILE: StaticFileEntry = {
    sha256: 'b'.repeat(64),
    byteLength: 1,
    contentType: 'text/html',
    immutable: false,
  };

  /** An application whose pages are `routes` and whose files are `files`, under `spelledPrefix`. */
  function hosting(
    routes: readonly string[],
    files: readonly string[],
    spelledPrefix: { basePath: string; locales?: string[] },
  ): ProjectManifest {
    return buildProjectManifest({
      crawlersStreamed: true,
      projectId: 's',
      runId: 'r',
      generatedAt: OBSERVED_AT,
      originHost: 'example.com',
      deployment,
      routes: routes.map((pathname) => ({ ...entry, pathname })),
      staticFiles: Object.fromEntries(files.map((pathname) => [pathname, FILE])),
      app: { deploymentId: 'dpl_active', scriptName: 'app-1' },
      spelledPrefix,
    });
  }

  it('serves no page or file of a locale the path escapes', () => {
    const localized = hosting(['/en/about', '/en/a b'], ['/en/static'], {
      basePath: '',
      locales: ['en', 'fr'],
    });

    expect(served(localized, '/en/about')).toBe('document /en/about');
    expect(served(localized, '/en/a%20b')).toBe('document /en/a b');
    expect(served(localized, '/en/static')).toBe('static-file');
    expect(served(localized, '/%65n/about')).toBe('route-not-proved');
    expect(served(localized, '/en%2Fabout')).toBe('route-not-proved');
    expect(served(localized, '/%65n/static')).toBe('route-not-proved');
  });

  it('serves no page or file under a base path the path escapes', () => {
    const based = hosting(['/base/about'], ['/base/x.png'], { basePath: '/base' });

    expect(served(based, '/base/about')).toBe('document /base/about');
    expect(served(based, '/base/x%2Epng')).toBe('static-file');
    expect(served(based, '/b%61se/about')).toBe('route-not-proved');
    expect(served(based, '/b%61se/x.png')).toBe('route-not-proved');
  });

  /**
   * A file kept from the deployment before, under the base path that deployment had, is no file
   * under the base path of this one: what the router reads of this one's path as written says
   * nothing of it, and it is found decoded, as a browser escapes a base path past ASCII.
   */
  it('serves a file kept under the base path the deployment before had', () => {
    const moved = hosting([], [], { basePath: '/base' });
    const kept = { ...FILE, deploymentId: 'dpl_before' };
    const withKept = { ...moved, staticFiles: { '/日本/_next/static/a.js': kept } };

    expect(served(withKept, '/%E6%97%A5%E6%9C%AC/_next/static/a.js?dpl=dpl_before')).toBe(
      'static-file',
    );
  });
});
