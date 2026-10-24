import path from 'node:path';

import type { Route } from '@stayingupwind/core/bundle';
import {
  collectFallbackShellRuns,
  type FallbackShellRun,
} from 'next/dist/build/adapter/fallback-shell-runs.js';
import { escapeStringRegexp } from 'next/dist/shared/lib/escape-regexp.js';
import { getNamedRouteRegex } from 'next/dist/shared/lib/router/utils/route-regex.js';
import { describe, expect, it } from 'vitest';

import { type PageRoute, pageRoutes } from '../../core/src/bundle/page-routes.ts';

/**
 * The dynamic routes 16.4 hands an adapter, collapsed (`experimental.collapseAdapterRoutes`, its
 * default) and not, read back into the pages they land a request on (`pageRoutes`). The tables are
 * built the way `build/adapter/build-complete.ts` builds them, with Next.js's own pieces of it: the
 * pattern of a page (`getNamedRouteRegex`), the escaping of a static segment and of the `basePath`
 * (`escapeStringRegexp`), and the runs of fallback shells one entry serves
 * (`collectFallbackShellRuns`).
 */

interface Page {
  readonly page: string;
  readonly router: 'app' | 'pages';
  /** The source page of a fallback shell, which resolves the leading parameters of that page. */
  readonly sourcePage?: string;
  readonly fallbackFalse?: boolean;
}

const FALLBACK_FALSE_HAS: NonNullable<Route['has']> = [
  { type: 'cookie', key: '__prerender_bypass', value: 'preview-id' },
];
/** How a page's own pattern ends, which 16.4 replaces to take a suffix as well. */
const PAGE_END = '(?:/)?$';
const DOCUMENT_OR_DATA = String.raw`(\.rsc|\.segments/.+\.segment\.rsc|)(?:/)?$`;
const DATA_ONLY = String.raw`(\.rsc|\.segments/.+\.segment\.rsc)(?:/)?$`;

function query(routeKeys: Record<string, string>): string {
  const pairs = Object.entries(routeKeys).map(([key, value]) => `${value}=$${key}`);
  return pairs.length === 0 ? '' : `?${pairs.join('&')}`;
}

/** What every entry 16.4 writes for a page is made of (`build/adapter/build-complete.ts`). */
interface Parts {
  readonly pagePath: string;
  readonly sourceRegex: string;
  readonly destination: string;
  /** The destination with the reference to the group that captures a suffix, as 16.4 adds it. */
  readonly suffixed: string;
  readonly suffixedHas: Route['has'];
  readonly plainHas: Route['has'];
}

function partsOf(page: Page, run: FallbackShellRun | undefined, basePath: string): Parts {
  const { namedRegex, routeKeys } = getNamedRouteRegex(page.page, { prefixRouteKeys: true });
  const prefixes = run?.prefixes.map((prefix) => escapeStringRegexp(prefix)).join('|');
  const pagePattern =
    run === undefined
      ? namedRegex
      : namedRegex.replace(
          `^/${escapeStringRegexp(run.prefixes[0] ?? '')}/`,
          () => `^/(${prefixes ?? ''})/`,
        );
  const escapedBasePath = basePath === '' ? '' : escapeStringRegexp(path.posix.join('/', basePath));
  const pagePath = run === undefined ? page.page : path.posix.join('/', '$1', run.tail);
  const destination = path.posix.join('/', basePath, pagePath) + query(routeKeys);
  const suffixCapture = Object.keys(routeKeys).length + (run === undefined ? 0 : 1) + 1;
  const fallbackFalse = page.fallbackFalse === true;
  return {
    pagePath,
    sourceRegex: pagePattern.replace('^', () => `^${escapedBasePath}[/]?`),
    destination,
    suffixed: destination.replace(/$|\?/u, (end) => `$${String(suffixCapture)}${end}`),
    suffixedHas: fallbackFalse && page.router !== 'pages' ? FALLBACK_FALSE_HAS : undefined,
    plainHas: fallbackFalse ? FALLBACK_FALSE_HAS : undefined,
  };
}

/** The entries for one page: one for it and its data, or one for its data and one for it. */
function entriesOf(parts: Parts, merged: boolean, hasAppPages: boolean): Route[] {
  const { pagePath, sourceRegex, destination, suffixed, suffixedHas, plainHas } = parts;
  if (merged) {
    return [
      {
        source: pagePath,
        sourceRegex: sourceRegex.replace(PAGE_END, () => DOCUMENT_OR_DATA),
        destination: suffixed,
        ...(plainHas !== undefined && { has: plainHas }),
      },
    ];
  }
  const page = { source: pagePath, sourceRegex, destination };
  return [
    ...(hasAppPages
      ? [
          {
            source: `${pagePath}.rsc`,
            sourceRegex: sourceRegex.replace(PAGE_END, () => DATA_ONLY),
            destination: suffixed,
            ...(suffixedHas !== undefined && { has: suffixedHas }),
          },
        ]
      : []),
    { ...page, ...(plainHas !== undefined && { has: plainHas }) },
  ];
}

/**
 * What a reading says of an entry: the pattern, the page it lands on or answers the data of, and
 * the conditions it holds under.
 */
function sayingOf({ route, sourceRegex, template, dataOf }: PageRoute): unknown {
  return { sourceRegex, template, dataOf, has: route.has };
}

function readOf(routes: readonly Route[], basePath = ''): unknown[] {
  return pageRoutes(routes, basePath).map((page) => sayingOf(page));
}

/** An application of both routers, with two runs of fallback shells in it. */
const PAGES: readonly Page[] = [
  { page: '/acme/en/posts/[id]', router: 'app', sourcePage: '/[team]/[locale]/posts/[id]' },
  { page: '/acme/de/posts/[id]', router: 'app', sourcePage: '/[team]/[locale]/posts/[id]' },
  { page: '/globex/en/posts/[id]', router: 'app', sourcePage: '/[team]/[locale]/posts/[id]' },
  { page: '/blog/[slug]', router: 'app' },
  { page: '/closed/[id]', router: 'app', fallbackFalse: true },
  { page: '/legacy/[id]', router: 'pages', fallbackFalse: true },
  { page: '/v1.0/[slug]', router: 'app', sourcePage: '/[version]/[slug]' },
  { page: '/v2-beta/[slug]', router: 'app', sourcePage: '/[version]/[slug]' },
  { page: '/[lang]/[slug]', router: 'app' },
  { page: '/docs/[...path]', router: 'app' },
  { page: '/shop/[[...rest]]', router: 'app' },
];

/** `routing.dynamicRoutes` as 16.4 writes it for these pages, less the routes of each segment. */
function tableOf({
  collapse,
  basePath = '',
}: {
  readonly collapse: boolean;
  readonly basePath?: string;
}): Route[] {
  const runs = collapse
    ? collectFallbackShellRuns(
        PAGES as unknown as Parameters<typeof collectFallbackShellRuns>[0],
        (page) => PAGES.find((each) => each.page === page)?.fallbackFalse === true,
      )
    : undefined;
  const hasAppPages = PAGES.some((page) => page.router === 'app');
  return PAGES.flatMap((page) => {
    if (runs?.replacedPages.has(page.page) === true) {
      return [];
    }
    const parts = partsOf(page, runs?.byRepresentativePage.get(page.page), basePath);
    const merged = collapse && hasAppPages && parts.suffixedHas === parts.plainHas;
    return entriesOf(parts, merged, hasAppPages);
  });
}

describe('a route table 16.4 collapsed', () => {
  it('collapses runs and pages with their data, so there is something to read back', () => {
    const collapsed = tableOf({ collapse: true });

    expect(collapsed.map((route) => route.destination?.split('?', 1)[0])).toStrictEqual([
      '/$1/posts/[id]$3',
      '/blog/[slug]$2',
      '/closed/[id]$2',
      '/legacy/[id]$2',
      '/legacy/[id]',
      '/$1/[slug]$3',
      '/[lang]/[slug]$3',
      '/docs/[...path]$2',
      '/shop/[[...rest]]$2',
    ]);
  });

  it('reads as the table the build writes with the option off', () => {
    expect(readOf(tableOf({ collapse: true }))).toStrictEqual(readOf(tableOf({ collapse: false })));
  });

  /**
   * The base path is in a run's pattern and destination and not in its `source`, which is the page
   * as the build names it (`/$1/<tail>`): each shell is still read back on its own, base path and all.
   */
  it('reads so under a base path, a run shell by shell', () => {
    const basePath = '/docs.v2';
    const collapsed = tableOf({ collapse: true, basePath });

    expect(collapsed[0]?.source).toBe('/$1/posts/[id]');
    expect(readOf(collapsed, basePath)).toStrictEqual(
      readOf(tableOf({ collapse: false, basePath }), basePath),
    );
    expect(pageRoutes(collapsed, basePath).slice(0, 2)).toMatchObject([
      { dataOf: '/docs.v2/acme/en/posts/[id]' },
      { template: '/docs.v2/acme/en/posts/[id]' },
    ]);
  });

  it('names each page, a shell of a run under its own prefix, unescaped', () => {
    const templates = pageRoutes(tableOf({ collapse: true }), '').map(({ template }) => template);

    expect(templates.filter((template) => template !== undefined)).toStrictEqual([
      '/acme/en/posts/[id]',
      '/acme/de/posts/[id]',
      '/globex/en/posts/[id]',
      '/blog/[slug]',
      '/closed/[id]',
      '/legacy/[id]',
      '/v1.0/[slug]',
      '/v2-beta/[slug]',
      '/[lang]/[slug]',
      '/docs/[...path]',
      '/shop/[[...rest]]',
    ]);
  });

  /**
   * The page's entry is the one the edge serves a shell from, so a request for the page's data must
   * be taken first by the data's — as it was before 16.4, where the page's own pattern takes a
   * `.rsc` on the end of its last parameter too — and a request for the page by the page's.
   */
  it("lands the page on the page's entry first, and its data on the data's", () => {
    const read = pageRoutes(tableOf({ collapse: true }), '');
    const landing = (pathname: string): string | undefined => {
      const first = read.find(({ sourceRegex }) =>
        // eslint-disable-next-line security/detect-non-literal-regexp, require-unicode-regexp -- Next.js's own patterns, compiled as its router compiles them
        new RegExp(sourceRegex).test(pathname),
      );
      return first === undefined ? 'nothing' : first.template;
    };

    expect(landing('/blog/hello')).toBe('/blog/[slug]');
    expect(landing('/blog/hello.rsc')).toBeUndefined();
    expect(landing('/blog/hello.segments/_tree.segment.rsc')).toBeUndefined();
    expect(landing('/acme/de/posts/7')).toBe('/acme/de/posts/[id]');
    expect(landing('/globex/de/posts/7')).toBe('nothing');
    expect(landing('/v2-beta/x')).toBe('/v2-beta/[slug]');
    expect(landing('/v2-beta/x.rsc')).toBeUndefined();
  });

  it('reads an entry of no shape it knows as it is', () => {
    const route: Route = {
      source: '/blog/[slug]',
      sourceRegex: String.raw`^[/]?/blog/(?<nxtPslug>[^/]+?)(\.rsc|\.segments/.+\.segment\.rsc|)(?:/)?$`,
      destination: '/blog/[slug]?nxtPslug=$nxtPslug',
    };

    expect(pageRoutes([route], '')).toStrictEqual([
      { route, sourceRegex: route.sourceRegex, template: '/blog/[slug]' },
    ]);
  });
});
