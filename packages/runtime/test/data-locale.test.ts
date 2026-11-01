import { describe, expect, it } from 'vitest';

import { localizedDataUrl } from '../src/data-locale.ts';

const BUILD = 'build';
const I18N = {
  defaultLocale: 'en',
  locales: ['en', 'es', 'fr'],
  domains: [{ domain: 'example.fr', defaultLocale: 'fr' }],
};

function localized(href: string, basePath = ''): string {
  const url = localizedDataUrl({ basePath }, I18N, BUILD, new URL(href));
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

describe('any other request', () => {
  it.each([
    // A locale named already, in any case Next.js reads one in.
    'https://example.com/_next/data/build/es/about.json',
    'https://example.com/_next/data/build/ES/about.json',
    'https://example.com/_next/data/build/en.json',
    // Another build's data, a path that is not data, and Next.js's own.
    'https://example.com/_next/data/other/about.json',
    'https://example.com/about',
    'https://example.com/_next/data/build/about',
    'https://example.com/_next/data/build/_next/static/chunk.json',
  ])('is routed as it came: %s', (href) => {
    const url = new URL(href);

    expect(localizedDataUrl({ basePath: '' }, I18N, BUILD, url)).toBe(url);
  });
});
