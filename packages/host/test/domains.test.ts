import { describe, expect, it } from 'vitest';

import { isUnderAnyDomain } from '../src/domains/index.ts';

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
});
