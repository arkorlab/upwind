import type { HeaderRule } from '@stayingupwind/core/manifest';
import { REVALIDATE_CACHE_CONTROL } from '@stayingupwind/core/request';
import { DEFAULT_DELIVERY_POLICY, type EdgePointer } from '@stayingupwind/host/delivery';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { createEdgeMemory } from '../src/memory/caches.ts';
import { serveFromPointer } from '../src/route.ts';
import { handleStandalone, standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import { navigation, pprDocument, seedSite, type SiteOptions } from './helpers/site.ts';

const APP = { deploymentId: 'dpl_site', scriptName: 'site-app' };

/**
 * A shipped file of a build with `i18n`, whose rules of `next.config` the edge does not judge on
 * each request, answered with what the unconditional ones set on it — stored on its entry when the
 * manifest was written (`StaticFileEntry.headers`), and laid on the answer as the rules the edge
 * judges itself are: no rule is matched for them here.
 */

const FILE = '/robots.txt';
const PLAIN = '/humans.txt';
const BODY = 'User-agent: *';
const POLICY = "default-src 'none'; frame-ancestors 'none'";
const TEXT = 'text/plain; charset=utf-8';
/** What a build with `i18n` stores on a file a catch-all security policy of its covers. */
const STORED = {
  'content-security-policy': POLICY,
  'cross-origin-resource-policy': 'same-origin',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};
/** A rule as such a build folds it into its routes' headers rather than publish it. */
const FOLDED: HeaderRule = {
  sourceRegex: String.raw`^(?:\/(en|fr))(?:\/((?:[^\/]+?)(?:\/(?:[^\/]+?))*))?(?:\/)?$`,
  headers: STORED,
};

async function serve(
  pointer: EdgePointer,
  path: string,
  init: RequestInit = {},
): Promise<{ readonly response: Response; readonly body: string }> {
  const site = { ...env, POINTER: JSON.stringify(pointer) };
  const ctx = createExecutionContext();
  const runtime = standaloneRuntime(site, { memory: createEdgeMemory(() => Date.now()) });
  const response = await handleStandalone(navigation(path, init), site, ctx, runtime);
  const body = await response.text();
  await waitOnExecutionContext(ctx);
  return { response, body };
}

async function localized(
  fileHeaders: SiteOptions['fileHeaders'],
  headerRules?: SiteOptions['headerRules'],
): Promise<EdgePointer> {
  const { pointer } = await seedSite({
    document: pprDocument(),
    files: { [FILE]: BODY, [PLAIN]: BODY },
    fileHeaders,
    foldedHeaderRules: [FOLDED],
    headerRules,
  });
  return pointer;
}

function picked(response: Response, names: readonly string[]): Record<string, string | null> {
  return Object.fromEntries(names.map((name) => [name, response.headers.get(name)]));
}

describe('a shipped file of a build whose rules the edge does not judge', () => {
  it('is answered with the headers stored on it, a HEAD and a 304 as well', async () => {
    const pointer = await localized({ [FILE]: STORED });
    const names = Object.keys(STORED);

    const got = await serve(pointer, FILE);
    const head = await serve(pointer, FILE, { method: 'HEAD' });
    const etag = got.response.headers.get('etag') ?? '';
    const unchanged = await serve(pointer, FILE, { headers: { 'if-none-match': etag } });

    expect([got.response.status, got.body]).toStrictEqual([200, BODY]);
    expect(picked(got.response, names)).toStrictEqual(STORED);
    expect(picked(head.response, names)).toStrictEqual(STORED);
    expect(unchanged.response.status).toBe(304);
    expect(picked(unchanged.response, names)).toStrictEqual(STORED);
  });

  it('is answered as before where its entry stores nothing', async () => {
    const pointer = await localized({ [FILE]: STORED });

    const { response, body } = await serve(pointer, PLAIN);

    expect([response.status, body]).toStrictEqual([200, BODY]);
    expect(picked(response, Object.keys(STORED))).toStrictEqual({
      'content-security-policy': null,
      'cross-origin-resource-policy': null,
      'x-content-type-options': null,
      'x-frame-options': null,
    });
    expect(picked(response, ['content-type', 'cache-control'])).toStrictEqual({
      'content-type': TEXT,
      'cache-control': REVALIDATE_CACHE_CONTROL,
    });
  });

  /**
   * As a rule the edge judges itself does: over the file's own lifetime and its type, and over a
   * rule of the ones it judges that names the same header, since what is stored is every
   * unconditional rule in Next.js's order, those among them. Never over what describes the bytes on
   * the wire — their length and coding are the edge's account of what it sends, whatever an entry
   * says, as they are whatever a rule it judges says (`SHIPPED_FILE_ENTITY_HEADERS`).
   */
  it('takes what is stored over the defaults, never over what describes the bytes', async () => {
    const judged: HeaderRule = {
      sourceRegex: String.raw`^\/robots\.txt$`,
      headers: { 'x-frame-options': 'SAMEORIGIN', 'x-judged': 'yes' },
      phase: 'beforeMiddleware',
    };
    const pointer = await localized(
      {
        [FILE]: {
          'cache-control': 'public, max-age=60',
          'x-frame-options': 'DENY',
          'content-type': 'application/json',
          'content-length': '1',
          'content-encoding': 'gzip',
        },
      },
      [judged],
    );

    const { response, body } = await serve(pointer, FILE);

    expect(body).toBe(BODY);
    expect(
      picked(response, [
        'cache-control',
        'x-frame-options',
        'x-judged',
        'content-type',
        'content-length',
        'content-encoding',
      ]),
    ).toStrictEqual({
      'cache-control': 'public, max-age=60',
      'x-frame-options': 'DENY',
      'x-judged': 'yes',
      'content-type': 'application/json',
      'content-length': String(BODY.length),
      'content-encoding': null,
    });
  });

  /** What is stored is read off the entry in hand: a manifest with no rule at all still has it. */
  it('needs no rule of the manifest to be judged for it', async () => {
    const { pointer, manifest } = await seedSite({
      document: pprDocument(),
      files: { [FILE]: BODY },
      fileHeaders: { [FILE]: STORED },
    });

    const { response } = await serve(pointer, FILE);

    expect(manifest.headerRules).toBeUndefined();
    expect(manifest.foldedHeaderRules).toBeUndefined();
    expect(picked(response, Object.keys(STORED))).toStrictEqual(STORED);
  });
});

/** What the edge answers a request for the file with, a middleware answering `answer` on its path. */
async function throughMiddleware(
  answer: (request: Request) => Response,
): Promise<{ readonly response: Response; readonly body: string }> {
  const site = await seedSite({
    document: pprDocument(),
    files: { [FILE]: BODY, [PLAIN]: 'humans' },
    fileHeaders: { [FILE]: STORED, [PLAIN]: { 'x-other': 'humans' } },
    foldedHeaderRules: [FOLDED],
  });
  const request = navigation(FILE);
  const ctx = createExecutionContext();
  try {
    const response = await serveFromPointer(
      {
        request,
        url: new URL(request.url),
        env,
        ctx,
        runtime: standaloneRuntime(env, {
          memory: createEdgeMemory(() => Date.now()),
          dispatchApp: (_script, sent) => Promise.resolve(answer(sent)),
        }),
        host: standaloneHost(env),
        pointer: {
          ...site.pointer,
          app: { ...APP, middlewareScriptName: 'site-middleware' },
        },
        pointerMs: 0,
        privateDelivery: false,
        cspReportingPath: undefined,
      },
      {
        manifestLookup: Promise.resolve({
          kind: 'found',
          value: { ...site.manifest, middleware: { matchers: [{ sourceRegex: '^/.*$' }] } },
        }),
        policyLookup: Promise.resolve({
          kind: 'found',
          source: 'exact',
          policy: DEFAULT_DELIVERY_POLICY,
        }),
      },
    );
    return { response, body: await response.text() };
  } finally {
    await waitOnExecutionContext(ctx);
  }
}

/**
 * Next.js's router collects the rules on the path asked for before the middleware runs, and lays
 * them on whatever answers it (`resolve-routes.js`, `router-server.js`): the file, another file the
 * middleware rewrote the request to, or an answer the middleware gave itself.
 */
describe('a shipped file the middleware has a say on', () => {
  it('keeps those of the file asked for where a rewrite lands it on another', async () => {
    const { response, body } = await throughMiddleware((sent) => {
      return new Response(null, {
        headers: { 'x-middleware-rewrite': new URL(PLAIN, sent.url).href },
      });
    });

    expect([response.status, body]).toStrictEqual([200, 'humans']);
    expect(picked(response, Object.keys(STORED))).toStrictEqual(STORED);
    expect(response.headers.has('x-other')).toBe(false);
  });

  it('lays them under an answer the middleware gives itself', async () => {
    const { response, body } = await throughMiddleware(
      () => new Response('refused', { status: 403, headers: { 'x-frame-options': 'SAMEORIGIN' } }),
    );

    expect([response.status, body]).toStrictEqual([403, 'refused']);
    expect(picked(response, Object.keys(STORED))).toStrictEqual({
      ...STORED,
      'x-frame-options': 'SAMEORIGIN',
    });
  });
});

/**
 * A file of the build's `_next` is asked for under the application's asset prefix by its pages, and
 * by its own name where nothing prefixes it: the rules are judged on the path asked for, so an entry
 * stores the prefixed spelling's set apart where the two differ (`assetPrefixHeaders`), and the edge
 * answers each spelling with its own.
 */
describe('a file of the build asked for under the asset prefix', () => {
  const chunk = '/_next/static/chunks/main.js';
  const shared = '/_next/static/chunks/shared.js';
  const own = { 'x-canonical': 'yes', 'x-frame-options': 'DENY' };
  const prefixed = { 'x-prefixed': 'yes', 'x-frame-options': 'DENY' };

  async function prefixedSite(): Promise<EdgePointer> {
    const { pointer } = await seedSite({
      document: pprDocument(),
      files: { [chunk]: 'main', [shared]: 'shared' },
      fileHeaders: { [chunk]: own, [shared]: { 'x-frame-options': 'DENY' } },
      filePrefixedHeaders: { [chunk]: prefixed },
      foldedHeaderRules: [FOLDED],
      staticFileAssetPrefix: { basePath: '', assetPrefix: '/assets' },
    });
    return pointer;
  }

  it('answers each spelling with the set stored for it', async () => {
    const pointer = await prefixedSite();
    const names = ['x-canonical', 'x-prefixed', 'x-frame-options'];

    const asNamed = await serve(pointer, chunk);
    const asPrefixed = await serve(pointer, `/assets${chunk}`);

    expect([asNamed.body, asPrefixed.body]).toStrictEqual(['main', 'main']);
    expect(picked(asNamed.response, names)).toStrictEqual({ ...own, 'x-prefixed': null });
    expect(picked(asPrefixed.response, names)).toStrictEqual({ ...prefixed, 'x-canonical': null });
  });

  /** One whose spellings the rules set alike stores one set, which answers both. */
  it('answers both spellings of a file that stores one set with it', async () => {
    const pointer = await prefixedSite();

    const asNamed = await serve(pointer, shared);
    const asPrefixed = await serve(pointer, `/assets${shared}`);

    expect(asNamed.response.headers.get('x-frame-options')).toBe('DENY');
    expect(asPrefixed.response.headers.get('x-frame-options')).toBe('DENY');
  });
});

/** A build whose rules the edge judges on each request stores nothing on its files. */
describe('a shipped file of a build whose rules the edge judges', () => {
  it('is answered with the rules it judges, as before', async () => {
    const { pointer } = await seedSite({
      document: pprDocument(),
      files: { [FILE]: BODY },
      headerRules: [{ sourceRegex: String.raw`^\/robots\.txt$`, headers: STORED }],
    });

    const { response, body } = await serve(pointer, FILE);

    expect([response.status, body]).toStrictEqual([200, BODY]);
    expect(picked(response, Object.keys(STORED))).toStrictEqual(STORED);
    expect(response.headers.get('cache-control')).toBe(REVALIDATE_CACHE_CONTROL);
  });

  /**
   * One list of what no rule replaces on a shipped file (`SHIPPED_FILE_ENTITY_HEADERS`), for the
   * rules judged here as for what an entry stores: the type a rule may set — an extensionless
   * `public/` file is given one so — the length and the coding it may not.
   */
  it('takes the type a rule sets, never the length or the coding', async () => {
    const { pointer } = await seedSite({
      document: pprDocument(),
      files: { [FILE]: BODY },
      headerRules: [
        {
          sourceRegex: String.raw`^\/robots\.txt$`,
          headers: {
            'content-type': 'application/json',
            'content-length': '1',
            'content-encoding': 'gzip',
          },
        },
      ],
    });

    const { response, body } = await serve(pointer, FILE);

    expect(body).toBe(BODY);
    expect(picked(response, ['content-type', 'content-length', 'content-encoding'])).toStrictEqual({
      'content-type': 'application/json',
      'content-length': String(BODY.length),
      'content-encoding': null,
    });
  });
});
