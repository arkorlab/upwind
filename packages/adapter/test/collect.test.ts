import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Route, Routing, StaticFile } from '@stayingupwind/core/bundle';
import type { AdapterOutput } from 'next';
import type { RenderingMode } from 'next/dist/build/rendering-mode.js';
import { AdapterOutputType } from 'next/dist/shared/lib/constants.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BlobStore } from '../src/blobs.ts';
import { bundleConfig } from '../src/bundle-config.ts';
import {
  type BuildContext,
  collectEntrypoints,
  collectPrerenders,
  edgeEntryOf,
  exportedPathname,
  imagesConfig,
  immutableByBuild,
  middlewareOutput,
  tracedWasm,
} from '../src/collect.ts';
import { ensureStaticRoutes } from '../src/ensure-static.ts';
import { nftAssets, nftChunks, nftWasm } from '../src/nft.ts';
import { collectStaticFiles, rewriteTargetFiles } from '../src/static-files.ts';
import { tracedFiles } from '../src/traced-files.ts';

/**
 * What the adapter makes of `onBuildComplete`, output by output: which fields it carries into
 * the bundle, which it refuses, and which it leaves alone. The contexts here are synthetic and
 * name only the fields the adapter reads (README, "What the adapter reads").
 */

type Outputs = BuildContext['outputs'];
type RouteFields = AdapterOutput['APP_PAGE'];

function route(fields: Partial<RouteFields> & { pathname: string }): RouteFields {
  return {
    id: fields.pathname,
    filePath: `/project/.next/server/app${fields.pathname}/page.js`,
    // As Next.js states an App Router source page: the app path, ending in the file itself.
    sourcePage: `${fields.pathname === '/' ? '' : fields.pathname}/page`,
    runtime: 'nodejs',
    assets: {},
    assetsHashes: {},
    config: {},
    type: AdapterOutputType.APP_PAGE,
    ...fields,
  };
}

/** A page of the Pages Router, as `next build` describes one. */
function pagesRoute(fields: Partial<RouteFields> & { pathname: string }): AdapterOutput['PAGES'] {
  return { ...route(fields), type: AdapterOutputType.PAGES };
}

/** Where Turbopack puts the chunks of an entrypoint built for the edge runtime. */
const EDGE_CHUNKS = '/project/.next/server/edge/chunks';
/** A file such an entrypoint fetches as `blob:<name>`, by the name Next.js gives it. */
const EDGE_FONT = 'server/edge/assets/font.ttf';

/** A route as `next build` describes one it put on the edge runtime. */
function edgeRoute(fields: Partial<RouteFields> & { pathname: string }): RouteFields {
  const name = `app${fields.pathname}/route`;
  return {
    ...route(fields),
    runtime: 'edge',
    filePath: `${EDGE_CHUNKS}/entry.js`,
    assets: {
      'dep.js': `${EDGE_CHUNKS}/dep.js`,
      'entry.js': `${EDGE_CHUNKS}/entry.js`,
      [EDGE_FONT]: `/project/.next/${EDGE_FONT}`,
    },
    edgeRuntime: {
      modulePath: `${EDGE_CHUNKS}/entry.js`,
      entryKey: `middleware_${name}`,
      handlerExport: 'handler',
    },
    config: { env: { __NEXT_BUILD_ID: 'build-1' } },
    ...fields,
  };
}

function outputs(partial: Partial<Outputs>): Outputs {
  return {
    pages: [],
    appPages: [],
    pagesApi: [],
    appRoutes: [],
    prerenders: [],
    staticFiles: [],
    ...partial,
  };
}

type PrerenderOutput = AdapterOutput['PRERENDER'];

function prerender(fields: Partial<PrerenderOutput> & { id: string }): PrerenderOutput {
  // The classification is one of two shapes at once; the spread cannot say which.
  return {
    pathname: fields.id,
    type: AdapterOutputType.PRERENDER,
    parentOutputId: '/page',
    groupId: 1,
    route: '/page',
    config: {},
    ...fields,
  } as PrerenderOutput;
}

/**
 * What the routes manifest declares about prefetch segments, as `next build` hands it over. Only
 * the two suffixes the adapter reads are named (README, "What the adapter reads"), and they are the
 * values a build declares — `.segments` and `.segment.rsc` on both ends of the supported range.
 */
const rsc = {
  prefetchSegmentDirSuffix: '.segments',
  prefetchSegmentSuffix: '.segment.rsc',
} as BuildContext['routing']['rsc'];

/**
 * A prerender group as `next build` writes one, by the pathnames it gives its outputs: the document
 * first, and the outputs that travel beside it after. Only the document carries a classification —
 * which is what Next.js does, and what says which of them is which.
 */
function group(pathnames: readonly string[], sourceRoute = '/r'): Outputs['prerenders'] {
  return pathnames.map((pathname, index) => {
    return prerender({
      id: pathname,
      pathname,
      route: sourceRoute,
      parentOutputId: sourceRoute,
      ...(index === 0 && { routeType: 'page', response: 'complete', compute: 'static' }),
    });
  });
}

describe('collectEntrypoints', () => {
  it('names one entry per built module and its traced server chunks', () => {
    const chunk = '/project/.next/server/chunks/ssr/[root]__1.js';
    const collected = collectEntrypoints(
      outputs({
        appPages: [
          route({ pathname: '/', assets: { 'a.js': chunk, 'm.json': '/x/manifest.json' } }),
        ],
        appRoutes: [
          {
            ...route({ pathname: '/api/echo' }),
            type: AdapterOutputType.APP_ROUTE,
            assets: { 'a.js': chunk },
          },
        ],
      }),
    );

    expect(collected.entrypoints).toStrictEqual([
      { id: '/', kind: 'app-page', pathname: '/' },
      { id: '/api/echo', kind: 'app-route', pathname: '/api/echo' },
    ]);
    expect(collected.modules.map((module) => module.id)).toStrictEqual(['/', '/api/echo']);
    expect(collected.chunks).toStrictEqual([chunk]);
  });

  it('leaves out the .rsc twin of an app page: the same module under another name', () => {
    const collected = collectEntrypoints(
      outputs({ appPages: [route({ pathname: '/docs' }), route({ pathname: '/docs.rsc' })] }),
    );

    expect(collected.entrypoints.map((entry) => entry.id)).toStrictEqual(['/docs']);
  });

  it('collects a route on the edge runtime apart, with what it takes to invoke it', () => {
    const collected = collectEntrypoints(
      outputs({
        appPages: [route({ pathname: '/node' })],
        appRoutes: [
          {
            ...edgeRoute({ pathname: '/api/og' }),
            type: AdapterOutputType.APP_ROUTE,
          },
        ],
      }),
    );

    expect(collected.entrypoints).toStrictEqual([
      { id: '/node', kind: 'app-page', pathname: '/node' },
      { id: '/api/og', kind: 'app-route', pathname: '/api/og', runtime: 'edge' },
    ]);
    // Its module is not one the Worker can require, and its chunks are not the Node.js runtime's.
    expect(collected.modules.map((module) => module.id)).toStrictEqual(['/node']);
    expect(collected.chunks).toStrictEqual([]);
    expect(collected.edgeEntries).toStrictEqual([
      {
        id: '/api/og',
        entryKey: 'middleware_app/api/og/route',
        handlerExport: 'handler',
        // In the order Next.js lists them, which is the order its own runtime evaluates them in.
        files: [`${EDGE_CHUNKS}/dep.js`, `${EDGE_CHUNKS}/entry.js`],
        wasm: [],
        inlineAssets: [{ name: EDGE_FONT, filePath: `/project/.next/${EDGE_FONT}` }],
        env: { __NEXT_BUILD_ID: 'build-1' },
      },
    ]);
  });

  it('records where the build says each entrypoint was written, groups and all', () => {
    const collected = collectEntrypoints(
      outputs({
        appPages: [
          route({ pathname: '/terms', sourcePage: '/(site)/(legal)/terms/page' }),
          route({ pathname: '/terms.rsc', sourcePage: '/(site)/(legal)/terms/page' }),
        ],
        pages: [
          {
            ...route({ pathname: '/blog/[slug]', sourcePage: 'blog/[slug]' }),
            type: AdapterOutputType.PAGES,
          },
        ],
      }),
    );

    // Verbatim, in the two shapes Next.js emits: the App Router path keeps its leading slash and
    // its `page` file, the Pages Router one has neither. Nothing normalizes them here.
    expect(collected.sourcePages).toStrictEqual([
      { id: '/terms', sourcePage: '/(site)/(legal)/terms/page' },
      { id: '/blog/[slug]', sourcePage: 'blog/[slug]' },
    ]);
  });

  it('records no source for an output whose build named none', () => {
    const collected = collectEntrypoints(
      outputs({ appPages: [route({ pathname: '/docs', sourcePage: '' })] }),
    );

    expect(collected.entrypoints.map((entry) => entry.id)).toStrictEqual(['/docs']);
    expect(collected.sourcePages).toStrictEqual([]);
  });

  it('leaves the .rsc twin of an edge page out of the edge entries too', () => {
    const collected = collectEntrypoints(
      outputs({
        appPages: [edgeRoute({ pathname: '/docs' }), edgeRoute({ pathname: '/docs.rsc' })],
      }),
    );

    expect(collected.edgeEntries.map((entry) => entry.id)).toStrictEqual(['/docs']);
  });

  /**
   * A home rendered at request time has no prerender and no static file to answer the root in its
   * place, so the router has to find it by the root itself: `@next/routing` resolves a request
   * against the pathnames it is handed, and `/` is not `/index`.
   */
  it.each([
    ['/index', '/'],
    ['/docs/index', '/docs'],
  ])('collects the Pages Router home named %s under the root it answers', (named, root) => {
    const collected = collectEntrypoints(
      outputs({
        pages: [
          pagesRoute({ id: '/index', pathname: named }),
          pagesRoute({ id: '/index/index', pathname: `${named}/index` }),
        ],
      }),
    );

    // A page at `pages/index/index.js` answers `/index`, and is named for its own id.
    expect(collected.entrypoints.map((entry) => [entry.id, entry.pathname])).toStrictEqual([
      [root, root],
      [`${named}/index`, `${named}/index`],
    ]);
    expect(collected.modules.map((module) => module.id)).toStrictEqual([root, `${named}/index`]);
  });
});

describe('edgeEntryOf', () => {
  it('evaluates the entry chunk even when the build lists it nowhere else', () => {
    const output = edgeRoute({ pathname: '/edge', assets: { 'dep.js': `${EDGE_CHUNKS}/dep.js` } });

    expect(edgeEntryOf(output, '/edge').files).toStrictEqual([
      `${EDGE_CHUNKS}/dep.js`,
      `${EDGE_CHUNKS}/entry.js`,
    ]);
  });

  it('refuses an entry the build described no way of reaching', () => {
    const output = edgeRoute({ pathname: '/edge' });
    delete output.edgeRuntime;

    expect(() => edgeEntryOf(output, '/edge')).toThrow(/no edgeRuntime metadata/u);
  });

  it('carries the WebAssembly an entry bundles, under the global its chunks read it from', () => {
    // `wasmAssets` is keyed by the name Turbopack compiled the read against — its edge loader
    // takes a `() => wasm_<hash>` thunk — so the key is what the Worker has to publish.
    const output = edgeRoute({
      pathname: '/edge',
      wasmAssets: { wasm_57e7: '/project/.next/server/edge/chunks/add.wasm' },
    });

    expect(edgeEntryOf(output, '/edge').wasm).toStrictEqual([
      { global: 'wasm_57e7', filePath: '/project/.next/server/edge/chunks/add.wasm' },
    ]);
  });
});

describe('tracedWasm', () => {
  it('picks the WebAssembly out of a trace and leaves everything else', () => {
    // Nothing in the adapter's context says an output on the Node.js runtime uses WebAssembly;
    // the `.wasm` is one traced asset among the rest, and dropping it fails the route's first
    // request rather than the build.
    expect(
      tracedWasm({
        'chunks/a.js': '/project/.next/server/chunks/a.js',
        'chunks/add.wasm': '/project/.next/server/chunks/add.wasm',
        'og/resvg.wasm': '/project/node_modules/next/dist/compiled/@vercel/og/resvg.wasm',
        'also/add.wasm': '/project/.next/server/chunks/add.wasm',
      }),
    ).toStrictEqual([
      '/project/.next/server/chunks/add.wasm',
      '/project/node_modules/next/dist/compiled/@vercel/og/resvg.wasm',
    ]);
  });
});

describe('nftChunks, nftWasm and nftAssets', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'adapter-nft-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads an entry’s trace for the chunks it loads and the WebAssembly it reaches', async () => {
    // The instrumentation hook is the one entry the adapter finds by its trace rather than being
    // handed, and its chunks go into both Workers; a `.wasm` it imports has to travel with them.
    // As `next build` lays it out: the hook and its chunks under `<distDir>/server`, which is
    // the segment `nftChunks` holds a chunk to.
    const entry = path.join(dir, 'server', 'instrumentation.js');
    await mkdir(path.join(dir, 'server', 'chunks'), { recursive: true });
    await writeFile(entry, '');
    await writeFile(
      `${entry}.nft.json`,
      JSON.stringify({
        files: [
          'chunks/hook.js',
          'chunks/add.wasm',
          // The same module twice, as a trace may name it, and a file that is neither.
          './chunks/add.wasm',
          'chunks/hook.js.map',
        ],
      }),
    );

    await expect(nftChunks(entry)).resolves.toStrictEqual([
      path.join(dir, 'server', 'chunks', 'hook.js'),
    ]);
    // Not held to that segment: `@vercel/og`'s two are traced from `node_modules`, where a
    // package keeps them, and they travel all the same.
    await expect(nftWasm(entry)).resolves.toStrictEqual([
      path.join(dir, 'server', 'chunks', 'add.wasm'),
    ]);
  });

  /**
   * The hook runs before any entrypoint in each Worker, and what it reads through `node:fs` has
   * to be there too: an `instrumentation.ts` that read an `otel.json` of the project had its code
   * bundled and not the file, and failed as it started.
   */
  it('names what the entry reads among what it traces, for the Workers to carry', async () => {
    const entry = path.join(dir, '.next', 'server', 'instrumentation.js');
    await mkdir(path.join(dir, '.next', 'server', 'chunks'), { recursive: true });
    await writeFile(entry, '');
    await writeFile(
      `${entry}.nft.json`,
      JSON.stringify({ files: ['chunks/hook.js', '../../otel.json', '../../otel.json'] }),
    );

    const assets = await nftAssets(entry, dir);

    expect(Object.values(assets)).toStrictEqual([
      path.join(dir, '.next', 'server', 'chunks', 'hook.js'),
      path.join(dir, 'otel.json'),
    ]);
    expect(tracedFiles([{ assets }], dir, path.join(dir, '.next'))).toStrictEqual([
      { name: 'otel.json', filePath: path.join(dir, 'otel.json') },
    ]);
  });

  it('finds nothing for an entry the build wrote no trace for', async () => {
    const entry = path.join(dir, 'server', 'instrumentation.js');

    await expect(nftChunks(entry)).resolves.toStrictEqual([]);
    await expect(nftWasm(entry)).resolves.toStrictEqual([]);
    await expect(nftAssets(entry, dir)).resolves.toStrictEqual({});
  });
});

describe('middlewareOutput', () => {
  it('hands back the middleware on either runtime, and nothing when there is none', () => {
    const middleware: AdapterOutput['MIDDLEWARE'] = {
      ...route({ pathname: '/_middleware' }),
      type: AdapterOutputType.MIDDLEWARE,
      config: { matchers: [] },
    };
    const edge = { ...middleware, runtime: 'edge' as const };

    expect(middlewareOutput(outputs({ middleware }))).toBe(middleware);
    expect(middlewareOutput(outputs({ middleware: edge }))).toBe(edge);
    expect(middlewareOutput(outputs({}))).toBeUndefined();
  });
});

describe('collectPrerenders', () => {
  let dir: string;
  let blobs: BlobStore;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'adapter-collect-'));
    blobs = new BlobStore(dir);
    await blobs.init();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('carries the classification, the fallback and the body as blobs', async () => {
    const html = path.join(dir, 'page.html');
    await writeFile(html, '<html>shell</html>');
    const { prerenders, shipped } = await collectPrerenders({
      outputs: outputs({
        prerenders: [
          prerender({
            id: '/page',
            routeType: 'shell',
            response: 'initial',
            compute: 'resuming',
            htmlSize: 18,
            fallback: {
              filePath: html,
              postponedState: '{"postponed":true}',
              initialStatus: 200,
              initialHeaders: { 'x-a': '1', 'set-cookie': ['a=1', 'b=2'] },
              initialRevalidate: 60,
              initialExpiration: 120,
            },
            config: {
              // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-assignment -- Next declares `RenderingMode` an ambient `const enum`, whose members `verbatimModuleSyntax` lets no file read (TS2748); a build writes the string.
              renderingMode: 'PARTIALLY_STATIC' as RenderingMode,
              allowQuery: ['q'],
              allowHeader: ['x-a'],
              bypassToken: 'preview-mode-id',
              partialFallback: true,
            },
            pprChain: { headers: { 'x-chain': '1' } },
            parentFallbackMode: false,
          }),
        ],
      }),
      blobs,
      basePath: '',
      rsc,
    });
    const [first] = prerenders;

    expect(first).toMatchObject({
      id: '/page',
      routeType: 'shell',
      response: 'initial',
      compute: 'resuming',
      renderingMode: 'PARTIALLY_STATIC',
      htmlSize: 18,
      initialStatus: 200,
      initialHeaders: { 'x-a': '1', 'set-cookie': ['a=1', 'b=2'] },
      pprChain: { headers: { 'x-chain': '1' } },
      allowQuery: ['q'],
      allowHeader: ['x-a'],
      // The lifetime, as Next.js hands it over: the cache authority seeds a generation from it.
      initialRevalidate: 60,
      initialExpiration: 120,
      parentFallbackMode: false,
      partialFallback: true,
    });
    // The bypass token is the app's preview-mode secret; the Worker carries it in its own
    // manifest, and the edge needs only the cookie's presence, so the bundle never holds it.
    expect(first).not.toHaveProperty('bypassToken');
    expect(first?.body?.contentType).toBe('text/html; charset=utf-8');
    expect(first?.postponed?.contentType).toBe('text/plain; charset=utf-8');
    expect(new Set(shipped.map((entry) => entry.sha256))).toStrictEqual(
      new Set([first?.body?.sha256, first?.postponed?.sha256]),
    );
  });

  it('records a prerender without a body or state as it is', async () => {
    const { prerenders, shipped } = await collectPrerenders({
      outputs: outputs({
        prerenders: [
          prerender({ id: '/api', routeType: 'route', response: 'empty', compute: 'blocking' }),
        ],
      }),
      blobs,
      basePath: '',
      rsc,
    });

    expect(prerenders[0]).not.toHaveProperty('body');
    expect(prerenders[0]).not.toHaveProperty('postponed');
    expect(shipped).toStrictEqual([]);
  });

  /**
   * Next.js names every output's pathname under the `basePath` before the adapter runs — a
   * page's, which is the id its module is required by, as much as a prerender's — and leaves a
   * prerender's source route bare. The runtime looks a shell up by the route the router
   * resolved, which carries the `basePath`, and resumes it through the entry that route names:
   * the route has to be an entry id, so it is named under the `basePath` as well.
   */
  it('names the source route under the basePath, as the pathname and the entry ids are', async () => {
    const built = outputs({
      appPages: [
        route({ pathname: '/docs/[locale]' }),
        route({ pathname: '/docs/_not-found', sourcePage: '/app/not-found.tsx' }),
      ],
      prerenders: [
        prerender({ id: '/en', pathname: '/docs/en', route: '/[locale]' }),
        prerender({ id: '/_not-found', pathname: '/docs/_not-found', route: '/_not-found' }),
      ],
    });

    const { prerenders } = await collectPrerenders({
      outputs: built,
      blobs,
      basePath: '/docs',
      rsc,
    });
    const { entrypoints } = collectEntrypoints(built);

    expect(prerenders.map((entry) => [entry.pathname, entry.route])).toStrictEqual([
      ['/docs/en', '/docs/[locale]'],
      ['/docs/_not-found', '/docs/_not-found'],
    ]);
    expect(entrypoints.map((entry) => entry.id)).toStrictEqual(
      prerenders.map((entry) => entry.route),
    );
  });

  /**
   * The one page whose module is not named for the URL it answers: the Pages Router's home, which
   * Next.js names `/index` and which answers the application's root. It is collected under the
   * root, `/` or the `basePath` itself, and its prerenders — the document and its data — name that
   * entry as their route by the page they came from (`parentOutputId`). Named as Next.js named it,
   * the router never resolved the root to it, and the root was answered with the not-found page.
   */
  it.each([
    ['', '/index', '/'],
    ['/docs', '/docs/index', '/docs'],
  ])(
    'collects the Pages Router home under the root, under basePath %j',
    async (basePath, named, root) => {
      const built = outputs({
        pages: [pagesRoute({ id: '/index', pathname: named })],
        prerenders: [
          prerender({ id: '/', pathname: root, route: '/', parentOutputId: '/index' }),
          prerender({
            id: '/_next/data/b/index.json',
            pathname: `${basePath}/_next/data/b/index.json`,
            route: '/',
            parentOutputId: '/index',
          }),
        ],
      });

      const { prerenders } = await collectPrerenders({
        outputs: built,
        blobs,
        basePath,
        rsc,
      });
      const { entrypoints } = collectEntrypoints(built);

      expect(entrypoints.map((entry) => [entry.id, entry.pathname])).toStrictEqual([[root, root]]);
      expect(prerenders.map((entry) => entry.route)).toStrictEqual([root, root]);
    },
  );

  /**
   * Next.js 16.4 says of a route whose every navigation is static (`ensureStatic = 'navigation'`)
   * only in `prerender-manifest.json` (`_isEnsureStaticPage`). The adapter is handed the routes that
   * say so, by the pathname their template is filed under, and marks that template alone.
   */
  it('marks the template of a route whose every navigation is static', async () => {
    const built = outputs({
      prerenders: [
        prerender({ id: '/docs/[slug]', route: '/docs/[slug]' }),
        prerender({ id: '/docs/a', route: '/docs/[slug]' }),
        prerender({ id: '/blog/[slug]', route: '/blog/[slug]' }),
      ],
    });

    const { prerenders } = await collectPrerenders({
      outputs: built,
      blobs,
      basePath: '',
      rsc,
      ensureStatic: new Set(['/docs/[slug]']),
    });

    expect(prerenders.map((entry) => [entry.pathname, entry.ensureStatic])).toStrictEqual([
      ['/docs/[slug]', 'navigation'],
      ['/docs/a', undefined],
      ['/blog/[slug]', undefined],
    ]);
  });

  it('keeps the source route under the basePath for a prerender with no page among the entries', async () => {
    const built = outputs({
      prerenders: [prerender({ id: '/en', pathname: '/docs/en', route: '/[locale]' })],
    });

    const { prerenders } = await collectPrerenders({
      outputs: built,
      blobs,
      basePath: '/docs',
      rsc,
    });

    expect(prerenders.map((entry) => entry.route)).toStrictEqual(['/docs/[locale]']);
  });

  /**
   * Next.js builds a segment's pathname from its document's own and the two suffixes the routes
   * manifest declares: `path.join(normalizePagePath(route) + prefetchSegmentDirSuffix, segmentPath)
   * + prefetchSegmentSuffix`. The pathnames here are spelled out as that produces them — so the
   * test states what the build writes, rather than composing it the same way the reading does.
   */
  it('records the header value each prefetch segment answers', async () => {
    const built = outputs({
      appPages: [route({ pathname: '/r' })],
      prerenders: group([
        '/r',
        '/r.rsc',
        '/r.segments/_tree.segment.rsc',
        '/r.segments/_full.segment.rsc',
        '/r.segments/$d$locale/!KHNpdGUp/__PAGE__.segment.rsc',
      ]),
    });

    const { prerenders } = await collectPrerenders({ outputs: built, blobs, basePath: '', rsc });

    expect(prerenders.map((entry) => [entry.pathname, entry.segmentPath])).toStrictEqual([
      // The document itself and the RSC payload beside it are not prefetch segments.
      ['/r', undefined],
      ['/r.rsc', undefined],
      ['/r.segments/_tree.segment.rsc', '/_tree'],
      ['/r.segments/_full.segment.rsc', '/_full'],
      ['/r.segments/$d$locale/!KHNpdGUp/__PAGE__.segment.rsc', '/$d$locale/!KHNpdGUp/__PAGE__'],
    ]);
  });

  /**
   * `normalizePagePath` spells the root `/index`, so the build writes the root's segments under a
   * name the document does not have. A route that already begins with `/index` is nested under a
   * second one the same way.
   */
  it.each([
    { document: '/', segment: '/index.segments/_tree.segment.rsc' },
    { document: '/index', segment: '/index/index.segments/_tree.segment.rsc' },
    { document: '/index/deep', segment: '/index/index/deep.segments/_tree.segment.rsc' },
  ])('reads a segment of $document, which the build spells otherwise', async (spelling) => {
    const built = outputs({
      appPages: [route({ pathname: '/r' })],
      prerenders: group([spelling.document, spelling.segment]),
    });

    const { prerenders } = await collectPrerenders({ outputs: built, blobs, basePath: '', rsc });

    expect(prerenders.map((entry) => entry.segmentPath)).toStrictEqual([undefined, '/_tree']);
  });

  /**
   * `normalizePathnames` puts the `basePath` on at the very end of the build, after the paths of the
   * files it wrote were composed from the bare route — so the root of an application with one has
   * its document at `/docs` and its segments under `/docs/index.segments/…`, two spellings deep. The
   * prefix comes off before the route's spelling is read and goes back on around it; read the other
   * way round, every segment of such a root went unnamed.
   */
  it('reads a segment of the root under a basePath, which the build spells twice over', async () => {
    const built = outputs({
      prerenders: group(['/docs', '/docs/index.segments/_tree.segment.rsc'], '/'),
    });

    const { prerenders } = await collectPrerenders({
      outputs: built,
      blobs,
      basePath: '/docs',
      rsc,
    });

    expect(prerenders.map((entry) => entry.segmentPath)).toStrictEqual([undefined, '/_tree']);
  });

  /**
   * The reading is anchored on the document the output travels with, not on a suffix found anywhere
   * in a path: a route whose own last part reads like one is still read as itself.
   */
  it('reads a route whose own name ends in the directory suffix as itself', async () => {
    const built = outputs({
      appPages: [route({ pathname: '/r' })],
      prerenders: group(['/docs.segments/x', '/docs.segments/x.segments/_tree.segment.rsc']),
    });

    const { prerenders } = await collectPrerenders({ outputs: built, blobs, basePath: '', rsc });

    expect(prerenders.map((entry) => entry.segmentPath)).toStrictEqual([undefined, '/_tree']);
  });

  /**
   * An output the reading does not account for keeps no segment path and travels with the Function,
   * which is where every prefetch went before this was recorded. Naming a document it does not
   * belong to would answer one page's prefetch with part of another.
   */
  it('leaves an output alone when its path does not name the document it travels with', async () => {
    const built = outputs({
      appPages: [route({ pathname: '/r' })],
      prerenders: group([
        '/r',
        // Another page's segment, and a segment path with no separator after the suffix.
        '/other.segments/_tree.segment.rsc',
        '/r.segments_tree.segment.rsc',
      ]),
    });

    const { prerenders } = await collectPrerenders({ outputs: built, blobs, basePath: '', rsc });

    expect(prerenders.every((entry) => entry.segmentPath === undefined)).toBe(true);
  });
});

describe('ensureStaticRoutes', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'adapter-ensure-static-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('names the routes the prerender manifest says every navigation of is static', async () => {
    await writeFile(
      path.join(dir, 'prerender-manifest.json'),
      JSON.stringify({
        version: 4,
        dynamicRoutes: {
          '/docs/[slug]': { _isEnsureStaticPage: true },
          '/blog/[slug]': { _isEnsureStaticPage: false },
          '/[lang]': {},
        },
      }),
    );

    await expect(ensureStaticRoutes(dir, '/base')).resolves.toStrictEqual(
      new Set(['/base/docs/[slug]']),
    );
  });

  /** A static export writes no prerender manifest, and has no such route. */
  it('names none where the build wrote no prerender manifest', async () => {
    await expect(ensureStaticRoutes(dir, '')).resolves.toStrictEqual(new Set());
  });
});

describe('collectStaticFiles', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'adapter-static-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('takes the build output as named, and public/ files by their URL-encoded path', async () => {
    const chunk = path.join(dir, 'chunk.js');
    await writeFile(chunk, 'x');
    await mkdir(path.join(dir, 'public', 'a b'), { recursive: true });
    await writeFile(path.join(dir, 'public', 'a b', 'ü.txt'), 'hi');
    const blobs = new BlobStore(dir);
    await blobs.init();
    const collect = (basePath: string): ReturnType<typeof collectStaticFiles> => {
      return collectStaticFiles(
        {
          projectDir: dir,
          config: { basePath },
          outputs: outputs({
            staticFiles: [
              {
                id: 'c',
                filePath: chunk,
                // Next.js names its outputs under the basePath already.
                pathname: `${basePath}/_next/static/immutable/chunks/c.js`,
                type: AdapterOutputType.STATIC_FILE,
                immutableHash: 'abc',
              },
            ],
          }),
        } as unknown as BuildContext,
        blobs,
      );
    };
    const { files } = await collect('');
    const { files: underBasePath } = await collect('/docs');

    expect(files.map((file) => [file.pathname, file.immutable])).toStrictEqual([
      ['/_next/static/immutable/chunks/c.js', true],
      ['/a%20b/%C3%BC.txt', false],
    ]);
    // A public file is requested under the basePath, as everything of the app is.
    expect(underBasePath.map((file) => file.pathname)).toStrictEqual([
      '/docs/_next/static/immutable/chunks/c.js',
      '/docs/a%20b/%C3%BC.txt',
    ]);
    await expect(
      readFile(path.join(dir, 'blobs', files[1]?.blob.sha256 ?? ''), 'utf8'),
    ).resolves.toBe('hi');
  });

  it('offers the home page under the URL it is asked for as well as the name Next.js gave it', async () => {
    const document = path.join(dir, 'index.html');
    await writeFile(document, '<!DOCTYPE html>');
    const blobs = new BlobStore(dir);
    await blobs.init();
    const collect = (basePath: string): ReturnType<typeof collectStaticFiles> => {
      return collectStaticFiles(
        {
          projectDir: dir,
          config: { basePath },
          outputs: outputs({
            staticFiles: [
              {
                id: '/',
                filePath: document,
                // `normalizePagePath` spells the Pages Router home page `/index`.
                pathname: `${basePath}/index`,
                type: AdapterOutputType.STATIC_FILE,
                immutableHash: undefined,
              },
            ],
          }),
        } as unknown as BuildContext,
        blobs,
      );
    };
    const { files } = await collect('');
    const { files: underBasePath } = await collect('/docs');

    expect(files.map((file) => file.pathname)).toStrictEqual(['/index', '/']);
    expect(underBasePath.map((file) => file.pathname)).toStrictEqual(['/docs/index', '/docs']);
    // One file, offered twice: the same blob, so the upload and the storage are unchanged.
    expect(files[0]?.blob.sha256).toBe(files[1]?.blob.sha256);
  });

  /**
   * A rule is judged against the name the file is served under, not the one the build handed
   * over: a document moves from `/index` to `/`, and the edge matches the header rules on the
   * request's own pathname. Reading a rule at the old name would flag a file at a URL the rule
   * does not cover — a year in a browser's cache where the build asked for none.
   */
  it('reads the cache rules at the name the file is served under', async () => {
    const html = path.join(dir, 'index.html');
    await writeFile(html, '<!DOCTYPE html><html><body>home</body></html>');
    const blobs = new BlobStore(dir);
    await blobs.init();

    const { files } = await collectStaticFiles(
      {
        projectDir: dir,
        config: { basePath: '', trailingSlash: false, output: 'export' },
        // A rule over the name the build hands over, which is not the name the file is served at.
        routing: {
          onMatch: [
            {
              sourceRegex: '^/index$',
              headers: { 'cache-control': 'public,max-age=31536000,immutable' },
            },
          ],
        },
        outputs: outputs({
          staticFiles: [
            {
              id: '/index.html',
              filePath: html,
              pathname: '/index',
              type: AdapterOutputType.STATIC_FILE,
              immutableHash: undefined,
            },
          ],
        }),
      } as unknown as BuildContext,
      blobs,
    );

    expect(files.map((file) => [file.pathname, file.immutable])).toStrictEqual([['/', false]]);
  });

  /**
   * `out/` already holds everything `public/` had: `next build` copies the directory in before it
   * calls the adapter. Walking it again would name each file twice, once with the encoding the
   * walk applies and once with the name the export gave it.
   */
  it('does not walk public/ a second time for a static export', async () => {
    const copied = path.join(dir, 'out-robots.txt');
    await writeFile(copied, 'hi');
    await mkdir(path.join(dir, 'public'), { recursive: true });
    await writeFile(path.join(dir, 'public', 'robots.txt'), 'hi');
    const blobs = new BlobStore(dir);
    await blobs.init();

    const { files } = await collectStaticFiles(
      {
        projectDir: dir,
        config: { basePath: '', trailingSlash: false, output: 'export' },
        routing: { onMatch: [] },
        outputs: outputs({
          staticFiles: [
            {
              id: '/robots.txt',
              filePath: copied,
              pathname: '/robots.txt',
              type: AdapterOutputType.STATIC_FILE,
              immutableHash: undefined,
            },
          ],
        }),
      } as unknown as BuildContext,
      blobs,
    );

    expect(files.map((file) => file.pathname)).toStrictEqual(['/robots.txt']);
  });

  /**
   * A metadata file the build prerendered is handed over as `<route>.body`. Typed by that name it
   * went out as `application/octet-stream`, which `X-Content-Type-Options: nosniff` leaves a
   * crawler to read as bytes; the name it is served under says what it is.
   */
  it('types a prerendered metadata file by the name it is served under', async () => {
    const blobs = new BlobStore(dir);
    await blobs.init();
    const file = async (name: string): Promise<string> => {
      const filePath = path.join(dir, name);
      await writeFile(filePath, name);
      return filePath;
    };
    const metadata = async (pathname: string): Promise<Outputs['staticFiles'][number]> => {
      return {
        id: pathname,
        filePath: await file(`${pathname.slice(1)}.body`),
        pathname,
        type: AdapterOutputType.STATIC_FILE,
        immutableHash: undefined,
      };
    };

    const { files } = await collectStaticFiles(
      {
        projectDir: dir,
        config: { basePath: '' },
        outputs: outputs({
          staticFiles: [
            await metadata('/robots.txt'),
            await metadata('/favicon.ico'),
            await metadata('/manifest.webmanifest'),
            // Any other file keeps the type its own name gives it.
            {
              id: 'c',
              filePath: await file('c.js'),
              pathname: '/_next/static/immutable/chunks/c.js',
              type: AdapterOutputType.STATIC_FILE,
              immutableHash: 'abc',
            },
          ],
        }),
      } as unknown as BuildContext,
      blobs,
    );

    expect(files.map((entry) => [entry.pathname, entry.blob.contentType])).toStrictEqual([
      ['/robots.txt', 'text/plain; charset=utf-8'],
      ['/favicon.ico', 'image/x-icon'],
      ['/manifest.webmanifest', 'application/manifest+json'],
      ['/_next/static/immutable/chunks/c.js', 'text/javascript; charset=utf-8'],
    ]);
  });
});

/** An exported file as `next build` hands it over: `.html` taken off the path from `out/`. */
function exportedFile(filePath: string, pathname: string): Parameters<typeof exportedPathname>[0] {
  return { filePath, pathname };
}

describe('exportedPathname', () => {
  /** Without `trailingSlash` a page sits beside its siblings, and only the root is an index. */
  it('names each document where a static host would serve it', () => {
    const naming = { basePath: '', trailingSlash: false };

    expect(exportedPathname(exportedFile('/out/index.html', '/index'), naming)).toBe('/');
    expect(exportedPathname(exportedFile('/out/about.html', '/about'), naming)).toBe('/about');
    expect(exportedPathname(exportedFile('/out/blog/first.html', '/blog/first'), naming)).toBe(
      '/blog/first',
    );
    // The error document keeps its bare name: the runtime looks the not-found up by it, and so
    // does a host when it decides the status the file is answered with.
    expect(exportedPathname(exportedFile('/out/404.html', '/404'), naming)).toBe('/404');
  });

  /**
   * Without `trailingSlash` Next.js writes no directory index but the site's own, so a nested
   * `index.html` is a route whose last segment is `index` (`app/blog/index/page.tsx`). Taking the
   * segment off would serve the page at `/blog/`, a URL the application does not have, and leave
   * `/blog/index`, the one it does, to the Worker's not-found.
   */
  it('keeps a route whose own last segment is index', () => {
    const naming = { basePath: '', trailingSlash: false };

    expect(exportedPathname(exportedFile('/out/blog/index.html', '/blog/index'), naming)).toBe(
      '/blog/index',
    );
    // With `trailingSlash` that same route is written one directory deeper, and the slash is right.
    expect(
      exportedPathname(exportedFile('/out/blog/index/index.html', '/blog/index/index'), {
        basePath: '',
        trailingSlash: true,
      }),
    ).toBe('/blog/index/');
  });

  it('gives a directory index the trailing slash it is asked for by', () => {
    const naming = { basePath: '', trailingSlash: true };

    expect(exportedPathname(exportedFile('/out/index.html', '/index'), naming)).toBe('/');
    expect(exportedPathname(exportedFile('/out/about/index.html', '/about/index'), naming)).toBe(
      '/about/',
    );
    // `trailingSlash: true` writes both, and both are served: `/404` is the error document, and
    // `/404/` is the page a visitor who typed it is answered with.
    expect(exportedPathname(exportedFile('/out/404.html', '/404'), naming)).toBe('/404');
    expect(exportedPathname(exportedFile('/out/404/index.html', '/404/index'), naming)).toBe(
      '/404/',
    );
  });

  /** Next.js prefixes every exported pathname with the `basePath` before the adapter sees it. */
  it('spells the root of a basePath as the build redirects the other spelling to', () => {
    expect(
      exportedPathname(exportedFile('/out/index.html', '/docs/index'), {
        basePath: '/docs',
        trailingSlash: false,
      }),
    ).toBe('/docs');
    expect(
      exportedPathname(exportedFile('/out/index.html', '/docs/index'), {
        basePath: '/docs',
        trailingSlash: true,
      }),
    ).toBe('/docs/');
    expect(
      exportedPathname(exportedFile('/out/about/index.html', '/docs/about/index'), {
        basePath: '/docs',
        trailingSlash: true,
      }),
    ).toBe('/docs/about/');
  });

  /** Everything that is not HTML is served under the name it has, RSC payloads included. */
  it('leaves a file that is not a document alone', () => {
    const naming = { basePath: '', trailingSlash: true };

    expect(
      exportedPathname(
        exportedFile('/out/_next/static/chunks/c.js', '/_next/static/chunks/c.js'),
        naming,
      ),
    ).toBe('/_next/static/chunks/c.js');
    expect(exportedPathname(exportedFile('/out/about.txt', '/about.txt'), naming)).toBe(
      '/about.txt',
    );
    expect(
      exportedPathname(
        exportedFile('/out/about/__next._tree.txt', '/about/__next._tree.txt'),
        naming,
      ),
    ).toBe('/about/__next._tree.txt');
    expect(exportedPathname(exportedFile('/out/robots.txt', '/robots.txt'), naming)).toBe(
      '/robots.txt',
    );
  });
});

/** One unconditional `onMatch` rule over the build's chunks, setting `cache-control`. */
function cachePolicy(cacheControl: string): Route[] {
  return [{ sourceRegex: '/_next/static/chunks/.+', headers: { 'cache-control': cacheControl } }];
}

describe('immutableByBuild', () => {
  /** The rule `next build` emits for its own `_next/static`, read rather than reinvented. */
  const onMatch: Route[] = [
    {
      sourceRegex: String.raw`/_next/static/(?:[^/]+/pages|pages|chunks|immutable|runtime|css|image|media|build\-abc)/.+`,
      headers: { 'cache-control': 'public,max-age=31536000,immutable' },
    },
    {
      source: '/:path*',
      sourceRegex: String.raw`^(?:\/((?:[^\/]+?)(?:\/(?:[^\/]+?))*))?(?:\/)?$`,
      headers: { 'x-nextjs-deployment-id': 'dpl_x' },
    },
  ];

  it('marks what the build says may be cached forever, and nothing else', () => {
    expect(immutableByBuild(onMatch, '/_next/static/chunks/c.js')).toBe(true);
    expect(immutableByBuild(onMatch, '/_next/static/build-abc/_buildManifest.js')).toBe(true);
    expect(immutableByBuild(onMatch, '/_next/static/media/f.woff2')).toBe(true);
    // A name the build did not put a hash or the build id in.
    expect(immutableByBuild(onMatch, '/_next/static/other/x.js')).toBe(false);
    expect(immutableByBuild(onMatch, '/about')).toBe(false);
    expect(immutableByBuild(onMatch, '/robots.txt')).toBe(false);
  });

  it('ignores a rule that sets a header but says nothing about caching', () => {
    expect(immutableByBuild([onMatch[1]!], '/about')).toBe(false);
  });

  /**
   * A flag on a file says the same thing to every request, so only a rule that holds for every
   * request can set it: one with a condition is judged per request at the edge, and cannot.
   */
  it('takes no immutability from a rule that holds only for some requests', () => {
    const conditional: Route[] = [
      {
        sourceRegex: '/_next/static/chunks/.+',
        has: [{ type: 'header', key: 'x-beta' }],
        headers: { 'cache-control': 'public,max-age=31536000,immutable' },
      },
    ];

    expect(immutableByBuild(conditional, '/_next/static/chunks/c.js')).toBe(false);
  });

  /**
   * And one that could answer otherwise for some requests takes it away from all of them — but
   * only from what stands where it sits. An unconditional rule after it is what every request ends
   * on, so the conditional one before it takes nothing.
   */
  it('lets an unconditional rule stand over a conditional one before it', () => {
    const conditionalFirst: Route[] = [
      {
        sourceRegex: '/_next/static/chunks/.+',
        missing: [{ type: 'cookie', key: 'session' }],
        headers: { 'cache-control': 'private, no-store' },
      },
      ...onMatch,
    ];

    expect(immutableByBuild(conditionalFirst, '/_next/static/chunks/c.js')).toBe(true);
  });

  it('gives up immutability a conditional rule could override', () => {
    const overridden: Route[] = [
      ...onMatch,
      {
        sourceRegex: '/_next/static/chunks/.+',
        missing: [{ type: 'cookie', key: 'session' }],
        headers: { 'cache-control': 'private, no-store' },
      },
    ];

    expect(immutableByBuild(overridden, '/_next/static/chunks/c.js')).toBe(false);
  });

  /**
   * `immutable` qualifies a freshness lifetime; on its own it says nothing. A policy that is not
   * long-lived, or that withholds the response from a shared cache, does not make a file one that
   * may be kept for a year and handed to a document of another deployment.
   */
  it('reads the whole policy, not the word immutable', () => {
    expect(
      immutableByBuild(
        cachePolicy('public,max-age=31536000,immutable'),
        '/_next/static/chunks/c.js',
      ),
    ).toBe(true);
    expect(
      immutableByBuild(cachePolicy('public, max-age=0, immutable'), '/_next/static/chunks/c.js'),
    ).toBe(false);
    expect(
      immutableByBuild(cachePolicy('private, no-store, immutable'), '/_next/static/chunks/c.js'),
    ).toBe(false);
    expect(
      immutableByBuild(cachePolicy('max-age=31536000, immutable'), '/_next/static/chunks/c.js'),
    ).toBe(false);
  });

  /** The rules are a list, and the last unconditional one to speak decides. */
  it('takes the last unconditional rule, not the first', () => {
    const later: Route[] = [
      ...onMatch,
      {
        sourceRegex: '/_next/static/chunks/.+',
        headers: { 'cache-control': 'public, max-age=0, must-revalidate' },
      },
    ];

    expect(immutableByBuild(later, '/_next/static/chunks/c.js')).toBe(false);
    expect(immutableByBuild(onMatch, '/_next/static/chunks/c.js')).toBe(true);
  });
});

/** The asset prefix path a bundle records for an app configured so. */
function assetPrefixPathOf(config: Record<string, unknown>): string | undefined {
  return bundleConfig(config as unknown as BuildContext['config'], undefined).assetPrefix;
}

describe('bundleConfig', () => {
  /**
   * `NextConfigComplete` types these as present and `onBuildComplete` hands over only what the
   * app wrote. An app that configures nothing therefore reaches the bundle schema with
   * `skipTrailingSlashRedirect: undefined` and fails the build at the last step. Both Next.js
   * apps in this repository set it, so only a customer's app ever hit it.
   */
  it('fills in what an app that configures nothing leaves out', () => {
    const config = bundleConfig({} as unknown as BuildContext['config'], undefined);

    expect(config).toStrictEqual({
      basePath: '',
      trailingSlash: false,
      skipTrailingSlashRedirect: false,
      skipProxyUrlNormalize: undefined,
      poweredByHeader: true,
      cacheComponents: false,
      partialPrefetching: false,
      i18n: null,
    });
  });

  it('records the cache settings a runtime lifetime is read against', () => {
    const config = bundleConfig(
      {
        basePath: '',
        trailingSlash: false,
        skipTrailingSlashRedirect: false,
        poweredByHeader: false,
        i18n: null,
        cacheComponents: true,
        partialPrefetching: true,
        expireTime: 3600,
        cacheLife: {
          default: { stale: 300, revalidate: 900, expire: 4_294_967_294 },
          blog: { revalidate: 30, expire: 900 },
        },
      } as unknown as BuildContext['config'],
      undefined,
    );

    expect(config).toMatchObject({
      cacheComponents: true,
      partialPrefetching: true,
      expireTime: 3600,
      cacheLife: {
        default: { stale: 300, revalidate: 900, expire: 4_294_967_294 },
        blog: { revalidate: 30, expire: 900 },
      },
    });
    expect(config.cacheLife?.['blog']).not.toHaveProperty('stale');
  });

  it("records Next.js's internal `'unstable_eager'` prefetching as the partial prefetching it is", () => {
    const config = bundleConfig(
      {
        basePath: '',
        trailingSlash: false,
        skipTrailingSlashRedirect: false,
        poweredByHeader: false,
        i18n: null,
        cacheComponents: true,
        partialPrefetching: 'unstable_eager',
      } as unknown as BuildContext['config'],
      undefined,
    );

    expect(config.partialPrefetching).toBe(true);
  });

  it('carries how much of a request body the middleware may read, as Next.js normalized it', () => {
    const carried = bundleConfig(
      { experimental: { proxyClientMaxBodySize: 1_048_576 } } as unknown as BuildContext['config'],
      undefined,
    );
    const unnormalized = bundleConfig(
      { experimental: { proxyClientMaxBodySize: '1mb' } } as unknown as BuildContext['config'],
      undefined,
    );

    expect(carried.proxyClientMaxBodySize).toBe(1_048_576);
    expect(unnormalized).not.toHaveProperty('proxyClientMaxBodySize');
  });

  it("carries the path `next build` serves the app's `_next` files under for its asset prefix", () => {
    expect(assetPrefixPathOf({ assetPrefix: '/assets' })).toBe('/assets');
    expect(assetPrefixPathOf({ assetPrefix: 'assets' })).toBe('/assets');
    // A URL's pathname is rewritten all the same; its host is the application's to route.
    expect(assetPrefixPathOf({ assetPrefix: 'https://cdn.example.com/custom-asset-prefix' })).toBe(
      '/custom-asset-prefix',
    );
    // No rewrite: no prefix, one of `/` or a bare host, or the base path Next.js puts in for none.
    expect(assetPrefixPathOf({})).toBeUndefined();
    expect(assetPrefixPathOf({ assetPrefix: '/' })).toBeUndefined();
    expect(assetPrefixPathOf({ assetPrefix: 'https://cdn.example.com' })).toBeUndefined();
    expect(assetPrefixPathOf({ assetPrefix: '/docs', basePath: '/docs' })).toBeUndefined();
  });

  it('keeps the request-time subset of next.config, i18n domains included', () => {
    const config = bundleConfig(
      {
        basePath: '/b',
        trailingSlash: false,
        skipTrailingSlashRedirect: true,
        skipProxyUrlNormalize: false,
        poweredByHeader: false,
        i18n: {
          defaultLocale: 'en',
          locales: ['en', 'ja'],
          localeDetection: false,
          domains: [{ domain: 'example.jp', defaultLocale: 'ja', http: true, locales: ['ja'] }],
        },
      } as unknown as BuildContext['config'],
      undefined,
    );

    expect(config).toStrictEqual({
      basePath: '/b',
      trailingSlash: false,
      skipTrailingSlashRedirect: true,
      skipProxyUrlNormalize: false,
      poweredByHeader: false,
      cacheComponents: false,
      partialPrefetching: false,
      i18n: {
        defaultLocale: 'en',
        locales: ['en', 'ja'],
        localeDetection: false,
        domains: [{ defaultLocale: 'ja', domain: 'example.jp', http: true, locales: ['ja'] }],
      },
    });
  });

  /**
   * The Worker renders a partially prerendered page whole for a visitor Next.js sends blocking
   * metadata to, and reads who that is off the pattern Next.js tests: the source of the `RegExp`
   * an app writes, or Next.js's own list, which loading the config fills in.
   */
  it('records the htmlLimitedBots pattern as Next.js tests it', () => {
    const configured = (htmlLimitedBots: unknown): string | undefined => {
      return bundleConfig({ htmlLimitedBots } as unknown as BuildContext['config'], undefined)
        .htmlLimitedBots;
    };

    expect(configured(/MyBot|Discordbot/iu)).toBe('MyBot|Discordbot');
    expect(configured('Slurp|DuckDuckBot')).toBe('Slurp|DuckDuckBot');
    expect(configured(undefined)).toBeUndefined();
  });

  it('carries what /_next/image enforces, first', () => {
    const images = {
      path: '/_next/image',
      basePath: '',
      sizes: [640],
      formats: [],
      minimumCacheTTL: 60,
      maximumRedirects: 3,
      maximumResponseBody: 1,
      remotePatterns: [],
      domains: [],
      localPatterns: [{ pathname: '^.*$', search: '' }],
      dangerouslyAllowSVG: false,
      dangerouslyAllowLocalIP: false,
      contentSecurityPolicy: '',
      contentDispositionType: 'attachment' as const,
    };

    const config = bundleConfig(
      {
        basePath: '',
        trailingSlash: false,
        skipTrailingSlashRedirect: false,
        poweredByHeader: false,
        i18n: null,
      } as unknown as BuildContext['config'],
      images,
    );

    expect(config.images).toStrictEqual(images);
  });
});

/** `images-manifest.json` as `next build` writes it, for a `basePath` of `/b`. */
function manifest(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    version: 1,
    images: {
      deviceSizes: [640],
      imageSizes: [32],
      path: '/b/_next/image',
      loader: 'default',
      loaderFile: '',
      minimumCacheTTL: 60,
      formats: ['image/webp'],
      remotePatterns: [],
      dangerouslyAllowSVG: false,
      contentSecurityPolicy: '',
      contentDispositionType: 'inline',
      unoptimized: false,
      ...overrides,
    },
  });
}

describe('imagesConfig', () => {
  let distDir: string;

  beforeEach(async () => {
    distDir = await mkdtemp(path.join(tmpdir(), 'adapter-images-'));
  });

  afterEach(async () => {
    await rm(distDir, { recursive: true, force: true });
  });

  function context(): BuildContext {
    return { distDir, config: { basePath: '/b' } } as unknown as BuildContext;
  }

  it('reads the manifest the build wrote, under the basePath', async () => {
    await writeFile(path.join(distDir, 'images-manifest.json'), manifest({}));

    const images = await imagesConfig(context());

    expect(images).toMatchObject({ path: '/b/_next/image', basePath: '/b', sizes: [640, 32] });
  });

  it('records nothing without a manifest, or for a build that left next/image unoptimized', async () => {
    await expect(imagesConfig(context())).resolves.toBeUndefined();

    await writeFile(path.join(distDir, 'images-manifest.json'), manifest({ unoptimized: true }));

    await expect(imagesConfig(context())).resolves.toBeUndefined();
  });
});

describe('rewriteTargetFiles', () => {
  const built = [
    '/_next/static/chunks/a.js',
    '/_next/static/media/logo.png',
    '/_next/static/BUILD/_buildManifest.js',
    '/favicon.ico',
  ].map((pathname): StaticFile => {
    return {
      pathname,
      blob: { sha256: 'a'.repeat(64), byteLength: 1, contentType: 'text/plain' },
      immutable: true,
    };
  });

  /** Rewrites as `next build` hands them over: the source as written, the destination converted. */
  function listed(afterFiles: readonly Omit<Route, 'sourceRegex'>[]): string[] {
    const routing = {
      beforeFiles: [],
      afterFiles: afterFiles.map((rewrite) => ({ sourceRegex: '^/x$', ...rewrite })),
      fallback: [],
    } as unknown as Routing;
    return rewriteTargetFiles(built, routing, '').map((file) => file.pathname);
  }

  it('lists what a catch-all mounting the application elsewhere can land on', () => {
    expect(listed([{ source: '/docs/:path*', destination: '/$1' }])).toStrictEqual([
      '/_next/static/chunks/a.js',
      '/_next/static/media/logo.png',
      '/_next/static/BUILD/_buildManifest.js',
    ]);
    expect(listed([{ source: '/assets/:path*', destination: '/_next/$1' }])).toHaveLength(3);
  });

  it('lists only what a destination can produce', () => {
    expect(listed([{ source: '/img/:file', destination: '/_next/static/media/$1' }])).toStrictEqual(
      ['/_next/static/media/logo.png'],
    );
    // One segment at a time, where every file of the build is three deep or more.
    expect(listed([{ source: '/:slug', destination: '/$1' }])).toStrictEqual([]);
    expect(listed([{ source: '/:locale/old', destination: '/$1/new' }])).toStrictEqual([]);
  });

  it('lists none for a redirect, another origin, or a build with no such rewrite', () => {
    expect(listed([{ source: '/docs/:path*', destination: '/$1', status: 308 }])).toStrictEqual([]);
    expect(
      listed([{ source: '/docs/:path*', destination: 'https://example.com/$1' }]),
    ).toStrictEqual([]);
    expect(listed([])).toStrictEqual([]);
  });
});
