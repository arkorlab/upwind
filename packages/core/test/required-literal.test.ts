import { describe, expect, it } from 'vitest';

import { requiresLiteral } from '../src/request/required-literal.ts';

const LITERAL = '/catalog';
const DATA_LITERAL = '.rsc';

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

describe('mandatory routing literals outside groups', () => {
  it.each([
    String.raw`^/(?<locale>en|ja)/(?<slug>[^/]+)\.rsc(?:/)?$`,
    String.raw`^(?:alpha|beta){0,2}\.rsc$`,
    String.raw`^(?:alpha|beta)\.rsc$|^(?:gamma|delta)\.rsc$`,
    String.raw`^[()](?:alpha|beta)\.rsc$`,
    String.raw`^\((?:alpha|beta)\.rsc$`,
    String.raw`^(?=alpha)alpha\.rsc$`,
    String.raw`^(?:alpha|beta)\x2ersc$`,
  ])('proves a mandatory suffix without relying on the group contents: %s', (source) => {
    expect(requiresLiteral(source, DATA_LITERAL)).toBe(true);
  });

  it.each([
    String.raw`^(\.rsc)\1$`,
    String.raw`^(\.rsc)\c$`,
    String.raw`^(\.rsc)(?:unfinished`,
    String.raw`^(\.rsc)[unfinished`,
  ])('retains an earlier group proof before an unread later token: %s', (source) => {
    // Failure of the outside-only attempt is not a negative proof: the ordinary reader can have
    // proved the group before it would encounter this later unsupported or malformed token.
    expect(requiresLiteral(source, DATA_LITERAL)).toBe(true);
  });

  it.each([
    String.raw`^(?:alpha|beta)\.rsc$|^/other$`,
    String.raw`^(\.rsc)?(?:alpha|beta)$`,
    String.raw`^(\.rsc){1}\1$`,
    String.raw`^(?:alpha|beta)\.rsc\1$`,
    String.raw`^(?:alpha|beta)\.rsc(?:unfinished`,
    String.raw`^(\.rsc))`,
    String.raw`^(?:alpha|beta)\.rsc?$`,
    String.raw`^(?:alpha|beta)[.]rsc$`,
    String.raw`^(?:alpha|beta)\01.rsc$`,
    String.raw`^(?:alpha|beta){oops}\.rsc$`,
    String.raw`^(?:\.rs)c$`,
  ])('retains conservative alternative, quantifier and token boundaries: %s', (source) => {
    expect(requiresLiteral(source, DATA_LITERAL)).toBe(false);
  });

  it('keeps the flat and empty-literal paths unchanged', () => {
    expect(requiresLiteral(String.raw`^/catalog\.rsc$`, DATA_LITERAL)).toBe(true);
    expect(requiresLiteral('^/catalog$', DATA_LITERAL)).toBe(false);
    expect(requiresLiteral(String.raw`^(?:alpha|beta)\.rsc$`, '')).toBe(false);
  });

  it.each([
    [
      String.raw`^/(?<locale>en|ja)/(?<slug>[^/]+)\.rsc(?:/)?$`,
      ['/en/article.rsc', '/ja/story.rsc/', '/EN/ARTICLE.RSC', '/en/article'],
    ],
    [String.raw`^(?:alpha|beta){0,2}\.rsc$`, ['.rsc', 'alphabeta.rsc', 'ALPHA.RSC', 'alpha']],
    [String.raw`^(\.rsc)\1$`, ['.rsc.rsc', '.RSC.RSC', '.rsc']],
  ] as const)('keeps every native match inside the suffix proof: %s', (source, values) => {
    expect(requiresLiteral(source, DATA_LITERAL)).toBe(true);

    for (const flags of ['', 'i']) {
      // eslint-disable-next-line security/detect-non-literal-regexp -- compare proof-preserving paths with native routing and case behavior
      const pattern = new RegExp(source, flags);
      const matches = values.filter((value) => pattern.test(value));

      expect(matches.length).toBeGreaterThan(0);

      for (const value of matches) {
        expect(value.toLowerCase()).toContain(DATA_LITERAL);
      }
    }
  });
});
