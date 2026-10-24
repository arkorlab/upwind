import type { RouteHas } from '../../src/bundle/schema.ts';
import { buildProjectManifest } from '../../src/manifest/manifest.ts';
import type {
  DynamicRoute,
  HeaderRule,
  MiddlewareMatcher,
  ProjectManifest,
  ReservedRoute,
  RouteEntry,
} from '../../src/manifest/schema.ts';

/**
 * The routing of a large application as `next build` hands it to an adapter
 * (`build/adapter/build-complete.ts`), and as a manifest carries it: every Pages Router data route
 * first, every App Router prefetch segment route after them, and then each page's RSC variant
 * beside the page, in the order Next.js sorts its pages. The patterns are spelled as Next.js
 * spells them (`getNamedRouteRegex` with prefixed keys, `escapeStringRegexp` for a static
 * segment), so two thirds of the list are data routes, as in a real application's.
 */

export const BUILD_ID = 'Bu1ld-ID_x';
const PREVIEW_MODE_ID = 'preview-7f3a';
/** Next.js's own list of crawlers it renders whole, as a prerender's `bypassFor` carries it. */
export const HTML_LIMITED_BOTS = String.raw`[\w-]+-Google|Google-[\w-]+|Chrome-Lighthouse|Slurp|DuckDuckBot|baiduspider|yandex|sogou|bitlybot|tumblr|vkShare|quora link preview|redditbot|ia_archiver|Bingbot|BingPreview|applebot|facebookexternalhit|facebookcatalog|Twitterbot|LinkedInBot|Slackbot|Discordbot|WhatsApp|SkypeUriPreview|Yeti|googleweblight`;
/** What a `fallback: false` page is served under: draft mode, and nothing else. */
export const DRAFT_COOKIES = `__prerender_bypass=${PREVIEW_MODE_ID}; __next_preview_data=1`;

type Router = 'app' | 'pages' | 'route';

export interface PageTemplate {
  readonly page: string;
  readonly router: Router;
  /** The build made a class shell of it, which the manifest names as a route. */
  readonly shell: boolean;
  /** `fallback: false`: matched only in draft mode (`has`), as the build writes it. */
  readonly fallbackFalse: boolean;
}

const OPTIONAL_CATCH_ALL = /^\[\[\.\.\.(\w+)\]\]$/u;
const CATCH_ALL = /^\[\.\.\.(\w+)\]$/u;
const DYNAMIC = /^\[(\w+)\]$/u;
const TAIL = '(?:/)?$';
const RSC_SUFFIX = String.raw`(?<rscSuffix>\.rsc|\.segments/.+\.segment\.rsc)(?:/)?$`;
const SEGMENT_SUFFIX = String.raw`(?<segment>/__PAGE__\.segment\.rsc|\.segment\.rsc)(?:/)?$`;
const FALLBACK_FALSE_HAS: readonly RouteHas[] = [
  { type: 'cookie', key: '__prerender_bypass', value: PREVIEW_MODE_ID },
  { type: 'cookie', key: '__next_preview_data' },
];
const SECTIONS = [
  'analytics',
  'billing',
  'blog',
  'builds',
  'changelog',
  'cron',
  'deployments',
  'docs',
  'domains',
  'env',
  'integrations',
  'logs',
  'members',
  'settings',
  'shop',
  'storage',
  'team',
  'tokens',
  'usage',
  'webhooks',
];

/** `escapeStringRegexp`, as Next.js escapes a static segment. */
function escaped(text: string): string {
  return text.replaceAll(/[$()*+.?[\\\]^{|}-]/gu, String.raw`\$&`);
}

export function segmentsOf(page: string): string[] {
  return page.split('/').slice(1);
}

/** The page's pattern short of its tail, as `getNamedRouteRegex` spells it with prefixed keys. */
function patternBody(page: string): string {
  return segmentsOf(page)
    .map((segment) => {
      const optional = OPTIONAL_CATCH_ALL.exec(segment)?.[1];
      if (optional !== undefined) {
        return `(?:/(?<nxtP${optional}>.+?))?`;
      }
      const catchAll = CATCH_ALL.exec(segment)?.[1];
      if (catchAll !== undefined) {
        return `/(?<nxtP${catchAll}>.+?)`;
      }
      const dynamic = DYNAMIC.exec(segment)?.[1];
      return dynamic === undefined ? `/${escaped(segment)}` : `/(?<nxtP${dynamic}>[^/]+?)`;
    })
    .join('');
}

/** How a prefetch segment's path names each segment of the page: `$d$slug`, `$c$`, `$oc$`. */
export function segmentPathOf(page: string): string {
  return segmentsOf(page)
    .map((segment) => {
      const optional = OPTIONAL_CATCH_ALL.exec(segment)?.[1];
      if (optional !== undefined) {
        return `$oc$${optional}`;
      }
      const catchAll = CATCH_ALL.exec(segment)?.[1];
      if (catchAll !== undefined) {
        return `$c$${catchAll}`;
      }
      const dynamic = DYNAMIC.exec(segment)?.[1];
      return dynamic === undefined ? segment : `$d$${dynamic}`;
    })
    .join('/');
}

function rank(segment: string): number {
  if (OPTIONAL_CATCH_ALL.test(segment)) {
    return 3;
  }
  if (CATCH_ALL.test(segment)) {
    return 2;
  }
  return DYNAMIC.test(segment) ? 1 : 0;
}

/** Two segments in Next.js's order: by rank (`rank`), then by name. */
function bySegment(x: string, y: string): number {
  const difference = rank(x) - rank(y);
  if (difference !== 0) {
    return difference;
  }
  if (x === y) {
    return 0;
  }
  return x < y ? -1 : 1;
}

/** Next.js's order: a static segment before a dynamic one, a catch-all after both, a page before its children. */
function bySpecificity(left: PageTemplate, right: PageTemplate): number {
  const a = segmentsOf(left.page);
  const b = segmentsOf(right.page);
  let index = 0;
  while (index < a.length && index < b.length && a[index] === b[index]) {
    index += 1;
  }
  const [x, y] = [a.at(index), b.at(index)];
  return x === undefined || y === undefined ? a.length - b.length : bySegment(x, y);
}

function template(
  page: string,
  router: Router,
  options: Partial<Pick<PageTemplate, 'fallbackFalse' | 'shell'>> = {},
): PageTemplate {
  return { page, router, shell: options.shell ?? false, fallbackFalse: options.fallbackFalse ?? false };
}

/** The application's dynamic pages, in Next.js's order. */
export function pageTemplates(): PageTemplate[] {
  const pages = [
    template('/[locale]', 'app'),
    template('/[locale]/login', 'app'),
    template('/[locale]/login/done', 'app'),
    template('/en/[orgSlug]', 'app', { shell: true }),
    template('/ja/[orgSlug]', 'app', { shell: true }),
    template('/[locale]/[orgSlug]', 'app'),
    template('/[locale]/[orgSlug]/[projectId]', 'app', { shell: true }),
    template('/api/auth/[...all]', 'route'),
  ];
  for (const [index, section] of SECTIONS.entries()) {
    pages.push(
      template(`/en/${section}/[slug]`, 'app', { shell: true }),
      template(`/ja/${section}/[slug]`, 'app', { shell: true }),
      template(`/[locale]/${section}`, 'app'),
      template(`/[locale]/${section}/[slug]`, 'app', { fallbackFalse: index % 4 === 0 }),
      template(`/[locale]/[orgSlug]/${section}`, 'app'),
      template(`/[locale]/[orgSlug]/[projectId]/${section}/[id]`, 'app', {
        shell: index % 2 === 0,
      }),
      template(`/[locale]/${section}/[...rest]`, 'app'),
      template(`/${section}/[[...path]]`, 'app'),
      template(`/legacy/${section}/[slug]`, 'pages', {
        fallbackFalse: index % 3 === 0,
        shell: index % 5 === 0,
      }),
    );
  }
  return pages.toSorted(bySpecificity);
}

function conditioned(on: boolean): Pick<DynamicRoute, 'has'> {
  return on ? { has: [...FALLBACK_FALSE_HAS] } : {};
}

/** The dynamic routes of `pages` as `build-complete.ts` combines them, data routes first. */
function nextDynamicRoutes(pages: readonly PageTemplate[]): DynamicRoute[] {
  const data = pages
    .filter((page) => page.router === 'pages')
    .map((page) => {
      return {
        sourceRegex: String.raw`^/_next/data/${escaped(BUILD_ID)}[/]?${patternBody(page.page)}\.json${TAIL}`,
        ...conditioned(page.fallbackFalse),
      };
    });
  const segments = pages
    .filter((page) => page.router === 'app')
    .map((page) => {
      const path = segmentPathOf(page.page).replaceAll('$', String.raw`\$`);
      return { sourceRegex: String.raw`^[/]?${patternBody(page.page)}\.segments/${path}${SEGMENT_SUFFIX}` };
    });
  const pairs = pages.flatMap((page): DynamicRoute[] => {
    return [
      {
        sourceRegex: `^[/]?${patternBody(page.page)}${RSC_SUFFIX}`,
        ...conditioned(page.fallbackFalse && page.router === 'app'),
      },
      {
        sourceRegex: `^[/]?${patternBody(page.page)}${TAIL}`,
        ...conditioned(page.fallbackFalse),
        ...(page.shell && { route: page.page }),
      },
    ];
  });
  return [...data, ...segments, ...pairs];
}

/** Redirects and rewrites ahead of the dynamic routes, some of them conditional. */
const RESERVED_ROUTES: ReservedRoute[] = [
  { sourceRegex: '^/old-blog(?:/(.*))?(?:/)?$', beforeFiles: true },
  { sourceRegex: '^/ingest(?:/(.*))?(?:/)?$' },
  {
    sourceRegex: '^/en/shop/(?<slug>[^/]+?)(?:/)?$',
    has: [{ type: 'query', key: 'variant', value: '(?<variant>red|blue)' }],
    beforeFiles: true,
  },
  {
    sourceRegex: '^/(?<locale>[^/]+?)/legacy(?:/(.*))?(?:/)?$',
    has: [{ type: 'header', key: 'x-legacy' }],
  },
  {
    sourceRegex: '^/(?<locale>[^/]+?)/team(?:/)?$',
    missing: [{ type: 'cookie', key: 'session' }],
  },
  { sourceRegex: '^/(.*)$', has: [{ type: 'host', value: String.raw`docs\.example\.com` }] },
];

const HEADER_RULES: HeaderRule[] = [
  { sourceRegex: '^/(.*)$', headers: { 'X-Frame-Options': 'DENY' } },
  { sourceRegex: '^/en/blog/([^/]+?)(?:/)?$', headers: { 'x-post': '$1' } },
  {
    sourceRegex: '^/(?<locale>[^/]+?)/docs(?:/(.*))?(?:/)?$',
    has: [{ type: 'query', key: 'utm_source' }],
    headers: { 'x-campaign': ':locale' },
  },
  {
    sourceRegex: '^/(?<locale>[^/]+?)/(?<org>[^/]+?)(?:/)?$',
    missing: [{ type: 'cookie', key: 'session' }],
    headers: { 'Cache-Control': 'private', 'x-org': '$org' },
    documentHeaders: { 'Cache-Control': 'private', 'x-org': '$org', 'x-document': '1' },
  },
];

/** Matchers as Next.js compiles a `proxy.ts`'s `matcher`: its own data routes, and a gate. */
export const MIDDLEWARE_MATCHERS: MiddlewareMatcher[] = [
  {
    sourceRegex: String.raw`^(?:\/(_next\/data\/[^/]{1,}))?(?:\/((?!api|_next\/static|_next\/image|favicon.ico).*))(\.json)?[\/#\?]?$`,
  },
  {
    sourceRegex: String.raw`^(?:\/(_next\/data\/[^/]{1,}))?\/account(?:\/((?:[^\/#\?]+?)(?:\/(?:[^\/#\?]+?))*))?(\.json)?[\/#\?]?$`,
    has: [{ type: 'cookie', key: 'session' }],
  },
  { sourceRegex: String.raw`^(?:\/((?!api\/|_next\/|.*\..*).*))[\/#\?]?$` },
  { sourceRegex: String.raw`^\/vercel copy\.svg[\/#\?]?$` },
];

function shellEntry(pathname: string): RouteEntry {
  return {
    pathname,
    status: 200,
    shell: { sha256: 'a'.repeat(64), byteLength: 10, contentType: 'text/html', encoding: 'identity' },
    headers: {},
  };
}

/** A manifest carrying the application's routing whole, with a shell for each class that has one. */
export function largeManifest(): ProjectManifest {
  const pages = pageTemplates();
  return buildProjectManifest({
    projectId: 'p',
    runId: 'r',
    generatedAt: '2026-09-29T00:00:00.000Z',
    originHost: 'app.example.com',
    deployment: { dplId: 'dpl_active', assetSetHash: 'h', observedAt: '2026-09-29T00:00:00.000Z' },
    routes: pages.filter((page) => page.shell).map((page) => shellEntry(page.page)),
    app: { deploymentId: 'dpl_active', scriptName: 'app' },
    dynamicRoutes: nextDynamicRoutes(pages),
    reservedRoutes: RESERVED_ROUTES,
    headerRules: HEADER_RULES,
    foldedHeaderRules: HEADER_RULES.filter((rule) => rule.has === undefined && rule.missing === undefined),
    middleware: { matchers: MIDDLEWARE_MATCHERS },
  });
}
