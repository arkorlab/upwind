import { describe, expect, it } from 'vitest';

import { cookieChangesOf, cookieFor, jarOf, storedAfter } from '../src/cookie-jar.ts';
import { carriedScopesOf, scopesOf } from '../src/cookie-scopes.ts';

const page = new URL('https://www.site.example/account');

/** Each way `sent` may be kept in, where the check follows them all. */
function waysOf(sent: string): ReturnType<typeof scopesOf>['ways'] {
  return scopesOf(page, sent).ways;
}

describe("where a browser may keep a navigation's cookies", () => {
  it('keeps them one way where it sent none', () => {
    expect(scopesOf(page)).toStrictEqual({ ways: [{ scopes: new Map(), as: '' }] });
  });

  it("keeps each name's apart from the others', as a browser may", () => {
    const sent = 'b=narrow; a=root';
    const props = new URL('/_next/data/b/account.json', page);
    const scopes = waysOf(sent);
    const asked = scopes.map(({ scopes: kept }) =>
      cookieFor(jarOf(sent, { document: page, scopes: kept }), props),
    );

    // Under the site's root path or the page's own, for the host alone, or every host of the host
    // itself or of the site's domain, partitioned or not: twelve scopes each.
    expect(scopes).toHaveLength(144);
    expect(scopes[0]?.as).toBe('');
    expect(asked).toContain('a=root');
    expect(scopes.map(({ as }) => as)).toContain(
      ", its navigation's cookie b kept to its page's path",
    );
  });

  it('keeps every way of as many as it follows, two names kept one way and one another among them', () => {
    // Under the site's root path or the page's own, partitioned or not: four scopes each.
    const scopes = scopesOf(new URL('https://localhost/account'), 'a=1; b=2; c=3').ways;

    expect(scopes).toHaveLength(4 ** 3);
    expect(scopes.map(({ as }) => as)).toContain(
      ", its navigation's cookie a kept to its page's path, cookie b kept to its page's path",
    );
  });

  it('keeps a name sent twice as two cookies of their own, the same path by two domains among them', () => {
    const sent = 'sid=a; sid=b';
    const props = new URL('/_next/data/b/account.json', page);
    const scopes = waysOf(sent);
    const asked = scopes.map(({ scopes: kept }) =>
      cookieFor(jarOf(sent, { document: page, scopes: kept }), props),
    );

    // Never both as one cookie, but in any order, which a browser only should keep by their paths:
    // each of the twelve scopes for the first, and each of the other eleven for the second.
    expect(scopes).toHaveLength(132);
    expect(asked).toContain('sid=a; sid=b');

    // The first under the root, the second under the page's path: sent the other way round there.
    const again = scopes.map(({ scopes: kept }) =>
      cookieFor(jarOf(sent, { document: page, scopes: kept }), page),
    );

    expect(again).toContain('sid=b; sid=a');
  });

  it('keeps them for every host of each domain above its own, up to the registrable one', () => {
    const nested = new URL('https://www.us.example.com/account');
    const { ways } = scopesOf(nested, 'sid=1');
    // The document deletes the one kept for every host of the domain between.
    const deletion = cookieChangesOf({
      'set-cookie': ['sid=; Domain=us.example.com; Path=/; Max-Age=0'],
    });
    const sent = ways.map(({ scopes }) => {
      const jar = jarOf('sid=1', { document: nested, scopes });
      return cookieFor(storedAfter(jar, deletion, nested), nested);
    });

    // Under the root path or the page's own, for the host alone, or every host of it or of either
    // domain above it, partitioned or not.
    expect(ways).toHaveLength(16);
    expect(ways.map(({ as }) => as)).toContain(
      ", its navigation's cookies kept for every host of us.example.com",
    );
    // Deleted as a browser that kept it so deletes it, and kept as one that kept it otherwise.
    expect(sent).toContain(undefined);
    expect(sent).toContain('sid=1');
  });

  it('keeps them for every host of the host itself, apart from its own alone', () => {
    const { ways } = scopesOf(page, 'sid=1');
    // The document deletes the one kept for every host of its host.
    const deletion = cookieChangesOf({
      'set-cookie': ['sid=; Domain=www.site.example; Path=/; Max-Age=0'],
    });
    const sent = ways.map(({ scopes }) => {
      const jar = jarOf('sid=1', { document: page, scopes });
      return cookieFor(storedAfter(jar, deletion, page), page);
    });

    expect(ways.map(({ as }) => as)).toContain(
      ", its navigation's cookies kept for every host of www.site.example",
    );
    expect(sent).toContain(undefined);
  });

  it('keeps them under each path above the page with a slash after it, too', () => {
    const item = new URL('https://www.site.example/shop/item');
    const { ways } = scopesOf(item, 'sid=1');
    // The document deletes the one kept under the shop's path with a slash after it.
    const deletion = cookieChangesOf({ 'set-cookie': ['sid=; Path=/shop/; Max-Age=0'] });
    const sent = ways.map(({ scopes }) => {
      const jar = jarOf('sid=1', { document: item, scopes });
      return cookieFor(storedAfter(jar, deletion, item), item);
    });

    expect(ways.map(({ as }) => as)).toContain(", its navigation's cookies kept to /shop/");
    expect(sent).toContain(undefined);
  });

  it('keeps the cookies a request carries in each scope that sends them there', () => {
    const props = new URL('https://www.site.example/_next/data/b/account.json');
    const { ways } = carriedScopesOf(props, 'sid=1');

    // Under each path above the props' own, theirs among them — each but the root and theirs with a
    // slash after it too — for the host alone, or every host of it or of the site's domain,
    // partitioned or not.
    expect(ways).toHaveLength(48);
    expect(ways.map(({ as }) => as)).toContain(', the carried cookies kept to /_next/data');
    expect(ways.map(({ as }) => as)).toContain(', the carried cookies kept to /_next/data/');
    expect(
      ways.map(({ scopes }) => cookieFor(jarOf('sid=1', { document: props, scopes }), props)),
    ).toStrictEqual(ways.map(() => 'sid=1'));
  });

  it('keeps a name sent twice under one path as one partitioned and one not, where a browser may', () => {
    // This machine's front page: its root path alone, for it alone, partitioned or not.
    const front = new URL('http://127.0.0.1/');
    const sent = 'sid=a; sid=b';
    const { ways } = scopesOf(front, sent);

    expect(ways.map(({ as }) => as)).toStrictEqual([
      ", its navigation's cookie sid #2 kept partitioned",
      ", its navigation's cookie sid #1 kept partitioned",
    ]);
    expect(
      ways.map(({ scopes }) => cookieFor(jarOf(sent, { document: front, scopes }), front)),
    ).toStrictEqual(['sid=a; sid=b', 'sid=a; sid=b']);
  });

  it('keeps one partitioned beside the one of its name and path a document sets, which is not', () => {
    const { ways } = scopesOf(page, 'sid=old');
    const set = cookieChangesOf({ 'set-cookie': ['sid=new; Path=/'] });
    const sent = ways.map(({ scopes }) => {
      const jar = jarOf('sid=old', { document: page, scopes });
      return cookieFor(storedAfter(jar, set, page), page);
    });

    expect(ways.map(({ as }) => as)).toContain(", its navigation's cookies kept partitioned");
    // Replaced where it was not partitioned either, and sent beside it, the older first, where it was.
    expect(sent).toContain('sid=new');
    expect(sent).toContain('sid=old; sid=new');
  });

  it('proves none where a browser keeps them in no way, more of a name than scopes, and says so', () => {
    // An address's front page over plain HTTP: its root path alone, for it alone, and never
    // partitioned, as a browser keeps a partitioned cookie for a secure origin alone.
    const front = new URL('http://192.0.2.1/');

    expect(scopesOf(front, 'sid=a; sid=b')).toStrictEqual({
      ways: [],
      unproved:
        "its navigation's 2 cookies are kept in no way a browser keeps them, more of a name than scopes to keep them apart in (1): no request proves them",
    });
  });

  it('proves none past as many ways as it follows, and says so', () => {
    expect(scopesOf(page, 'a=1; b=2; c=3; d=4; e=5').unproved).toBe(
      "its navigation's 5 cookies may be kept in more ways than the check follows (256), each in any of 12 scopes: no request proves them",
    );
  });
});
