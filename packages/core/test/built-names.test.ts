import { describe, expect, it } from 'vitest';

import {
  builtNameOf,
  builtSegment,
  escapedPathOf,
  memberValuesOf,
  readablePathOf,
  requestPathOf,
  spellingsOf,
} from '../src/manifest/built-names.ts';
import { fileRequestPathOf, staticFileKey } from '../src/manifest/manifest.ts';

/**
 * The path a request asks for a page by (`requestPathOf`), and for a file by (`escapedPathOf`): each
 * written into a URL and read back as the edge reads a request's path is the name it was made from
 * — a page's as Next.js names what it builds (`builtNameOf`), a file's decoded whole.
 */

/** Names of pages as Next.js builds them: a parameter's `/`, `#`, `?` and `\` escaped back. */
const NAMES = [
  '/closed/docs/space here/100%',
  '/closed/docs/space here/with%2Fslash/100%',
  '/sticks & stones',
  '/a%252Fb',
  '/a%41',
  '/a;b=c',
  '/q%3Fx%23y%5Cz',
  '/記事',
  '/docs/50% off/',
  '/a\nb\tc',
  '/trailing ',
  '/\u{1}led',
  '/docs/...',
  '/',
];

/** The path a URL holds once `path`, a path a request asks by, is written into it. */
function asked(path: string | undefined): string {
  if (path === undefined) {
    throw new Error('no path a request asks by');
  }
  return new URL(path, 'https://app.test').pathname;
}

describe('the path a request asks for a built page by', () => {
  it('escapes a percent sign that starts no escape, and keeps a parameter’s escaped slash', () => {
    expect(asked(requestPathOf('/closed/docs/space here/100%'))).toBe(
      '/closed/docs/space%20here/100%25',
    );
    expect(asked(requestPathOf('/closed/docs/space here/with%2Fslash/100%'))).toBe(
      '/closed/docs/space%20here/with%2Fslash/100%25',
    );
    expect(requestPathOf('/q%3Fx%23y%5Cz')).toBe('/q%3Fx%23y%5Cz');
  });

  /** Asked as a browser asks by a link to it: what a path may hold, it holds as it is. */
  it('leaves what a path may hold as it is', () => {
    expect(asked(requestPathOf('/sticks & stones'))).toBe('/sticks%20&%20stones');
    expect(requestPathOf('/a;b=c')).toBe('/a;b=c');
  });

  /** An escape that stood in a parameter's value as it is: its `%` is the value's, and escaped. */
  it('asks for an escape that stood in the value as it is by that escape escaped', () => {
    expect(requestPathOf('/a%252Fb')).toBe('/a%252Fb');
    expect(requestPathOf('/a%41')).toBe('/a%2541');
    expect(requestPathOf('/a%25')).toBe('/a%2525');
  });

  /** A URL drops a tab or a line break wherever it stands, and a space at either end of it. */
  it('escapes what a URL drops', () => {
    expect(asked(requestPathOf('/a\nb\tc'))).toBe('/a%0Ab%09c');
    expect(asked(requestPathOf('/trailing '))).toBe('/trailing%20');
  });

  it('escapes what would end the path or turn into a slash, where a name holds it as it is', () => {
    expect(requestPathOf(String.raw`/a?b#c\d`)).toBe('/a%3Fb%23c%5Cd');
  });

  it('reads back as the name it was made from', () => {
    for (const name of NAMES) {
      const path = asked(requestPathOf(name));

      expect(builtNameOf(path)).toBe(name);
    }
  });

  /**
   * A URL resolves a dot segment away, and reads a path whose first segment is empty, written
   * relative to the site, as another host's: a page so named is one no request reaches.
   */
  it('names no path for a page no request reaches', () => {
    expect(requestPathOf('/docs/..')).toBeUndefined();
    expect(requestPathOf('/docs/./a')).toBeUndefined();
    expect(requestPathOf('//other.example')).toBeUndefined();
    expect(requestPathOf('docs')).toBeUndefined();
    expect(requestPathOf('/docs/\u{D800}')).toBeUndefined();
  });

  /** A name written into a URL as it is asks for another page, or for none. */
  it('is not the name written into a URL as it is', () => {
    const raw = asked('/closed/docs/space here/100%');

    expect(raw).toBe('/closed/docs/space%20here/100%');
    expect(builtNameOf(raw)).toBeUndefined();
  });
});

describe('the path a request asks for a file by', () => {
  it('escapes what a URL reads as its own, and reads back decoded whole as the path', () => {
    const paths = [
      '/50% off.png',
      '/a%2Fb.txt',
      '/space here/100%.html',
      '/記事.html',
      '/q?#.txt',
      String.raw`/a\b.txt`,
      '/a;b&c.txt',
      '/a\nb\t.txt',
      '/trailing ',
    ];

    expect(asked(escapedPathOf('/50% off.png'))).toBe('/50%25%20off.png');

    for (const path of paths) {
      const escaped = asked(escapedPathOf(path));

      expect(decodeURIComponent(escaped)).toBe(path);
    }
  });

  it('names no path for a file no request reaches', () => {
    expect(escapedPathOf('/a/../b.txt')).toBeUndefined();
    expect(escapedPathOf('//other.example/x.txt')).toBeUndefined();
    expect(escapedPathOf('/a\u{DC00}.txt')).toBeUndefined();
  });
});

describe('the path a request asks for a shipped file by', () => {
  const FILE = {
    sha256: 'a'.repeat(64),
    byteLength: 1,
    contentType: 'text/plain',
    immutable: false,
  };

  /** Files named `names`, as a manifest ships them. */
  function shipping(names: readonly string[]) {
    return { staticFiles: Object.fromEntries(names.map((name) => [name, FILE])) };
  }

  /**
   * The edge finds a file as spelled before it decodes one: where another file is named as a
   * request would spell this one, it is asked by a spelling no file is named as.
   */
  it('asks for a file another is named as the spelling of, by a spelling none is named as', () => {
    const shipped = [
      ['/a%2F.txt', '/a%252F.txt'],
      ['/a b', '/a%20b'],
      ['/?', '/%3F'],
      ['/a b/x', '/a%20b/x', '/a%20b/%78'],
      ['/Dir/?', '/Dir/%3F'],
    ];

    for (const names of shipped) {
      const manifest = shipping(names);

      for (const name of names) {
        const path = asked(fileRequestPathOf(manifest, name));

        expect(staticFileKey(manifest, path)).toBe(name);
      }
    }

    const spaced = shipping(['/a b', '/a%20b']);

    expect(asked(fileRequestPathOf(spaced, '/a%20b'))).toBe('/a%2520b');
  });

  /** An escape's letters are a URL's to keep as written, and a directory's are the name's own. */
  it('writes an escape in small letters, and leaves the rest of the name as it is', () => {
    const manifest = shipping(['/Dir/?', '/Dir/%3F']);

    expect(asked(fileRequestPathOf(manifest, '/Dir/?'))).toBe('/Dir/%3f');
  });

  /** A locale ahead of the name is read as it is, and so the last to be written otherwise. */
  it('asks for a file behind a default locale with the locale as it is', () => {
    const manifest = {
      ...shipping(['/a b.txt', '/en/a%20b.txt']),
      staticFileLocales: { basePath: '', locales: ['en'] },
    };
    const path = asked(fileRequestPathOf(manifest, '/en/a b.txt', '/a b.txt'));

    expect(path).toBe('/en/a%20b.tx%74');
    expect(staticFileKey(manifest, path)).toBe('/a b.txt');
  });

  /** Each spelling of a name another is named as reaches that other, and there is none left. */
  it('names no path for a file every spelling of which another is named as', () => {
    expect(fileRequestPathOf(shipping(['/?', '/%3F', '/%3f']), '/?')).toBeUndefined();
  });

  it('names no path for a file no request reaches', () => {
    expect(fileRequestPathOf(shipping(['//x.txt']), '//x.txt')).toBeUndefined();
  });
});

describe('the spellings of a path', () => {
  /** Each byte as it is or escaped, an escape's letters either way, the path's last byte first. */
  it('writes one byte after another otherwise, the last first, and ends', () => {
    expect([...spellingsOf(['', 'a?'])]).toStrictEqual(['/a%3F', '/a%3f', '/%61%3F', '/%61%3f']);
    expect([...spellingsOf(['', 'é'])]).toStrictEqual(['/%C3%A9', '/%C3%a9', '/%c3%A9', '/%c3%a9']);
  });

  it('reads back decoded as the path', () => {
    for (const spelling of spellingsOf(['', 'a b', '%'])) {
      expect(decodeURIComponent(spelling)).toBe('/a b/%');
    }
  });
});

describe('the values a page’s name was built from', () => {
  const NAME = ['', 'a%2Fb%252F%2523'];

  /** An escaped escape was built from the escape, or from itself: each on its own. */
  it('reads a delimiter back, and each escaped escape both ways, each read back first', () => {
    expect([...memberValuesOf(NAME)]).toStrictEqual([
      ['', 'a/b%2F%23'],
      ['', 'a/b%2F%2523'],
      ['', 'a/b%252F%23'],
      ['', 'a/b%252F%2523'],
    ]);
  });

  it('builds each back to the name', () => {
    for (const values of memberValuesOf(NAME)) {
      expect(values.map((value) => builtSegment(value))).toStrictEqual(NAME);
    }
  });

  it('asks for values by a path that holds each segment whole', () => {
    expect(readablePathOf(['', 'docs', 'a/b%252F'])).toBe('/docs/a%2Fb%25252F');
  });
});
