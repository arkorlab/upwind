import { resolveRoutes } from '@next/routing';
import { describe, expect, it } from 'vitest';

import { dataPagePathOf, localizedDataUrl } from '../src/data-locale.ts';

const BUILD = 'build';
const I18N = {
  defaultLocale: 'en',
  locales: ['en', 'es', 'fr'],
  domains: [{ domain: 'example.fr', defaultLocale: 'fr' }],
};

/** A deployment of an application with `i18n` and a middleware, under `basePath`. */
function manifest(basePath = '', middleware = true) {
  return {
    buildId: BUILD,
    config: { basePath },
    routing: { middlewareMatchers: middleware ? [{ sourceRegex: '^/.*$' }] : [] },
  };
}

function localized(href: string, basePath = ''): string {
  const url = localizedDataUrl(manifest(basePath), I18N, new URL(href));
  return `${url.pathname}${url.search}`;
}

describe('a Pages Router data request that names no locale', () => {
  it('is routed under the default locale, as Next.js routes it', () => {
    expect(localized('https://example.com/_next/data/build/middleware/works.json?a=1')).toBe(
      '/_next/data/build/en/middleware/works.json?a=1',
    );
    // The home page's data is the default locale's own.
    expect(localized('https://example.com/_next/data/build/index.json')).toBe(
      '/_next/data/build/en.json',
    );
  });

  it('is read as Next.js reads a page under `index/`, the page without it', () => {
    expect(localized('https://example.com/_next/data/build/index/about.json')).toBe(
      '/_next/data/build/en/about.json',
    );
  });

  /** Next.js keeps `index/` in front of a name with a dynamic segment (`isDynamicRoute`). */
  it('keeps `index/` in front of a name with a dynamic segment, as Next.js keeps it', () => {
    expect(localized('https://example.com/_next/data/build/index/[slug].json')).toBe(
      '/_next/data/build/en/index/[slug].json',
    );
  });

  /** Next.js answers `/_next/data/<id>/.json` with the home page, as it answers `index.json`. */
  it('reads an empty name as the home page’s, as Next.js reads it', () => {
    expect(localized('https://example.com/_next/data/build/.json')).toBe(
      '/_next/data/build/en.json',
    );
  });

  it('is routed under the default locale of the domain it was asked on', () => {
    expect(localized('https://example.fr/_next/data/build/about.json')).toBe(
      '/_next/data/build/fr/about.json',
    );
  });

  it('is routed under the base path it was asked under', () => {
    expect(localized('https://example.com/docs/_next/data/build/about.json', '/docs')).toBe(
      '/docs/_next/data/build/en/about.json',
    );
  });
});

describe('a data request that names no locale, in an application without a middleware', () => {
  it('is routed as it came: Next.js reads it under no locale either, and answers 404', () => {
    const url = new URL('https://example.com/_next/data/build/about.json');

    expect(localizedDataUrl(manifest('', false), I18N, url)).toBe(url);
  });
});

describe('any other request', () => {
  it.each([
    // A locale named already, in any case Next.js reads one in.
    'https://example.com/_next/data/build/es/about.json',
    'https://example.com/_next/data/build/ES/about.json',
    'https://example.com/_next/data/build/en.json',
    // A locale named under `index/`, which Next.js reads the page without.
    'https://example.com/_next/data/build/index/es/about.json',
    // Another build's data, a path that is not data, and Next.js's own.
    'https://example.com/_next/data/other/about.json',
    'https://example.com/about',
    'https://example.com/_next/data/build/about',
    'https://example.com/_next/data/build/_next/static/chunk.json',
  ])('is routed as it came: %s', (href) => {
    const url = new URL(href);

    expect(localizedDataUrl(manifest(), I18N, url)).toBe(url);
  });
});

/**
 * The names and data routes Next.js 16.4.3 writes for a Pages Router application with `i18n`
 * (`en`, `es`, `localeDetection: false`) and a middleware: a catch-all page, and a home page with
 * `getStaticProps`, prerendered a locale with its data. The data route reads the locale off the
 * first segment.
 */
const PATHNAMES = [
  '/[...route]',
  `/_next/data/${BUILD}/[...route].json`,
  '/en/[...route]',
  `/_next/data/${BUILD}/en/[...route].json`,
  '/es/[...route]',
  `/_next/data/${BUILD}/es/[...route].json`,
  '/en',
  '/es',
  `/_next/data/${BUILD}/en.json`,
  `/_next/data/${BUILD}/es.json`,
];
const DYNAMIC_ROUTES = [
  {
    sourceRegex: `^/_next/data/${BUILD}[/]?(?<nextLocale>[^/]{1,})/(?<nxtProute>.+?)\\.json(?:/)?$`,
    destination: `/_next/data/${BUILD}/$nextLocale/[...route].json?nxtProute=$nxtProute`,
  },
  {
    sourceRegex: '^[/]?(?<nextLocale>[^/]{1,})/(?<nxtProute>.+?)(?:/)?$',
    destination: '/$nextLocale/[...route]?nxtProute=$nxtProute',
  },
];
const ROUTED_I18N = { defaultLocale: 'en', locales: ['en', 'es'], localeDetection: false as const };

/** What `@next/routing` resolves `url` to, by those tables. */
async function routed(url: URL) {
  const result = await resolveRoutes({
    url,
    buildId: BUILD,
    basePath: '',
    requestBody: new ReadableStream(),
    headers: new Headers(),
    pathnames: PATHNAMES,
    i18n: ROUTED_I18N,
    routes: {
      beforeMiddleware: [],
      middlewareMatchers: [],
      beforeFiles: [],
      afterFiles: [],
      dynamicRoutes: DYNAMIC_ROUTES,
      onMatch: [],
      fallback: [],
      shouldNormalizeNextData: true,
    },
    invokeMiddleware: () => Promise.resolve({}),
  });
  return { page: result.resolvedPathname, locale: result.routeMatches?.['nextLocale'] };
}

describe('a data request that names no locale, routed by the tables Next.js writes', () => {
  it('finds no page as it came, and its default locale’s page once localized', async () => {
    const asked = new URL(`https://example.com/_next/data/${BUILD}/middleware/works.json`);

    await expect(routed(asked)).resolves.toStrictEqual({ page: undefined, locale: undefined });

    const withLocale = localizedDataUrl(manifest(), ROUTED_I18N, asked);

    await expect(routed(withLocale)).resolves.toStrictEqual({
      page: '/en/[...route]',
      locale: 'en',
    });
  });

  it('finds the default locale’s home page for the home page’s data', async () => {
    const asked = new URL(`https://example.com/_next/data/${BUILD}/index.json`);

    await expect(routed(asked)).resolves.toStrictEqual({ page: undefined, locale: undefined });

    const withLocale = localizedDataUrl(manifest(), ROUTED_I18N, asked);

    await expect(routed(withLocale)).resolves.toStrictEqual({
      page: `/_next/data/${BUILD}/en.json`,
      locale: undefined,
    });
  });

  it('finds the page a request names the locale of as it did', async () => {
    const asked = new URL(`https://example.com/_next/data/${BUILD}/es/middleware/works.json`);

    await expect(routed(asked)).resolves.toStrictEqual({ page: '/es/[...route]', locale: 'es' });
  });
});

/** `denormalizePagePath`, which Next.js reads a data request's page with (`NextDataPathnameNormalizer`). */
describe('the page a data request names', () => {
  it.each([
    ['index', '/'],
    ['', '/'],
    ['about', '/about'],
    ['index/about', '/about'],
    ['index/index', '/index'],
    ['index/index/about', '/index/about'],
    ['indexed', '/indexed'],
    // A dynamic segment keeps the name whole; a bracket inside a segment is not one.
    ['index/[slug]', '/index/[slug]'],
    ['index/[slug]/edit', '/index/[slug]/edit'],
    ['index/a[b]', '/a[b]'],
    ['index/%5Bslug%5D', '/%5Bslug%5D'],
    ['about/', '/about/'],
  ])('%j is %j', (named, page) => {
    expect(dataPagePathOf(named)).toBe(page);
  });
});
