import { describe, expect, it } from 'vitest';

import { requiresLiteral } from '../src/request/required-literal.ts';

const LITERAL = '/catalog';

describe('mandatory routing literals across group boundaries', () => {
  it.each([
    '^/catalog(?:alpha|beta)$',
    '^/catalog(?<suffix>alpha|beta)$',
    '^/catalog(?:alpha|beta)?$',
    '^/catalog(?:alpha|beta){0,2}$',
    '^/catalog(?=alpha)alpha$',
    '^(?:/catalog(?:alpha|beta)|/catalog(?:gamma|delta))$',
    '^(?:(?:/catalog)|(?:/catalogue))$',
  ])('keeps a proven prefix when a group follows: %s', (source) => {
    expect(requiresLiteral(source, LITERAL)).toBe(true);
  });

  it.each([
    '^/catalog(?:alpha|beta)$|^/other$',
    '^(?:/catalog)?(?:alpha|beta)$',
    '^(?:(?:/catalog)|(?:/other))$',
    String.raw`^/catalog\1$`,
    '^/catalog)',
    '^/catalog(?:unfinished',
  ])('keeps an uncertain or invalid token path unproved: %s', (source) => {
    expect(requiresLiteral(source, LITERAL)).toBe(false);
  });

  it('proves the same prefix before deeply nested alternatives', () => {
    const nested = `${'(?:'.repeat(24)}alpha|beta${')'.repeat(24)}`;

    expect(requiresLiteral(`^/catalog${nested}$`, LITERAL)).toBe(true);
    expect(requiresLiteral(`^${nested}$`, LITERAL)).toBe(false);
  });

  it.each([
    ['^/catalog(?:alpha|beta)$', ['/catalogalpha', '/catalogbeta', '/other']],
    ['^/catalog(?:alpha|beta)?$', ['/catalog', '/catalogalpha', '/other']],
    ['^/catalog(?:alpha|beta){0,2}$', ['/catalog', '/catalogalphabeta', '/other']],
    [
      '^(?:/catalog(?:alpha|beta)|/catalog(?:gamma|delta))$',
      ['/catalogalpha', '/catalogdelta', '/other'],
    ],
  ] as const)('keeps every native match inside the literal proof: %s', (source, values) => {
    // eslint-disable-next-line security/detect-non-literal-regexp, require-unicode-regexp -- compare the proof with the native routing expression without flags
    const pattern = new RegExp(source);
    const matches = values.filter((value) => pattern.test(value));

    expect(requiresLiteral(source, LITERAL)).toBe(true);
    expect(matches.length).toBeGreaterThan(0);

    for (const value of matches) {
      expect(value).toContain(LITERAL);
    }
  });
});
