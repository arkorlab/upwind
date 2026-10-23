import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  cookieChangesOf,
  cookieFor,
  cookiesAfter,
  jarKeyOf,
  jarOf,
  storedAfter,
  unprovedHolding,
} from '../src/cookie-jar.ts';

const page = new URL('https://site.example/account');

/** A request of the page's own at `pathname`, once its document was answered. */
function at(pathname: string): { readonly document: URL; readonly request: URL } {
  return { document: page, request: new URL(pathname, page) };
}

/** What an answer that sets `set` and clears nothing does to the cookies a browser keeps. */
function setting(...set: string[]): { readonly set: readonly string[]; readonly cleared: false } {
  return { set, cleared: false };
}

describe("the cookies a page's parts are asked with", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps those the navigation was asked with, as the site's own under its root path", () => {
    expect(cookiesAfter('sid=old; theme=dark', [], at('/_next/data/b/account.json'))).toBe(
      'sid=old; theme=dark',
    );
  });

  it('removes only the same cookie a Set-Cookie expires: by its path, too', () => {
    expect(cookiesAfter('sid=old', ['sid=; Max-Age=0; Path=/other'], at('/account'))).toBe(
      'sid=old',
    );
    expect(cookiesAfter('sid=old', ['sid=; Max-Age=0; Path=/'], at('/account'))).toBeUndefined();
  });

  it('stores one of another path beside one of the same name, the longer path sent first', () => {
    expect(cookiesAfter('sid=old', ['sid=new; Path=/account'], at('/account'))).toBe(
      'sid=new; sid=old',
    );
    expect(cookiesAfter('sid=old', ['sid=new; Path=/'], at('/account'))).toBe('sid=new');
  });

  it("keeps one that names no path under the document's directory", () => {
    const shop = new URL('https://site.example/shop/item');
    const asked = { document: shop, request: new URL('/shop/item?_rsc=1', shop) };
    const props = { document: shop, request: new URL('/_next/data/b/shop/item.json', shop) };

    expect(cookiesAfter(undefined, ['cart=1'], asked)).toBe('cart=1');
    expect(cookiesAfter(undefined, ['cart=1'], props)).toBeUndefined();
  });

  it("keeps one a part's answer sets under that part's directory, beside those set before", () => {
    const shop = new URL('https://site.example/shop/item');
    const props = new URL('/_next/data/b/shop/item.json', shop);
    const navigated = storedAfter(
      jarOf('sid=old', { document: shop }),
      setting('sid=new; Path=/'),
      shop,
    );
    const fetched = storedAfter(navigated, setting('cart=1'), props);

    expect(cookieFor(fetched, props)).toBe('cart=1; sid=new');
    expect(cookieFor(fetched, shop)).toBe('sid=new');
  });

  it('sends one no more once its lifetime has passed, as a browser keeps it no longer', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: 0 });
    const brief = storedAfter(
      jarOf('theme=dark', { document: page }),
      setting('sid=1; Max-Age=1'),
      page,
    );
    const dated = storedAfter(
      brief,
      setting('cart=1; Expires=Thu, 01 Jan 1970 00:00:02 GMT'),
      page,
    );

    expect(cookieFor(dated, page)).toBe('theme=dark; sid=1; cart=1');

    vi.setSystemTime(1000);

    expect(cookieFor(dated, page)).toBe('theme=dark; cart=1');
    expect(storedAfter(dated, setting(), page)).toHaveLength(2);

    vi.setSystemTime(2000);

    expect(cookieFor(dated, page)).toBe('theme=dark');
  });

  it('reads what an answer clears as Clear-Site-Data names it: cookies, or every type, quoted', () => {
    expect(cookieChangesOf({ 'clear-site-data': '"cache", "cookies"' }).cleared).toBe(true);
    expect(cookieChangesOf({ 'clear-site-data': '"*"' }).cleared).toBe(true);
    expect(cookieChangesOf({ 'clear-site-data': 'cookies' }).cleared).toBe(false);
    expect(cookieChangesOf({ 'clear-site-data': '"storage"' }).cleared).toBe(false);
    expect(cookieChangesOf({ 'set-cookie': ['a=1'] })).toStrictEqual({
      set: ['a=1'],
      cleared: false,
    });
  });

  it('tells jars apart by what they send, not by when their cookies end', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: 0 });
    const set = setting('sid=1; Max-Age=600');
    const first = storedAfter(jarOf(undefined, { document: page }), set, page);
    vi.setSystemTime(1000);
    const again = storedAfter(first, set, page);
    const other = storedAfter(first, setting('sid=2; Max-Age=600'), page);

    expect(jarKeyOf(again)).toBe(jarKeyOf(first));
    expect(jarKeyOf(other)).not.toBe(jarKeyOf(first));
  });

  it('clears every one an answer on a secure origin clears, those it sets among them', () => {
    const cleared = { set: ['sid=new'], cleared: true };
    const plain = new URL('http://site.example/account');

    const unsecured = storedAfter(jarOf('sid=old', { document: plain }), cleared, plain);

    expect(storedAfter(jarOf('sid=old', { document: page }), cleared, page)).toStrictEqual([]);
    expect(cookieFor(unsecured, plain)).toBe('sid=new');
  });

  it('ignores an attribute whose value is longer than a browser reads, as if it were not there', () => {
    const shop = new URL('https://site.example/shop/item');
    const asked = { document: shop, request: new URL('/shop/item?_rsc=1', shop) };
    // A path of 1,024 octets is read, and one of 1,025 ignored, which leaves the document's own.
    const read = `/${'a'.repeat(1023)}`;
    const ignored = `/${'a'.repeat(1024)}`;

    expect(cookiesAfter(undefined, [`cart=1; Path=${read}`], asked)).toBeUndefined();
    expect(cookiesAfter(undefined, [`cart=1; Path=${ignored}`], asked)).toBe('cart=1');
    expect(cookiesAfter(undefined, [`cart=1; Path=/; Path=${ignored}`], at('/account'))).toBe(
      'cart=1',
    );
  });

  it('refuses one for another site, and one for secure origins on a site that is none', () => {
    const plain = new URL('http://site.example/');
    const local = new URL('http://localhost/');

    expect(cookiesAfter(undefined, ['a=1; Domain=other.example'], at('/account'))).toBeUndefined();
    expect(
      cookiesAfter(undefined, ['a=1; Secure'], { document: plain, request: plain }),
    ).toBeUndefined();
    expect(
      cookiesAfter(undefined, ['a=1; Secure'], { document: local, request: new URL('/x', local) }),
    ).toBe('a=1');
  });

  it('refuses a prefixed one lacking what its prefix asks', () => {
    expect(
      cookiesAfter(undefined, ['__Host-a=1; Secure; Path=/; Domain=site.example'], at('/account')),
    ).toBeUndefined();
    expect(cookiesAfter(undefined, ['__Secure-a=1'], at('/account'))).toBeUndefined();
    expect(cookiesAfter(undefined, ['__Host-a=1; Secure; Path=/'], at('/account'))).toBe(
      '__Host-a=1',
    );
    // Under the root path as the document's directory, by no `Path` of its own — or by one of no
    // such value, which the document's directory stands in for.
    expect(cookiesAfter(undefined, ['__Host-a=1; Secure'], at('/account'))).toBeUndefined();
    expect(cookiesAfter(undefined, ['__Host-a=1; Secure; Path='], at('/account'))).toBeUndefined();
    expect(
      cookiesAfter(undefined, ['__Host-a=1; Secure; Path=invalid'], at('/account')),
    ).toBeUndefined();
  });

  it('keeps a partitioned cookie beside an unpartitioned one of the same name, and sends both', () => {
    const answered = at('/');
    const unpartitioned = storedAfter([], setting('sid=a; Path=/'), answered.document);
    const both = storedAfter(
      unpartitioned,
      setting('sid=b; Secure; Path=/; Partitioned'),
      answered.document,
    );

    expect(cookieFor(both, answered.request)).toBe('sid=a; sid=b');

    // And replaces each by its own: a partitioned one by a partitioned one alone.
    const renewed = storedAfter(
      both,
      setting('sid=c; Secure; Path=/; Partitioned'),
      answered.document,
    );

    expect(cookieFor(renewed, answered.request)).toBe('sid=a; sid=c');
  });

  it('takes what the navigation sent as kept for its host alone, or for its every host where asked to', () => {
    const domained = ['sid=new; Domain=site.example; Path=/'];
    const www = new URL('https://www.site.example/account');
    const parent = { document: www, request: www, scope: { domain: 'site.example' } };

    expect(cookiesAfter('sid=old', domained, at('/account'))).toBe('sid=old; sid=new');
    expect(
      cookiesAfter('sid=old', domained, { ...at('/account'), scope: { domain: 'site.example' } }),
    ).toBe('sid=new');
    // A cookie of the host's own beside the one its domain keeps, which a browser sends both of.
    expect(cookiesAfter('sid=parent', ['sid=host; Path=/'], parent)).toBe('sid=parent; sid=host');
  });

  it('keeps a cookie of its host alone apart from one of its domain, as the same name and path', () => {
    expect(
      cookiesAfter(undefined, ['a=1; Path=/', 'a=2; Domain=site.example; Path=/'], at('/account')),
    ).toBe('a=1; a=2');
  });

  it('refuses one for a domain no site holds, but where it is the host itself', () => {
    const shop = new URL('https://shop.example.co.uk/');
    const pages = new URL('https://user.github.io/');
    const suffix = new URL('https://github.io/');

    expect(
      cookiesAfter(undefined, ['a=1; Domain=co.uk'], { document: shop, request: shop }),
    ).toBeUndefined();
    expect(
      cookiesAfter(undefined, ['a=1; Domain=example.co.uk'], { document: shop, request: shop }),
    ).toBe('a=1');
    expect(
      cookiesAfter(undefined, ['a=1; Domain=github.io'], { document: pages, request: pages }),
    ).toBeUndefined();
    expect(
      cookiesAfter(undefined, ['a=1; Domain=github.io'], { document: suffix, request: suffix }),
    ).toBe('a=1');
  });

  it('matches the prefixes in any case, as RFC 6265bis has browsers match them', () => {
    expect(cookiesAfter(undefined, ['__secure-a=1'], at('/account'))).toBeUndefined();
    expect(cookiesAfter(undefined, ['__HOST-a=1; Secure; Path=/'], at('/account'))).toBe(
      '__HOST-a=1',
    );
  });

  it('parses a name as RFC 6265bis has browsers parse it: the spaces inside it kept, and none where there is no =', () => {
    expect(cookiesAfter(undefined, ['bad name=1'], at('/account'))).toBe('bad name=1');
    // A nameless cookie, sent as its value alone.
    expect(cookiesAfter(undefined, ['token'], at('/account'))).toBe('token');
    expect(cookiesAfter(undefined, ['=token'], at('/account'))).toBe('token');
  });

  it('refuses one with a control character, no name and no value, more octets than a browser keeps, or a nameless one that reads as prefixed', () => {
    expect(cookiesAfter(undefined, ['a=1\u{1}'], at('/account'))).toBeUndefined();
    expect(cookiesAfter(undefined, ['='], at('/account'))).toBeUndefined();
    expect(cookiesAfter(undefined, [`a=${'x'.repeat(4096)}`], at('/account'))).toBeUndefined();
    expect(cookiesAfter(undefined, [`a=${'x'.repeat(4095)}`], at('/account'))).toBe(
      `a=${'x'.repeat(4095)}`,
    );
    expect(cookiesAfter(undefined, ['__Host-a; Secure; Path=/'], at('/account'))).toBeUndefined();
  });

  it('refuses one sent to other sites that is not secure (SameSite=None)', () => {
    expect(cookiesAfter(undefined, ['sid=1; SameSite=None'], at('/account'))).toBeUndefined();
    expect(cookiesAfter(undefined, ['sid=1; SameSite=None; Secure'], at('/account'))).toBe('sid=1');
    expect(cookiesAfter(undefined, ['sid=1; SameSite=Lax'], at('/account'))).toBe('sid=1');
  });

  it('refuses one kept apart by the site it is set under that is not secure (Partitioned)', () => {
    expect(cookiesAfter(undefined, ['sid=1; Partitioned'], at('/account'))).toBeUndefined();
    expect(cookiesAfter(undefined, ['sid=1; Partitioned; Secure'], at('/account'))).toBe('sid=1');
  });

  it("takes what the navigation sent as kept under the page's own path, where asked to", () => {
    const own = { scope: { path: '/account' } };

    expect(cookiesAfter('sid=old', [], { ...at('/account?_rsc=1'), ...own })).toBe('sid=old');
    expect(
      cookiesAfter('sid=old', [], { ...at('/_next/data/b/account.json'), ...own }),
    ).toBeUndefined();
  });

  it("keeps a name the navigation sent twice as two cookies, the later the root path's", () => {
    const replaced = ['sid=new; Path=/'];

    expect(cookiesAfter('sid=narrow; sid=root', replaced, at('/account'))).toBe(
      'sid=narrow; sid=new',
    );
    expect(
      cookiesAfter('sid=narrow; sid=root', replaced, {
        ...at('/account'),
        scope: { path: '/account' },
      }),
    ).toBe('sid=narrow; sid=new');
  });

  it('reads Expires as RFC 6265 reads a cookie date, not as JavaScript reads a date', () => {
    // A day of the month run into its month: no month, so no date — a session cookie.
    expect(cookiesAfter('a=1', ['a=2; Expires=Thu,01Jan1970 00:00:00 GMT'], at('/account'))).toBe(
      'a=2',
    );
    // A year run into its time: no time, so no date either.
    expect(cookiesAfter('a=1', ['a=2; Expires=09/Jun/2021:10:18:14 GMT'], at('/account'))).toBe(
      'a=2',
    );
    // Its first month, past a word JavaScript reads as another; a two-digit year of the 1900s.
    expect(
      cookiesAfter('a=1', ['a=2; Expires=1 Jan 2000 00:00:00 junk'], at('/account')),
    ).toBeUndefined();
    expect(
      cookiesAfter('a=1', ['a=2; Expires=Thu, 01-Jan-70 00:00:00 GMT'], at('/account')),
    ).toBeUndefined();
  });

  it('expires one by its date, its Max-Age over its Expires', () => {
    const past = 'Expires=Thu, 01 Jan 1970 00:00:00 GMT';

    expect(cookiesAfter('a=1', [`a=2; ${past}`], at('/account'))).toBeUndefined();
    expect(cookiesAfter('a=1', [`a=2; Max-Age=60; ${past}`], at('/account'))).toBe('a=2');
  });

  it("reads an Expires against its answer's Date as Chrome and Firefox do, and proves nothing where another reading differs", () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.UTC(2026, 0, 1, 12) });
    // An answer dated an hour behind the check's clock, whose cookie ends half an hour after that.
    const changes = cookieChangesOf({
      date: 'Thu, 01 Jan 2026 11:00:00 GMT',
      'set-cookie': ['mark=1; Path=/; Expires=Thu, 01 Jan 2026 11:30:00 GMT'],
    });
    const jar = storedAfter([], changes, page);

    expect(changes.skew).toBe(3_600_000);
    // Kept for half an hour yet, as Chrome and Firefox keep it; ended, by the browser's own clock.
    expect(cookieFor(jar, page)).toBe('mark=1');
    expect(unprovedHolding(jar)).toBe(
      'cookie mark has ended as one browser reads its Expires and not as another does — against the Date of the answer that set it, as Chrome and Firefox read it, or by its own clock: no request proves whether a browser sends it',
    );

    // Its Max-Age is read against no Date; and once both readings have it ended, it is gone.
    const aged = cookieChangesOf({
      date: 'Thu, 01 Jan 2026 11:00:00 GMT',
      'set-cookie': ['mark=2; Path=/; Max-Age=60; Expires=Thu, 01 Jan 2026 11:30:00 GMT'],
    });

    expect(unprovedHolding(storedAfter([], aged, page))).toBeUndefined();

    vi.setSystemTime(Date.UTC(2026, 0, 1, 12, 30));

    expect(cookieFor(jar, page)).toBeUndefined();
    expect(unprovedHolding(jar)).toBeUndefined();
  });

  it('proves nothing past one that lacks what an HTTP prefix asks, which Chrome refuses and Safari keeps', () => {
    const lacking = storedAfter([], setting('__Http-session=1; Secure; Path=/'), page);
    const nameless = storedAfter([], setting('__Http-session; Secure; HttpOnly; Path=/'), page);
    const hosted = storedAfter([], setting('__Host-Http-session=1; Secure; Path=/'), page);

    // Kept as a browser that does not know the prefix keeps it, and told apart from Chrome's.
    expect(cookieFor(lacking, page)).toBe('__Http-session=1');
    expect(unprovedHolding(lacking)).toBe(
      'cookie __Http-session lacks what its prefix asks — secure, and HttpOnly — which Chrome refuses it for and a browser that does not know the prefix (Safari) keeps it all the same: no request proves whether a browser sends it',
    );
    expect(unprovedHolding(nameless)).toMatch(/^cookie __Http-session lacks what its prefix asks/u);
    expect(unprovedHolding(hosted)).toMatch(
      /^cookie __Host-Http-session lacks what its prefix asks/u,
    );

    // Kept alike where it holds what the prefix asks, and refused alike where it lacks what
    // `__Host-` asks, which every browser enforces.
    const whole = storedAfter([], setting('__Http-session=1; Secure; HttpOnly; Path=/'), page);
    const shared = storedAfter(
      [],
      setting('__Host-Http-session=1; Secure; HttpOnly; Path=/; Domain=site.example'),
      page,
    );

    expect(cookieFor(whole, page)).toBe('__Http-session=1');
    expect(unprovedHolding(whole)).toBeUndefined();
    expect(shared).toStrictEqual([]);
    expect(unprovedHolding(shared)).toBeUndefined();
  });

  it("proves nothing a browser sends once it holds more of the site's cookies than one need keep", () => {
    const fifty = Array.from({ length: 50 }, (_, place) => `c${String(place)}=1; Path=/`);
    const full = storedAfter([], setting(...fifty), page);
    const over = storedAfter(full, setting('more=1; Path=/'), page);

    expect(unprovedHolding(full)).toBeUndefined();
    expect(unprovedHolding(over)).toBe(
      "a browser holds 51 cookies of the site's, more than one need keep of a domain (50), any of which it may have dropped: no request proves which it sends",
    );
  });
});
