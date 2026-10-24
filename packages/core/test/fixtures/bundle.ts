import type {
  BlobRef,
  DeploymentBundle,
  Prerender,
  Route,
  StaticFile,
} from '../../src/bundle/schema.ts';

/**
 * A deployment bundle shaped like the one `next build` writes for a small app: an exact page
 * with its RSC twin and segments, a class shell for a dynamic route, a page complete at build
 * time, a blocking page, and the error document — in memory, with no blobs behind the refs. Its
 * routing carries what `next build` writes into every build of its own accord, the rules for a
 * deployment id among them, since a host's builds always have one.
 */

const FIXTURE_DEPLOYMENT_ID = 'dpl_4Fixture2Minima1AppXy';
export const FIXTURE_GENERATED_AT = '2026-09-19T00:00:00.000Z';

const HTML = 'text/html; charset=utf-8';
const RSC = 'text/x-component';
const POSTPONED = 'text/plain; charset=utf-8';

function ref(seed: string, byteLength: number, contentType: string): BlobRef {
  return { sha256: seed.repeat(64).slice(0, 64), byteLength, contentType };
}

export const ROOT_SHELL = ref('a', 1200, HTML);
export const ROOT_POSTPONED = ref('b', 300, POSTPONED);
export const ITEM_SHELL = ref('c', 900, HTML);
export const ITEM_POSTPONED = ref('d', 250, POSTPONED);
export const STATIC_PAGE = ref('e', 700, HTML);
export const ERROR_PAGE = ref('f', 400, HTML);
export const ROOT_RSC = ref('1', 500, RSC);
export const ROOT_TREE_SEGMENT = ref('2', 100, RSC);
const MAIN_CHUNK = ref('3', 4000, 'text/javascript');
export const STYLES = ref('4', 800, 'text/css');
const HELLO_TXT = ref('5', 12, 'text/plain');
export const APP_MODULE = ref('6', 9000, 'application/javascript+module');

const HEADERS = {
  vary: 'rsc, next-router-state-tree, next-router-prefetch',
  'content-type': HTML,
  'x-nextjs-prerender': '1',
};

const FIXTURE_PRERENDERS: readonly Prerender[] = [
  {
    id: '/',
    pathname: '/',
    route: '/',
    parentOutputId: '/',
    groupId: 1,
    routeType: 'page',
    response: 'initial',
    compute: 'resuming',
    renderingMode: 'PARTIALLY_STATIC',
    htmlSize: ROOT_SHELL.byteLength,
    body: ROOT_SHELL,
    postponed: ROOT_POSTPONED,
    initialStatus: 200,
    initialHeaders: HEADERS,
    pprChain: { headers: { 'next-resume': '1' } },
    allowQuery: [],
  },
  {
    id: '/index.rsc',
    pathname: '/index.rsc',
    route: '/',
    parentOutputId: '/',
    groupId: 1,
    renderingMode: 'PARTIALLY_STATIC',
    postponed: ROOT_POSTPONED,
    initialHeaders: { ...HEADERS, 'content-type': RSC },
  },
  {
    id: '/index.segments/_tree.segment.rsc',
    pathname: '/index.segments/_tree.segment.rsc',
    route: '/',
    parentOutputId: '/',
    groupId: 1,
    renderingMode: 'PARTIALLY_STATIC',
    // The header value the build wrote this for. `next build` spells the root `/index` in the paths
    // of the files it writes, which is why the pathname says one thing and the document another.
    segmentPath: '/_tree',
    body: ROOT_TREE_SEGMENT,
    initialHeaders: { ...HEADERS, 'content-type': RSC, 'x-nextjs-postponed': '2' },
  },
  {
    id: '/items/[id]',
    pathname: '/items/[id]',
    route: '/items/[id]',
    parentOutputId: '/items/[id]',
    groupId: 2,
    routeType: 'fallback',
    response: 'initial',
    compute: 'resuming',
    renderingMode: 'PARTIALLY_STATIC',
    htmlSize: ITEM_SHELL.byteLength,
    body: ITEM_SHELL,
    postponed: ITEM_POSTPONED,
    initialStatus: 200,
    initialHeaders: HEADERS,
    pprChain: { headers: { 'next-resume': '1' } },
    parentFallbackMode: null,
  },
  {
    id: '/static',
    pathname: '/static',
    route: '/static',
    parentOutputId: '/static',
    groupId: 3,
    routeType: 'page',
    response: 'complete',
    compute: 'static',
    renderingMode: 'PARTIALLY_STATIC',
    htmlSize: STATIC_PAGE.byteLength,
    body: STATIC_PAGE,
    initialStatus: 200,
    initialHeaders: HEADERS,
  },
  {
    id: '/stream',
    pathname: '/stream',
    route: '/stream',
    parentOutputId: '/stream',
    groupId: 4,
    routeType: 'page',
    response: 'empty',
    compute: 'blocking',
    renderingMode: 'PARTIALLY_STATIC',
    htmlSize: 0,
  },
  {
    id: '/_global-error',
    pathname: '/_global-error',
    route: '/_global-error',
    parentOutputId: '/_global-error',
    groupId: 5,
    routeType: 'page',
    response: 'complete',
    compute: 'static',
    renderingMode: 'PARTIALLY_STATIC',
    htmlSize: ERROR_PAGE.byteLength,
    body: ERROR_PAGE,
    initialStatus: 500,
    initialHeaders: HEADERS,
  },
  {
    id: '/index.rsc.prefetch',
    pathname: '/index.rsc.prefetch',
    route: '/',
    parentOutputId: '/',
    groupId: 1,
    body: ROOT_RSC,
    initialHeaders: { ...HEADERS, 'content-type': RSC },
  },
];

/** The first static file the fixture ships, for tests that vary one of its fields. */
export function shippedFile(): StaticFile {
  const [file] = fixtureBundle().staticFiles;
  if (file === undefined) {
    throw new Error('the fixture ships no static file');
  }
  return file;
}

/** The page complete at build time, for tests that vary one of its fields. */
export function staticPrerender(): Prerender {
  const complete = FIXTURE_PRERENDERS.find((prerender) => prerender.id === '/static');
  if (complete === undefined) {
    throw new Error('the fixture has no page complete at build time');
  }
  return complete;
}

/** The exact root page, for tests that vary one of its fields. */
export function rootPrerender(): Prerender {
  const [root] = FIXTURE_PRERENDERS;
  if (root === undefined) {
    throw new Error('the fixture has no root prerender');
  }
  return root;
}

/**
 * The fixture's one dynamic route, as `next build` compiles it (`build-complete.ts`): the base path
 * in front of the pattern and of the page the destination names.
 */
function itemsRoute(basePath: string): Route {
  return {
    source: '/items/[id]',
    sourceRegex: `^${basePath}[/]?/items/(?<nxtPid>[^/]+?)(?:/)?$`,
    destination: `${basePath}/items/[id]?nxtPid=$nxtPid`,
  };
}

/** The directories of `_next/static` whose files `next build` names by hash, and its build id. */
const HASHED_STATIC_FILES = [
  '[^/]+/pages',
  'pages',
  'chunks',
  'immutable',
  'runtime',
  'css',
  'image',
  'media',
  String.raw`build\-TfctsWXpff2fKS`,
].join('|');

/**
 * What `next build` puts in `onMatch`: the lifetime of the files it names by hash, under the base
 * path; and, for a build with a deployment id, the id on every response to the client's router —
 * a rule over every path that holds only for a request with `rsc: 1` — and on every `_next/data`
 * one (`loadCustomRoutes`). Neither of the last two is written under the base path.
 */
function onMatchRules(basePath: string): Route[] {
  return [
    {
      sourceRegex: `${basePath}/_next/static/(?:${HASHED_STATIC_FILES})/.+`,
      headers: { 'cache-control': 'public,max-age=31536000,immutable' },
    },
    {
      source: '/:path*',
      sourceRegex: String.raw`^(?:\/((?:[^\/]+?)(?:\/(?:[^\/]+?))*))?(?:\/)?$`,
      headers: { 'x-nextjs-deployment-id': FIXTURE_DEPLOYMENT_ID },
      has: [{ type: 'header', key: 'rsc', value: '1' }],
    },
    {
      source: '/_next/data/(.*)',
      sourceRegex: String.raw`^\/_next\/data(?:\/(.*))(?:\/)?$`,
      headers: { 'x-nextjs-deployment-id': FIXTURE_DEPLOYMENT_ID },
    },
  ];
}

/**
 * A literal source as `next build` compiles it (path-to-regexp's `escapeString`): every character a
 * pattern gives a meaning to escaped, so `/docs.v1` is that name and no other.
 */
function escapedSource(source: string): string {
  return source.replaceAll(/[.+*?=^!:${}()[\]|/\\]/gu, String.raw`\$&`);
}

/**
 * The redirects `next build` adds for a build that keeps `trailingSlash` off and does not skip its
 * redirect (`loadCustomRoutes`): a path with the slash to the path without it, and — with a base
 * path — the base path's own spelling with the slash to the one without.
 */
export function slashRedirects(basePath: string): Route[] {
  const escaped = escapedSource(basePath);
  const root: Route[] =
    basePath === ''
      ? []
      : [
          {
            source: `${basePath}/`,
            sourceRegex: String.raw`^${escaped}\/$`,
            headers: { Location: basePath },
            status: 308,
            priority: true,
          },
        ];
  return [
    ...root,
    {
      source: '/:path+/',
      sourceRegex: String.raw`^(?:\/((?:[^\/]+?)(?:\/(?:[^\/]+?))*))\/$`,
      headers: { Location: '/$1' },
      status: 308,
      priority: true,
    },
  ];
}

/**
 * The redirects `next build` adds for a build that keeps `trailingSlash` on and does not skip its
 * redirect (`loadCustomRoutes`), ahead of any of `next.config`'s: a path whose last segment names a
 * file loses the slash, unless a `_next/data` request asks; any other path gains one — the base
 * path's own spelling first, since the others are not written under it.
 */
export function trailingSlashRedirects(basePath: string): Route[] {
  const escaped = escapedSource(basePath);
  const root: Route[] =
    basePath === ''
      ? []
      : [
          {
            source: basePath,
            sourceRegex: `^${escaped}$`,
            headers: { Location: `${basePath}/` },
            status: 308,
            priority: true,
          },
        ];
  return [
    ...root,
    {
      source: String.raw`/:file((?!\.well-known(?:/.*)?)(?:[^/]+/)*[^/]+\.\w+)/`,
      sourceRegex: String.raw`^(?:\/((?!\.well-known(?:\/.*)?)(?:[^/]+\/)*[^/]+\.\w+))\/$`,
      headers: { Location: '/$1' },
      status: 308,
      missing: [{ type: 'header', key: 'x-nextjs-data' }],
      priority: true,
    },
    {
      source: String.raw`/:notfile((?!\.well-known(?:/.*)?)(?:[^/]+/)*[^/\.]+)`,
      sourceRegex: String.raw`^(?:\/((?!\.well-known(?:\/.*)?)(?:[^/]+\/)*[^/\.]+))$`,
      headers: { Location: '/$1/' },
      status: 308,
      priority: true,
    },
  ];
}

/** A pathname of the build under its base path, as `next build` names it (`normalizePathnames`). */
function underBasePath(basePath: string, pathname: string): string {
  return basePath === '' ? pathname : `${basePath}${pathname}`.replace(/\/$/u, '') || '/';
}

/** A prerender of the build under its base path: its pathname, and the entry its route names. */
function prerenderUnder(basePath: string, prerender: Prerender): Prerender {
  return {
    ...prerender,
    pathname: underBasePath(basePath, prerender.pathname),
    route: underBasePath(basePath, prerender.route),
    parentOutputId: underBasePath(basePath, prerender.parentOutputId),
  };
}

export interface FixtureBundleOptions {
  readonly headerRules?: readonly Route[] | undefined;
  /** Redirects of `next.config`: evaluated after the header rules, and before the middleware. */
  readonly redirects?: readonly Route[] | undefined;
  /**
   * A `basePath`, written where `next build` writes it: into every pathname of the build, its
   * dynamic route and its own `onMatch` rule. The rules passed in beside it are taken as written.
   */
  readonly basePath?: string | undefined;
  /**
   * An `i18n` configuration, whose routing the edge does not reproduce. Only the configuration: the
   * pathnames stay the fixture's own, which is enough to ask which of them the edge keeps. Locale
   * detection is off unless `detectsLocale` says otherwise, so that the root is a page like any.
   */
  readonly i18n?: boolean | undefined;
  /** Locale detection left on, as Next.js leaves it: the root picks a locale per request. */
  readonly detectsLocale?: boolean | undefined;
  /** `i18n.domains`: every page in the locale of the host it is asked on. */
  readonly localeDomains?: boolean | undefined;
  /**
   * `trailingSlash`: the pages are kept behind a trailing slash. Only the configuration — the
   * redirects `next build` adds for it are `trailingSlashRedirects`, passed as `redirects`.
   */
  readonly trailingSlash?: boolean | undefined;
  /** `skipTrailingSlashRedirect`: `next build` writes no redirect of a path's slash either way. */
  readonly skipTrailingSlashRedirect?: boolean | undefined;
  /** Rewrites `next.config` puts ahead of the filesystem, which claim a path from the build. */
  readonly beforeFiles?: readonly Route[] | undefined;
}

function i18nConfig(options: FixtureBundleOptions): NonNullable<DeploymentBundle['config']['i18n']> {
  return {
    defaultLocale: 'en',
    locales: ['en', 'fr'],
    ...(options.detectsLocale !== true && { localeDetection: false as const }),
    ...(options.localeDomains === true && {
      domains: [{ domain: 'example.fr', defaultLocale: 'fr' }],
    }),
  };
}

export function fixtureBundle(options: FixtureBundleOptions = {}): DeploymentBundle {
  const basePath = options.basePath ?? '';
  const named = (pathname: string): string => underBasePath(basePath, pathname);
  return {
    v: 1,
    deploymentId: FIXTURE_DEPLOYMENT_ID,
    nextVersion: '16.3.5',
    buildId: 'build-TfctsWXpff2fKS',
    projectDir: 'fixtures/next-minimal',
    generatedAt: FIXTURE_GENERATED_AT,
    config: {
      basePath,
      trailingSlash: options.trailingSlash ?? false,
      skipTrailingSlashRedirect: options.skipTrailingSlashRedirect ?? false,
      poweredByHeader: false,
      ...(options.i18n === true && { i18n: i18nConfig(options) }),
    },
    routing: {
      beforeMiddleware: [...(options.headerRules ?? []), ...(options.redirects ?? [])],
      middlewareMatchers: [],
      beforeFiles: [...(options.beforeFiles ?? [])],
      afterFiles: [],
      dynamicRoutes: [itemsRoute(basePath)],
      onMatch: onMatchRules(basePath),
      fallback: [],
      shouldNormalizeNextData: false,
      rsc: {
        header: 'rsc',
        varyHeader: 'rsc, next-router-state-tree, next-router-prefetch',
        prefetchHeader: 'next-router-prefetch',
        didPostponeHeader: 'x-nextjs-postponed',
        contentTypeHeader: RSC,
        suffix: '.rsc',
        prefetchSuffix: '.prefetch.rsc',
        prefetchSegmentHeader: 'next-router-segment-prefetch',
        prefetchSegmentSuffix: '.segment.rsc',
        prefetchSegmentDirSuffix: '.segments',
      },
    },
    entrypoints: [
      { id: 'app/page', kind: 'app-page', pathname: named('/') },
      { id: 'app/items/[id]/page', kind: 'app-page', pathname: named('/items/[id]') },
      { id: 'app/static/page', kind: 'app-page', pathname: named('/static') },
      { id: 'app/stream/page', kind: 'app-page', pathname: named('/stream') },
    ],
    prerenders: FIXTURE_PRERENDERS.map((prerender) => prerenderUnder(basePath, prerender)),
    staticFiles: [
      {
        pathname: named('/_next/static/chunks/main-abc123.js'),
        blob: MAIN_CHUNK,
        immutable: true,
      },
      { pathname: named('/_next/static/css/app-def456.css'), blob: STYLES, immutable: true },
      { pathname: named('/hello.txt'), blob: HELLO_TXT, immutable: false },
    ],
    functions: {
      app: {
        mainModule: 'index.mjs',
        modules: [{ name: 'index.mjs', type: 'esm', blob: APP_MODULE }],
        compatibilityDate: '2026-09-15',
        compatibilityFlags: ['nodejs_compat'],
      },
    },
  };
}
