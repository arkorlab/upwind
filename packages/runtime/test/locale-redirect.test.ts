import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

import { preferredLocaleRedirect } from '../src/locale-redirect.ts';

const require = createRequire(process.env['UPWIND_MATCHER_NEXT_PACKAGE'] ?? import.meta.url);
const { getLocaleRedirect } = require('next/dist/shared/lib/i18n/get-locale-redirect.js') as {
  getLocaleRedirect: (options: {
    defaultLocale: string;
    domainLocale?: Domain;
    headers: Record<string, string>;
    nextConfig: Config;
    urlParsed: { pathname: string; search: string; hash: string };
  }) => string | undefined;
};

interface Domain {
  readonly domain: string;
  readonly defaultLocale: string;
  readonly http?: true;
  readonly locales?: string[];
}
interface Config {
  readonly basePath: string;
  readonly trailingSlash: boolean;
  readonly i18n: {
    readonly defaultLocale: string;
    readonly locales: string[];
    readonly localeDetection?: false;
    readonly domains?: Domain[];
  };
}

const I18N = { defaultLocale: 'en', locales: ['en', 'fr', 'fr-BE', 'nl'] };
const DOMAINS: Domain[] = [
  { domain: 'en.example.test', defaultLocale: 'en' },
  { domain: 'fr.example.test', defaultLocale: 'fr', locales: ['fr-BE'] },
  { domain: 'nl.example.test', defaultLocale: 'nl', http: true },
];
const CONFIGS: Config[] = [
  { basePath: '', trailingSlash: false, i18n: I18N },
  { basePath: '/base', trailingSlash: false, i18n: I18N },
  { basePath: '/base', trailingSlash: true, i18n: I18N },
  { basePath: '/base', trailingSlash: false, i18n: { ...I18N, domains: DOMAINS } },
  { basePath: '/base', trailingSlash: false, i18n: { ...I18N, localeDetection: false } },
];
const HEADERS: Record<string, string>[] = [
  {},
  { 'accept-language': 'fr' },
  { 'accept-language': 'fr-BE,fr;q=0.9,en;q=0.2' },
  { 'accept-language': 'nl' },
  { 'accept-language': 'unsupported' },
  { 'accept-language': '*' },
  { 'accept-language': 'fr;q=0' },
  { 'accept-language': 'en;q=0,fr;q=0.5' },
  { 'accept-language': 'fr', cookie: 'NEXT_LOCALE=en' },
  { 'accept-language': 'en', cookie: 'NEXT_LOCALE=FR' },
  { 'accept-language': 'en', cookie: 'NEXT_LOCALE=%66%72' },
  { 'accept-language': 'en', cookie: 'NEXT_LOCALE=fr; NEXT_LOCALE=en' },
  { 'accept-language': 'en', cookie: 'NEXT_LOCALE="fr"' },
  { 'accept-language': 'en', cookie: 'NEXT_LOCALE= fr ' },
  { 'accept-language': 'en', cookie: 'NEXT_LOCALE; NEXT_LOCALE=fr' },
  { 'accept-language': 'fr', cookie: 'NEXT_LOCALE=not-a-locale' },
  { 'accept-language': 'fr', cookie: 'NEXT_LOCALE=%ZZ' },
  { 'accept-language': 'fr;q=invalid' },
];

describe('root locale redirects', () => {
  it.each(CONFIGS)('agrees with the installed Next.js locale helper for %j', (config) => {
    for (const host of ['en.example.test', 'fr.example.test', 'unknown.example.test']) {
      for (const suffix of [
        '',
        '/',
        '/index',
        '/index/',
        '/inspect',
        '/fr/',
        '/_next/data/b/en.json',
      ]) {
        const pathname = `${config.basePath}${suffix}`;
        const url = new URL(`https://${host}${pathname}?q=%2F&x=1`);
        const domain = config.i18n.domains?.find((entry) => entry.domain === host);
        for (const fields of HEADERS) {
          const expected = getLocaleRedirect({
            defaultLocale: domain?.defaultLocale ?? config.i18n.defaultLocale,
            ...(domain !== undefined && { domainLocale: domain }),
            headers: fields,
            nextConfig: config,
            urlParsed: { pathname: suffix || '/', search: url.search, hash: url.hash },
          });

          expect(preferredLocaleRedirect(config, url, new Headers(fields))).toBe(expected);
        }
      }
    }
  });

  it('does no locale negotiation without i18n', () => {
    const config = { basePath: '', trailingSlash: false, i18n: null };

    expect(
      preferredLocaleRedirect(config, new URL('https://example.test/'), new Headers()),
    ).toBeUndefined();
  });
});
