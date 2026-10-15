import { describe, expect, it } from 'vitest';

import { staticFileKey } from '../src/manifest/manifest.ts';
import { pageKeyOf } from '../src/manifest/page-keys.ts';
import { spellsPrefixOf } from '../src/manifest/spelled-prefix.ts';

/**
 * Next.js's router reads the base path and the locale behind it as a path writes them, before it
 * decodes anything: a page or a file a reading that decodes the path finds is the request's only
 * where the path writes them as written.
 */

/** A route record of `keys`, with what the router reads as written in front of them. */
function manifestOf(
  keys: readonly string[],
  spelledPrefix?: { basePath: string; locales?: string[] },
) {
  return {
    routes: Object.fromEntries(keys.map((key) => [key, true])),
    ...(spelledPrefix !== undefined && { spelledPrefix }),
  };
}

const FILE = { sha256: 'a'.repeat(64), byteLength: 1, contentType: 'text/html', immutable: false };

/** A manifest shipping files named `names`, with what the router reads as written. */
function shipping(
  names: readonly string[],
  spelledPrefix?: { basePath: string; locales?: string[] },
) {
  return {
    staticFiles: Object.fromEntries(names.map((name) => [name, FILE])),
    ...(spelledPrefix !== undefined && { spelledPrefix }),
  };
}

const LOCALES = { basePath: '', locales: ['en', 'fr'] };
const BASE = { basePath: '/base' };

describe('a page found by decoding a path', () => {
  it('is no page of a locale the path escapes', () => {
    const manifest = manifestOf(['/en/about', '/fr/about'], LOCALES);
    const found = (path: string): string | undefined => pageKeyOf(manifest.routes, path, manifest);

    expect(found('/%65n/about')).toBeUndefined();
    expect(found('/en%2Fabout')).toBeUndefined();
    expect(found('/%66r/about')).toBeUndefined();
  });

  it('is no page under a base path the path escapes', () => {
    const manifest = manifestOf(['/base/about'], BASE);

    expect(pageKeyOf(manifest.routes, '/b%61se/about', manifest)).toBeUndefined();
  });

  /** Behind the prefix, the reading decodes as it did. */
  it('is the page where the path writes the prefix as written', () => {
    const localized = manifestOf(['/en/a b'], LOCALES);
    const based = manifestOf(['/base/a b'], BASE);

    expect(pageKeyOf(localized.routes, '/en/a%20b', localized)).toBe('/en/a b');
    expect(pageKeyOf(based.routes, '/base/a%20b', based)).toBe('/base/a b');
  });

  /** A manifest from before the prefix was written down is read as it was: decoded whole. */
  it('is the page decoded whole where the manifest says nothing of a prefix', () => {
    const manifest = manifestOf(['/en/about']);

    expect(pageKeyOf(manifest.routes, '/%65n/about', manifest)).toBe('/en/about');
  });
});

describe('a file found by decoding a path', () => {
  it('is no file behind a locale or under a base path the path escapes', () => {
    const localized = shipping(['/en/about'], LOCALES);
    const based = shipping(['/base/x.png'], BASE);

    expect(staticFileKey(localized, '/%65n/about')).toBeUndefined();
    expect(staticFileKey(based, '/b%61se/x.png')).toBeUndefined();
  });

  it('is the file where the path writes the prefix as written', () => {
    const based = shipping(['/base/x.png'], BASE);

    expect(staticFileKey(based, '/base/x%2Epng')).toBe('/base/x.png');
  });

  /**
   * A path made here out of the one the request spelled — the asset prefix put back as the base
   * path, as Next.js's rewrite of it does — writes the base path as the configuration does, past
   * ASCII included: the prefix was asked of the request's own path.
   */
  it('is the file under the asset prefix, a base path past ASCII and an escaped name', () => {
    const chunk = '/文書/_next/static/chunks/[slug]-a1.js';
    const manifest = {
      ...shipping([chunk], { basePath: '/文書' }),
      staticFileAssetPrefix: { basePath: '/文書', assetPrefix: '/assets' },
    };

    expect(staticFileKey(manifest, '/assets/_next/static/chunks/%5Bslug%5D-a1.js')).toBe(chunk);
  });
});

describe('the prefix a path writes', () => {
  /** A base path past ASCII is written as a request's URL escapes it, which is how one asks. */
  it('reads a base path as a URL writes it', () => {
    const basePath = '/文書';
    const spelled = new URL(basePath, 'https://x.invalid').pathname;

    expect(spellsPrefixOf({ basePath }, `${spelled}/a%20b`, '/文書/a b')).toBe(true);
    expect(spellsPrefixOf({ basePath }, '/%E6%96%87/a%20b', '/文書/a b')).toBe(false);
  });

  /** The router compares a locale with the path as written, case aside. */
  it('reads a locale as written, case aside', () => {
    expect(spellsPrefixOf(LOCALES, '/EN/a%20b', '/en/a b')).toBe(true);
    expect(spellsPrefixOf(LOCALES, '/%45N/a%20b', '/en/a b')).toBe(false);
  });

  /** A name that begins with no locale is the reading's to find, its first segment and all. */
  it('leaves a name with no locale in front of it to the reading', () => {
    expect(spellsPrefixOf(LOCALES, '/%61bout', '/about')).toBe(true);
    expect(spellsPrefixOf(undefined, '/%65n/about', '/en/about')).toBe(true);
  });
});
