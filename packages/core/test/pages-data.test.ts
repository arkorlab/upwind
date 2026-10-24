import { describe, expect, it } from 'vitest';

import {
  isPagesDataPathname,
  isPagesDataRequestPath,
  pageOfDataPathname,
  pageOfPagesData,
  pagesDataPathnameUnder,
} from '../src/bundle/pages-data.ts';
import { namesPagesDataPrefix, pagesDataPrefixOf } from '../src/manifest/pages-data-prefix.ts';

/**
 * Deciding that a request is a Pages Router data request, as Next.js's router decides it before a
 * middleware runs: the middleware is told by `x-nextjs-data`, and a client cannot send that header,
 * so the path is all there is to go on.
 */
describe('a data request, read off its path', () => {
  it('is a path under `/_next/data/` that ends in `.json`', () => {
    expect(isPagesDataRequestPath('', '/_next/data/build/en/old-home.json')).toBe(true);
    expect(isPagesDataRequestPath('', '/_next/data/build/index.json')).toBe(true);
  });

  it("is one whichever build it names: settling that is routing's business, not this", () => {
    expect(isPagesDataRequestPath('', '/_next/data/an-older-build/page.json')).toBe(true);
  });

  it('is read beneath the base path, and without one when the path does not carry it', () => {
    expect(isPagesDataRequestPath('/docs', '/docs/_next/data/build/page.json')).toBe(true);
    expect(isPagesDataRequestPath('/docs', '/_next/data/build/page.json')).toBe(true);
  });

  it('is not a page, a data path without `.json`, or a path that only starts the same way', () => {
    expect(isPagesDataRequestPath('', '/old-home')).toBe(false);
    expect(isPagesDataRequestPath('', '/_next/data/build/page')).toBe(false);
    expect(isPagesDataRequestPath('', '/_next/database/page.json')).toBe(false);
    expect(isPagesDataRequestPath('', '/blog/_next/data/build/page.json')).toBe(false);
    expect(isPagesDataRequestPath('/docs', '/docsite/_next/data/build/page.json')).toBe(false);
  });
});

const BUILD = 'build-1';

/**
 * The props of a page, named as `next build` names the file it writes them to and as the client
 * asks for them (`getDataHref`): under the base path, the page as `normalizePagePath` spells it.
 */
/**
 * A data route as the bundle names it, under the base path where Next.js writes every one
 * (`/docs/_next/data/…`): the runtime offers it to its router by name and answers it with props.
 * Read without the base path, an application under one had every data request answered 404
 * (`gssp-redirect-base-path`).
 */
describe('a data route of the bundle', () => {
  it('is under the base path, or at the root without one', () => {
    expect(isPagesDataPathname('/docs', '/docs/_next/data/b/gsp-blog/first.json')).toBe(true);
    expect(isPagesDataPathname('', '/_next/data/b/gsp-blog/first.json')).toBe(true);
  });

  it('is not one outside the base path, nor a page, nor a path that only starts the same way', () => {
    expect(isPagesDataPathname('/docs', '/_next/data/b/gsp-blog/first.json')).toBe(false);
    expect(isPagesDataPathname('/docs', '/docs/gsp-blog/first')).toBe(false);
    expect(isPagesDataPathname('/docs', '/docsite/_next/data/b/first.json')).toBe(false);
  });
});

describe('the page a data route of this build names', () => {
  it('is named under the base path, as the build names its pages', () => {
    expect(pageOfDataPathname('b', '/docs', '/docs/_next/data/b/gsp-blog/first.json')).toBe(
      '/docs/gsp-blog/first',
    );
    expect(pageOfDataPathname('b', '/docs', '/docs/_next/data/b/index.json')).toBe('/docs');
    expect(pageOfDataPathname('b', '', '/_next/data/b/index.json')).toBe('/');
  });

  it('is the page whose props the data pathname names, read back', () => {
    for (const page of ['/docs', '/docs/gsp-blog/first', '/docs/index', '/docs/index/more']) {
      const data = pagesDataPathnameUnder('b', '/docs', page);

      expect(pageOfDataPathname('b', '/docs', data)).toBe(page);
    }
  });

  it('is none of another build, outside the base path, or of a page', () => {
    expect(pageOfDataPathname('b', '/docs', '/docs/_next/data/other/first.json')).toBeUndefined();
    expect(pageOfDataPathname('b', '/docs', '/_next/data/b/first.json')).toBeUndefined();
    expect(pageOfDataPathname('b', '/docs', '/docs/gsp-blog/first')).toBeUndefined();
  });
});

describe('the data pathname of a page', () => {
  it.each([
    ['', '/about', '/_next/data/build-1/about.json'],
    ['', '/', '/_next/data/build-1/index.json'],
    ['', '/index', '/_next/data/build-1/index/index.json'],
    ['', '/index/about', '/_next/data/build-1/index/index/about.json'],
    ['', '/blog/post', '/_next/data/build-1/blog/post.json'],
    ['/docs', '/docs/about', '/docs/_next/data/build-1/about.json'],
    ['/docs', '/docs', '/docs/_next/data/build-1/index.json'],
  ])('under %j, of %s, is %s', (basePath, page, data) => {
    expect(pagesDataPathnameUnder(BUILD, basePath, page)).toBe(data);
  });

  it('is asked for under the prefix the manifest carries', () => {
    expect(pagesDataPrefixOf(BUILD, '')).toBe('/_next/data/build-1');
    expect(pagesDataPrefixOf(BUILD, '/docs')).toBe('/docs/_next/data/build-1');
  });

  /**
   * A request's URL percent-encodes what a path cannot hold, and the prefix is what a request's
   * pathname is compared with; the build's own names stay as the build wrote them.
   */
  it('is asked for under a prefix spelled as a request spells it', () => {
    expect(pagesDataPrefixOf(BUILD, '/日本')).toBe('/%E6%97%A5%E6%9C%AC/_next/data/build-1');
    expect(pagesDataPrefixOf(BUILD, '/my docs')).toBe('/my%20docs/_next/data/build-1');
    expect(pagesDataPathnameUnder(BUILD, '/日本', '/日本/about')).toBe(
      '/日本/_next/data/build-1/about.json',
    );
  });
});

describe('the page a data request asks the props of', () => {
  /** Each page back from the name the build gives its props, as the manifest names the page. */
  it.each([
    ['', '/about'],
    ['', '/'],
    ['', '/index'],
    ['', '/index/about'],
    ['', '/blog/post'],
    ['/docs', '/docs/about'],
    ['/docs', '/docs'],
  ])('under %j, is %s again', (basePath, page) => {
    const asked = pagesDataPathnameUnder(BUILD, basePath, page);

    expect(pageOfPagesData(pagesDataPrefixOf(BUILD, basePath), basePath, asked, false)).toBe(page);
  });

  /**
   * Behind the slash, where the application keeps its pages there: the manifest names a page by
   * the spelling its document is asked by, and the client asks for its props without it.
   */
  it('is named behind the slash where the application keeps its pages there', () => {
    const prefix = pagesDataPrefixOf(BUILD, '');
    const underDocs = pagesDataPrefixOf(BUILD, '/docs.v1');

    expect(pageOfPagesData(prefix, '', '/_next/data/build-1/about.json', true)).toBe('/about/');
    expect(pageOfPagesData(prefix, '', '/_next/data/build-1/index.json', true)).toBe('/');
    // A last segment that names a file keeps none, as its document's spelling keeps none.
    expect(pageOfPagesData(prefix, '', '/_next/data/build-1/feed.xml.json', true)).toBe(
      '/feed.xml',
    );
    // The root of a base path gains it by name, whatever its last segment reads like.
    expect(
      pageOfPagesData(underDocs, '/docs.v1', '/docs.v1/_next/data/build-1/index.json', true),
    ).toBe('/docs.v1/');
  });

  /** Read decoded, as a manifest names its routes. */
  it('is found under a base path a request percent-encodes', () => {
    const prefix = pagesDataPrefixOf(BUILD, '/日本');
    const asked = new URL('https://site.example.app/日本/_next/data/build-1/café.json').pathname;

    expect(pageOfPagesData(prefix, '/日本', asked, false)).toBe('/日本/café');
  });

  /**
   * Only a spelling a client writes: an escape neither the URL's parser nor `encodeURIComponent`
   * writes, a broken one, or one in lower case decodes into a name the build wrote — and Next.js
   * finds no props by it.
   */
  it('is no page for a spelling a URL would not give the name', () => {
    const prefix = pagesDataPrefixOf(BUILD, '');

    expect(pageOfPagesData(prefix, '', '/_next/data/build-1/%66oo.json', false)).toBeUndefined();
    expect(
      pageOfPagesData(prefix, '', '/_next/data/build-1/%69ndex/foo.json', false),
    ).toBeUndefined();
    expect(pageOfPagesData(prefix, '', '/_next/data/build-1/%E0%A4%A.json', false)).toBeUndefined();
    expect(
      pageOfPagesData(prefix, '', '/_next/data/build-1/caf%c3%a9.json', false),
    ).toBeUndefined();
  });

  /**
   * An escaped slash is a parameter's value, which Next.js keeps in one segment of the page's name:
   * neither the page `/foo` nor `/index/foo`, whose props are named otherwise.
   */
  it('keeps an escaped slash inside its segment', () => {
    const prefix = pagesDataPrefixOf(BUILD, '');
    const asked = '/_next/data/build-1/index%2Ffoo.json';

    expect(pageOfPagesData(prefix, '', asked, false)).toBe('/index%2Ffoo');
  });

  /**
   * `normalizePagePath` leaves a page that begins with `/index` un-nested where a segment of it
   * reads as a parameter, as a concrete member's value may (`isDynamicRoute`).
   */
  it('reads a page that looks dynamic under `/index` as the build names it', () => {
    const named = pagesDataPathnameUnder(BUILD, '', '/index/[literal]');

    expect(named).toBe('/_next/data/build-1/index/[literal].json');
    expect(pageOfPagesData(pagesDataPrefixOf(BUILD, ''), '', named, false)).toBe(
      '/index/[literal]',
    );
  });

  /**
   * A URL resolves a dot segment, turns a backslash into a slash, and decodes nothing: a request
   * names a path under such a base path by another name than the build gave it.
   */
  it('is asked for only under a base path and a build id a request spells as written', () => {
    const spelled = ['', '/docs', '/日本', '/my docs'];
    const respelled = ['/a/../b', '/a/./b', String.raw`/a\b`, '/a%41'];

    expect(spelled.map((basePath) => namesPagesDataPrefix(basePath, BUILD))).toStrictEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(respelled.map((basePath) => namesPagesDataPrefix(basePath, BUILD))).toStrictEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(namesPagesDataPrefix('', 'release/123')).toBe(true);
    expect(namesPagesDataPrefix('', 'a/../b')).toBe(false);
    expect(namesPagesDataPrefix('', String.raw`a\b`)).toBe(false);
  });

  /**
   * Next.js's client percent-encodes a `?` or a `#` in a parameter into the URL's path
   * (`interpolateAs`), where it is part of the page's name, not the end of the path.
   */
  it('is found for a page whose name holds a `?` or a `#`, named as Next.js builds it', () => {
    const prefix = pagesDataPrefixOf(BUILD, '');

    expect(pageOfPagesData(prefix, '', '/_next/data/build-1/a%3Fb.json', false)).toBe('/a%3Fb');
    expect(pageOfPagesData(prefix, '', '/_next/data/build-1/a%23b.json', false)).toBe('/a%23b');
  });

  /**
   * The client encodes a parameter's value whole (`encodeURIComponent`): a bracket in it reaches the
   * edge escaped, and names the page the build named with the bracket.
   */
  it('is found for a parameter the client encodes whole', () => {
    const prefix = pagesDataPrefixOf(BUILD, '');
    const asked = '/_next/data/build-1/index/%5Bliteral%5D.json';

    expect(pageOfPagesData(prefix, '', asked, false)).toBe('/index/[literal]');
    expect(pageOfPagesData(prefix, '', '/_next/data/build-1/a%3Ab.json', false)).toBe('/a:b');
  });

  /**
   * A base path may hold `/_next/data/` itself, so the page is named under the base path the
   * manifest names beside the prefix rather than one read back out of it.
   */
  it('is found under a base path that holds `/_next/data/`', () => {
    const basePath = '/shop/_next/data/archive';
    const prefix = pagesDataPrefixOf(BUILD, basePath);

    expect(prefix).toBe('/shop/_next/data/archive/_next/data/build-1');
    expect(pageOfPagesData(prefix, basePath, `${prefix}/about.json`, false)).toBe(
      '/shop/_next/data/archive/about',
    );
  });

  /**
   * As Next.js 16.3.8's own `normalizePagePath` names each — read off it, not reasoned out: a
   * parameter whole, optional catch-all included, keeps a page un-nested; a bracket inside a segment
   * does not.
   */
  it.each([
    ['/index/[[...slug]]', '/index/[[...slug]]'],
    ['/index/[...slug]', '/index/[...slug]'],
    ['/index/[slug]', '/index/[slug]'],
    ['/index/a[b]', '/index/index/a[b]'],
    ['/index/about', '/index/index/about'],
  ])('names %s as Next.js does, %s', (page, named) => {
    expect(pagesDataPathnameUnder(BUILD, '', page)).toBe(`/_next/data/build-1${named}.json`);
  });

  /** `generateBuildId` may return more than one segment, which Next.js joins in as it is. */
  it('is found under a build id of more than one segment', () => {
    const prefix = pagesDataPrefixOf('release/123', '/docs');

    expect(prefix).toBe('/docs/_next/data/release/123');
    expect(pageOfPagesData(prefix, '/docs', `${prefix}/about.json`, false)).toBe('/docs/about');
  });

  /** Next.js writes a page's props under its own name, which ends in no slash. */
  it('is no page for a slash before `.json`', () => {
    const prefix = pagesDataPrefixOf(BUILD, '');

    expect(pageOfPagesData(prefix, '', '/_next/data/build-1/about/.json', true)).toBeUndefined();
    expect(pageOfPagesData(prefix, '', '/_next/data/build-1/about/.json', false)).toBeUndefined();
  });

  /** Spellings the build never writes, and other builds' props, name no page: the Function's. */
  it('is no page for a pathname the build names no props by', () => {
    const prefix = pagesDataPrefixOf(BUILD, '');

    expect(pageOfPagesData(prefix, '', '/_next/data/build-0/about.json', false)).toBeUndefined();
    expect(pageOfPagesData(prefix, '', '/_next/data/build-1/about', false)).toBeUndefined();
    expect(pageOfPagesData(prefix, '', '/_next/data/build-1.json', false)).toBeUndefined();
    expect(pageOfPagesData(prefix, '', '/_next/data/build-10/about.json', false)).toBeUndefined();
    // The root's props are `/index`, and a page under `/index` is nested under a second one.
    expect(pageOfPagesData(prefix, '', '/_next/data/build-1/.json', false)).toBeUndefined();
    expect(
      pageOfPagesData(prefix, '', '/_next/data/build-1/index/about.json', false),
    ).toBeUndefined();
    expect(pageOfPagesData(prefix, '', '/_next/data/build-1/index/index.json', false)).toBe(
      '/index',
    );
  });
});
