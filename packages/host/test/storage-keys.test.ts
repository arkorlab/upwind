import { describe, expect, it } from 'vitest';

import { kvHostPointerKey } from '../src/storage/keys.ts';

describe('the key a hostname is served under', () => {
  it('is the same whatever case the hostname is written in', () => {
    expect(kvHostPointerKey('Example.COM')).toBe(kvHostPointerKey('example.com'));
  });

  it('is the same for the fully qualified spelling', () => {
    expect(kvHostPointerKey('example.com.')).toBe(kvHostPointerKey('example.com'));
  });

  /** What every writer has stored a pointer under: the lower-case name, with no trailing dot. */
  it('keeps the key a lower-case hostname has always had', () => {
    expect(kvHostPointerKey('www.example.com')).toBe('host:www.example.com');
  });
});
