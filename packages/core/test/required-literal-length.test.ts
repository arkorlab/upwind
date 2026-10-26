import { describe, expect, it } from 'vitest';

import { requiredLiteralLength } from '../src/request/required-literal-length.ts';

describe('a match length proved by a mandatory literal', () => {
  it('finds a later literal past dynamic path segments', () => {
    expect(requiredLiteralLength('^/(?<locale>[^/]+)/(?<team>[^/]+)/catalog$')).toBe(8);
  });

  it.each([
    '^/short$|^/catalog$',
    '^(?:/catalog)?$',
    '^(?=/catalog)/.*$',
    String.raw`^(x)\1/catalog$`,
    '^/[catalog]+$',
  ])('does not turn an uncertain candidate into a length proof: %s', (source) => {
    expect(requiredLiteralLength(source)).toBeUndefined();
  });

  it('consumes a complete legacy octal token before proving its printable suffix', () => {
    expect(requiredLiteralLength(String.raw`^\012ab$`)).toBe(2);
    expect(requiredLiteralLength(String.raw`^\057ab$`)).toBe(3);
    expect(requiredLiteralLength(String.raw`^\012a$`)).toBeUndefined();
  });

  it('does not include a quantified final literal in its candidate', () => {
    expect(requiredLiteralLength('^/catalog?$')).toBe(7);
    expect(requiredLiteralLength('^/catalo[g]$')).toBe(7);
  });

  it('reads a literal escape as its character rather than its source length', () => {
    expect(requiredLiteralLength(String.raw`^/catalog\.json$`)).toBe(13);
    expect(requiredLiteralLength(String.raw`^/\x63atalog$`)).toBe(8);
  });

  it('bounds both the retained proof and source it reads', () => {
    expect(requiredLiteralLength(`^/${'a'.repeat(100)}$`)).toBe(64);
    expect(requiredLiteralLength(`^/${'a'.repeat(4096)}$`)).toBeUndefined();
    expect(requiredLiteralLength(`^${'(?:'.repeat(32)}x${')'.repeat(32)}/catalog$`)).toBe(8);
    expect(
      requiredLiteralLength(`^${'(?:'.repeat(33)}x${')'.repeat(33)}/catalog$`),
    ).toBeUndefined();
  });

  it.each([
    ['^/(?<locale>en|ja)/(?<team>[^/]+)/catalog$', ['', '/', '/en', '/ja/team/catalog']],
    [String.raw`^/catalog\.json$`, ['', '/', '/catalog.json', '/CATALOG.JSON']],
    ['^/catalog?$', ['', '/', '/catalo', '/catalog']],
    ['^/café/catalog$', ['', '/', '/café/catalog', '/CAFÉ/CATALOG']],
    [String.raw`^\012ab$`, ['', 'ab', '\nab', '\nAB', '12ab']],
    [String.raw`^\057ab$`, ['', '/ab', '/AB', '57ab']],
  ] as const)('keeps every real match at least as long as its proof: %s', (source, values) => {
    const minimum = requiredLiteralLength(source);

    expect(minimum).toBeDefined();

    for (const flags of ['', 'i']) {
      // eslint-disable-next-line security/detect-non-literal-regexp -- compare the conservative proof with the real routing grammar
      const pattern = new RegExp(source, flags);
      const matches = values.filter((value) => pattern.test(value));

      expect(matches.length).toBeGreaterThan(0);

      for (const value of matches) {
        expect(value.length).toBeGreaterThanOrEqual(minimum ?? Infinity);
      }
    }
  });
});
