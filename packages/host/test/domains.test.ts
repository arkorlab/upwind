import { describe, expect, it } from 'vitest';

import { dnsSpelling, isUnderAnyDomain } from '../src/domains/index.ts';

describe('a hostname under a list of domains', () => {
  it('is one of them, or a name beneath one, whatever its case', () => {
    expect(isUnderAnyDomain('Example.COM', ['example.com'])).toBe(true);
    expect(isUnderAnyDomain('app.example.com', ['EXAMPLE.com'])).toBe(true);
    expect(isUnderAnyDomain('example.com', ['other.example', 'example.com'])).toBe(true);
  });

  it('is not a name that only ends in the same letters', () => {
    expect(isUnderAnyDomain('notexample.com', ['example.com'])).toBe(false);
    expect(isUnderAnyDomain('example.com.evil', ['example.com'])).toBe(false);
  });

  /** A URL keeps the fully qualified spelling's dot, and that names the same host. */
  it('is judged the same in its fully qualified spelling', () => {
    expect(isUnderAnyDomain(new URL('https://app.example.com./').hostname, ['example.com'])).toBe(
      true,
    );
    expect(isUnderAnyDomain('example.com.', ['example.com'])).toBe(true);
    expect(isUnderAnyDomain('app.example.com', ['example.com.'])).toBe(true);
    expect(isUnderAnyDomain('notexample.com.', ['example.com'])).toBe(false);
  });

  /** A URL spells a name written past ASCII as IDNA does, and either spelling names the same host. */
  it('is judged the same in a name written past ASCII as in its ASCII spelling', () => {
    expect(isUnderAnyDomain('app.xn--mnich-kva.example', ['Münich.example'])).toBe(true);
    expect(isUnderAnyDomain('app.münich.example', ['xn--mnich-kva.example'])).toBe(true);
  });

  /** Read as a URL's host, `ü@example.com` would be `example.com`, which it is not. */
  it('is not the name a URL would read past a delimiter in it', () => {
    expect(isUnderAnyDomain('ü@example.com', ['example.com'])).toBe(false);
    expect(isUnderAnyDomain('example.com', ['ü@example.com'])).toBe(false);
  });
});

describe('a name as DNS compares it', () => {
  it('is spelled as a URL spells its hostname', () => {
    for (const name of ['Münich.Example', 'bücher.example.', 'Example.COM.']) {
      expect(dnsSpelling(name)).toBe(dnsSpelling(new URL(`https://${name}/`).hostname));
    }
  });

  /** A name in ASCII is spelled as it always was, whatever the URL parser would make of it. */
  it("keeps a name written in ASCII as it was, but for its case and the root's dot", () => {
    expect(dnsSpelling('WWW.Example.com.')).toBe('www.example.com');
    expect(dnsSpelling('ex%41mple.com')).toBe('ex%41mple.com');
  });
});
