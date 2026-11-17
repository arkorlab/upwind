import { describe, expect, it } from 'vitest';

import { shippedFileHeadersOf } from '../src/bundle/file-headers.ts';
import { BuildPatternBudget } from '../src/bundle/pattern-budget.ts';
import type { Route } from '../src/bundle/schema.ts';
import { headerRulesFor } from '../src/manifest/dynamic.ts';
import { type FixtureBundleOptions, fixtureBundle } from './fixtures/bundle.ts';

/**
 * What the rules of `next.config` with no condition set on a file the build shipped, for a build
 * with `i18n` — whose rules the edge does not judge on each request — as `next start` sets them:
 * its router matches a `public/` file with the default locale put in front of the path and a file
 * under `_next/` as it is (`resolve-routes.js`), and a rule `next build` writes itself with the
 * default locale taken out again (`handleRoute`).
 *
 * The rules are written as Next.js 16.4.6 hands them to an adapter for `i18n` with `en` and `fr`
 * (`loadCustomRoutes`, then `buildRouteFromHeader` in `build-complete.js`): a source the locale is
 * put in front of unless the rule says `locale: false`, under the base path.
 */

const ANY_PATH = String.raw`(?:\/((?:[^\/]+?)(?:\/(?:[^\/]+?))*))?(?:\/)?$`;
/** The locale group `next build` puts in front of a source (`:nextInternalLocale(en|fr)`). */
const LOCALE = String.raw`(?:\/(en|fr))`;
const PUBLIC_FILE = '/hello.txt';
const CHUNK = '/_next/static/chunks/main-abc123.js';
const IMMUTABLE = 'public,max-age=31536000,immutable';

/** A source path written as path-to-regexp escapes it, as `next build` compiles a literal. */
function escaped(path: string): string {
  return path.replaceAll('/', String.raw`\/`);
}

/** `{ source: '/:path*', headers }`: the locale in front of it, under the base path. */
function everyLocalizedPath(headers: Record<string, string>, basePath = ''): Route {
  return {
    source: `${basePath}/:nextInternalLocale(en|fr)/:path*`,
    sourceRegex: `^${escaped(basePath)}${LOCALE}${ANY_PATH}`,
    headers,
  };
}

/** `{ source, locale: false, headers }`: the path as written, under the base path. */
function unlocalized(source: string, headers: Record<string, string>, basePath = ''): Route {
  const literal = basePath + source.replace(/\/:path\*$/u, '');
  return {
    source: basePath + source,
    sourceRegex: `^${escaped(literal)}${ANY_PATH}`,
    headers,
  };
}

/** What the build's files are given, by their pathnames: `undefined` where nothing is stored. */
function storedOn(
  options: FixtureBundleOptions,
  ...pathnames: readonly string[]
): (Readonly<Record<string, string>> | undefined)[] {
  const headersOf = shippedFileHeadersOf(fixtureBundle(options), new BuildPatternBudget());
  if (headersOf === undefined) {
    throw new Error('the build stores no headers on its files');
  }
  return pathnames.map((pathname) => headersOf(pathname));
}

describe('the headers a shipped file of an i18n build is stored with', () => {
  it('gives a public file the rules that match it behind the default locale', () => {
    const headerRules = [
      everyLocalizedPath({ 'X-Content-Type-Options': 'nosniff' }),
      unlocalized('/en/:path*', { 'Content-Language': 'en' }),
      unlocalized('/fr/:path*', { 'Content-Language': 'fr' }),
      // A locale the rule captured, which Next.js fills from the path it matched.
      everyLocalizedPath({ 'X-Locale': '$1' }),
    ];

    expect(storedOn({ i18n: true, headerRules }, PUBLIC_FILE)).toStrictEqual([
      { 'x-content-type-options': 'nosniff', 'content-language': 'en', 'x-locale': 'en' },
    ]);
  });

  /**
   * Next.js puts no locale in front of a path under `_next/`, so a rule the locale is put in front
   * of never matches one of its files; one written with `locale: false` does — and the year-long
   * lifetime `next build` gives the files it names by hash, a rule of its own that runs on a match.
   */
  it('gives a file under _next the rules that match it as it is', () => {
    const headerRules = [
      everyLocalizedPath({ 'X-Content-Type-Options': 'nosniff' }),
      unlocalized('/_next/static/:path*', { 'Cross-Origin-Resource-Policy': 'same-origin' }),
    ];

    expect(storedOn({ i18n: true, headerRules }, CHUNK)).toStrictEqual([
      { 'cross-origin-resource-policy': 'same-origin', 'cache-control': IMMUTABLE },
    ]);
  });

  it('gives a rule with locale: false every file it matches as written', () => {
    const headerRules = [unlocalized('/:path*', { 'X-Frame-Options': 'DENY' })];

    expect(storedOn({ i18n: true, headerRules }, PUBLIC_FILE, CHUNK)).toStrictEqual([
      { 'x-frame-options': 'DENY' },
      { 'x-frame-options': 'DENY', 'cache-control': IMMUTABLE },
    ]);
  });

  it('matches under the base path, with the locale behind it', () => {
    const basePath = '/docs';
    const headerRules = [
      everyLocalizedPath({ 'X-Content-Type-Options': 'nosniff' }, basePath),
      unlocalized(
        '/_next/static/:path*',
        { 'Cross-Origin-Resource-Policy': 'cross-origin' },
        basePath,
      ),
    ];

    expect(
      storedOn(
        { basePath, i18n: true, headerRules },
        `${basePath}${PUBLIC_FILE}`,
        `${basePath}${CHUNK}`,
      ),
    ).toStrictEqual([
      { 'x-content-type-options': 'nosniff' },
      { 'cross-origin-resource-policy': 'cross-origin', 'cache-control': IMMUTABLE },
    ]);
  });

  /** A rule with `has` or `missing` sets its headers on some requests and not others. */
  it('stores no rule with a condition', () => {
    const headerRules = [
      { ...everyLocalizedPath({ 'X-Beta': '1' }), has: [{ type: 'cookie' as const, key: 'beta' }] },
      {
        ...unlocalized('/:path*', { 'X-Gamma': '1' }),
        missing: [{ type: 'header' as const, key: 'x-gamma' }],
      },
      everyLocalizedPath({ 'X-Content-Type-Options': 'nosniff' }),
    ];

    // Nor the deployment id `next build` puts on a response to the client's router, whose rule
    // holds only for a request with `rsc: 1`.
    expect(storedOn({ i18n: true, headerRules }, PUBLIC_FILE, '/_next/data/a.json')).toStrictEqual([
      { 'x-content-type-options': 'nosniff' },
      { 'x-nextjs-deployment-id': 'dpl_4Fixture2Minima1AppXy' },
    ]);
  });

  /**
   * With `i18n.domains` Next.js puts the default locale of the host a request is asked on in front
   * of the path, which a file named by its path alone cannot tell apart: a header the hosts would
   * be answered with differently — present on one, absent or another value on another — is stored
   * for none of them, rather than a value one of them would not have been given.
   */
  it('stores nothing a domain of its own would be answered with otherwise', () => {
    const headerRules = [
      everyLocalizedPath({ 'X-Content-Type-Options': 'nosniff' }),
      unlocalized('/en/:path*', { 'Content-Language': 'en' }),
      everyLocalizedPath({ 'X-Locale': '$1' }),
      unlocalized('/_next/static/:path*', { 'Cross-Origin-Resource-Policy': 'same-origin' }),
    ];

    expect(
      storedOn({ i18n: true, localeDomains: true, headerRules }, PUBLIC_FILE, CHUNK),
    ).toStrictEqual([
      { 'x-content-type-options': 'nosniff' },
      { 'cross-origin-resource-policy': 'same-origin', 'cache-control': IMMUTABLE },
    ]);
  });

  /**
   * What describes the bytes on the wire is the edge's own account of what it sends from storage,
   * which a rule judged on the request does not replace either (`SHIPPED_FILE_ENTITY_HEADERS`): their
   * length, coding, range and entity. Their type a rule may set, as Next.js's file server lets one —
   * it sets a type only where none is — which is how an extensionless `public/` file is given one.
   */
  it('stores the type a rule sets, and nothing else that describes the bytes', () => {
    const headerRules = [
      unlocalized('/en/.well-known/apple-app-site-association', {
        'Content-Type': 'application/json',
      }),
      everyLocalizedPath({
        'Content-Length': '1',
        'Content-Encoding': 'gzip',
        'Content-Range': 'bytes 0-0/1',
        'Accept-Ranges': 'none',
        ETag: '"other"',
        'X-Content-Type-Options': 'nosniff',
      }),
    ];

    expect(
      storedOn({ i18n: true, headerRules }, '/.well-known/apple-app-site-association', PUBLIC_FILE),
    ).toStrictEqual([
      { 'content-type': 'application/json', 'x-content-type-options': 'nosniff' },
      { 'x-content-type-options': 'nosniff' },
    ]);
  });

  /**
   * Next.js sends the cookie of every rule that matches (`resolve-routes.js`); the edge keeps one
   * value a header, the later rule's, for a rule it judges on the request (`headerRulesFor`) — and
   * what is stored is what it would lay, so the stored path keeps the later as well.
   */
  it("keeps the later rule's cookie, as the rules judged on the request do", () => {
    const cookies = ['first=1; Path=/', 'second=2; Path=/'];
    const { sourceRegex } = unlocalized('/:path*', {});
    const rules = cookies.map((cookie) => ({ sourceRegex, headers: { 'Set-Cookie': cookie } }));
    const judged = headerRulesFor(
      { headerRules: rules },
      new URL(`https://site.example${PUBLIC_FILE}`),
      new Headers(),
    );

    expect(judged.headers['set-cookie']).toBe('second=2; Path=/');
    expect(storedOn({ i18n: true, headerRules: rules }, PUBLIC_FILE)).toStrictEqual([
      { 'set-cookie': 'second=2; Path=/' },
    ]);
  });

  /**
   * A rule `next build` writes itself is matched with the default locale taken out of the path
   * again (`handleRoute`), so one for a public file names it without the locale — and a rule of
   * `next.config` written the same way does not match it, being matched behind the locale.
   */
  it('matches a rule next build writes itself without the default locale', () => {
    const literal = { source: PUBLIC_FILE, sourceRegex: String.raw`^\/hello\.txt(?:\/)?$` };
    const headerRules = [
      { ...literal, headers: { 'X-Internal': 'yes' }, priority: true },
      { ...literal, headers: { 'X-Application': 'yes' } },
    ];

    expect(storedOn({ i18n: true, headerRules }, PUBLIC_FILE)).toStrictEqual([
      { 'x-internal': 'yes' },
    ]);
  });

  it('gives a service worker the scope next build allows it', () => {
    const headerRules = [
      {
        source: '/_next/static/service-worker/:path*',
        sourceRegex: String.raw`^\/_next\/static\/service-worker(?:\/((?:[^\/]+?)(?:\/(?:[^\/]+?))*))?$`,
        headers: { 'Service-Worker-Allowed': '/' },
        priority: true,
      },
    ];

    expect(
      storedOn({ i18n: true, headerRules }, '/_next/static/service-worker/sw.js'),
    ).toStrictEqual([{ 'service-worker-allowed': '/' }]);
  });

  /** A redirect claims the path from the file (`isReserved`): its `Location` is no file's header. */
  it('stores no redirect', () => {
    const redirects = [
      {
        source: PUBLIC_FILE,
        sourceRegex: String.raw`^(?:\/(en|fr))\/hello\.txt(?:\/)?$`,
        headers: { Location: '/elsewhere' },
        status: 308,
      },
    ];

    expect(storedOn({ i18n: true, redirects }, PUBLIC_FILE)).toStrictEqual([undefined]);
  });

  it('stores nothing on a file no rule sets anything on, and one object for equal headers', () => {
    const headerRules = [everyLocalizedPath({ 'X-Content-Type-Options': 'nosniff' })];
    const [unhashed, one, other] = storedOn(
      { i18n: true, headerRules },
      '/_next/static/unhashed.js',
      PUBLIC_FILE,
      '/robots.txt',
    );

    expect(unhashed).toBeUndefined();
    expect(one).toStrictEqual({ 'x-content-type-options': 'nosniff' });
    expect(other).toBe(one);
  });

  /**
   * Next.js takes the asset prefix off before it asks whether the path names a locale, and puts no
   * locale in front of a path that is then under `_next/` (`resolveRoutes`): a file asked for under
   * the prefix is matched as it was asked for, `/assets/_next/static/…`, and not behind the default
   * locale. So a rule the locale is put in front of does not match it, and one for the prefixed path
   * with `locale: false` does.
   */
  it('matches a path under the asset prefix as it is asked for', () => {
    const headerRules = [
      everyLocalizedPath({ 'X-Localized': 'yes' }),
      unlocalized('/assets/_next/static/:path*', { 'X-Prefixed': 'yes' }),
    ];
    const bundle = fixtureBundle({ i18n: true, headerRules });
    const headersOf = shippedFileHeadersOf(
      { ...bundle, config: { ...bundle.config, assetPrefix: '/assets' } },
      new BuildPatternBudget(),
    );

    expect(headersOf?.(`/assets${CHUNK}`)).toStrictEqual({
      'x-prefixed': 'yes',
      'cache-control': IMMUTABLE,
    });
  });

  /** A build whose rules the edge judges on each request has every file's judged there. */
  it('is nothing for a build without i18n', () => {
    const headerRules = [unlocalized('/:path*', { 'X-Frame-Options': 'DENY' })];

    expect(
      shippedFileHeadersOf(fixtureBundle({ headerRules }), new BuildPatternBudget()),
    ).toBeUndefined();
    expect(
      shippedFileHeadersOf(
        fixtureBundle({ basePath: '/docs', headerRules }),
        new BuildPatternBudget(),
      ),
    ).toBeUndefined();
  });
});
