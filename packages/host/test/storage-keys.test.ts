import { describe, expect, it } from 'vitest';

import { kvHostPointerKey } from '../src/storage/keys.ts';

describe('the key a hostname is served under', () => {
  it('is the same whatever case the hostname is written in', () => {
    expect(kvHostPointerKey('Example.COM')).toBe(kvHostPointerKey('example.com'));
  });

  it('is the same for the fully qualified spelling', () => {
    expect(kvHostPointerKey('example.com.')).toBe(kvHostPointerKey('example.com'));
  });

  /** A request's hostname is its URL's, which spells a name written past ASCII as IDNA does. */
  it('is the same for a name written past ASCII as for its ASCII spelling', () => {
    const asked = new URL('https://münich.example/').hostname;

    expect(asked).toBe('xn--mnich-kva.example');
    expect(kvHostPointerKey('Münich.Example.')).toBe(kvHostPointerKey(asked));
  });

  /** Read as a URL's host, it would be spelled as the part on one side of the delimiter alone. */
  it("is no other name's for a name that holds what ends a host", () => {
    expect(kvHostPointerKey('ü@example.com')).not.toBe(kvHostPointerKey('example.com'));
    expect(kvHostPointerKey('münich.example/x')).not.toBe(kvHostPointerKey('münich.example'));
  });

  /** What every writer has stored a pointer under: the lower-case name, with no trailing dot. */
  it('keeps the key a lower-case hostname has always had', () => {
    expect(kvHostPointerKey('www.example.com')).toBe('host:www.example.com');
  });
});
