import { describe, expect, it } from 'vitest';

import { builtNameOf, escapedPathOf, requestPathOf } from '../src/manifest/built-names.ts';

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
  '/',
];

/** The path a URL holds once `path` is written into it. */
function asked(path: string): string {
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

  it('escapes what would end the path or turn into a slash, where a name holds it as it is', () => {
    expect(requestPathOf(String.raw`/a?b#c\d`)).toBe('/a%3Fb%23c%5Cd');
  });

  it('reads back as the name it was made from', () => {
    for (const name of NAMES) {
      const path = asked(requestPathOf(name));

      expect(builtNameOf(path)).toBe(name);
    }
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
    ];

    expect(asked(escapedPathOf('/50% off.png'))).toBe('/50%25%20off.png');

    for (const path of paths) {
      const escaped = asked(escapedPathOf(path));

      expect(decodeURIComponent(escaped)).toBe(path);
    }
  });
});
