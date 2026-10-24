import { describe, expect, it } from 'vitest';

import { requiresLiteral } from '../src/request/required-literal.ts';

/**
 * What a pattern proves every match of it spells. The dynamic routes a document is not asked are
 * the ones this proves need `.rsc` or `/_next/data/` in the pathname, so a wrong `true` would
 * serve a page a data route claims: every `true` below is one no match can escape.
 */

const RSC = '.rsc';
const DATA = '/_next/data/';

describe('requiresLiteral', () => {
  it.each([
    // A page's RSC variant, as `next build` writes it beside the page.
    String.raw`^[/]?/en/(?<nxtPorgSlug>[^/]+?)(?<rscSuffix>\.rsc|\.segments/.+\.segment\.rsc)(?:/)?$`,
    // A prefetch segment route, with its segment path spelled as Next.js spells it.
    String.raw`^[/]?/(?<nxtPlocale>[^/]+?)/blog\.segments/\$d\$locale/!KHNpdGUp/blog(?<segment>/__PAGE__\.segment\.rsc|\.segment\.rsc)(?:/)?$`,
    String.raw`^[/]?/en/docs(?:/(?<nxtPslug>.+?))?\.segments/\$d\$locale/docs/\$oc\$slug(?<segment>/__PAGE__\.segment\.rsc|\.segment\.rsc)(?:/)?$`,
    // Alternatives that each spell it, at the top and in a group.
    String.raw`^/x\.rsc$|^/y\.rsc$`,
    String.raw`^/x(?:\.rsc|\.segments/.+\.segment\.rsc)$`,
    // Escapes that name the characters.
    String.raw`^/x\u002Ersc$`,
    String.raw`^/x\x2Ersc$`,
    // A lookaround spells nothing, and the run after it still does.
    String.raw`^/x(?!\.json)\.rsc$`,
  ])('proves every match of %s spells .rsc', (pattern) => {
    expect(requiresLiteral(pattern, RSC)).toBe(true);
  });

  it.each([
    String.raw`^/_next/data/Bu1ld\-ID_x[/]?/blog/(?<nxtPslug>[^/]+?)\.json(?:/)?$`,
    String.raw`^/_next/data/Bu1ld\-ID_x[/]?/shop(?:/(?<nxtPslug>.+?))?\.json(?:/)?$`,
    // An application with `i18n` and a base path, whose root's data is one route of its own.
    String.raw`^/docs/_next/data/Bu1ld\-ID_x/(?<nextLocale>[^/]{1,}).json`,
  ])('proves every match of %s spells /_next/data/', (pattern) => {
    expect(requiresLiteral(pattern, DATA)).toBe(true);
  });

  it.each([
    // Pages: nothing in them is a data route's.
    '^[/]?/en/(?<nxtPorgSlug>[^/]+?)(?:/)?$',
    '^[/]?/docs/(?<nxtPslug>.+?)(?:/)?$',
    '^[/]?/shop(?:/(?<nxtPslug>.+?))?(?:/)?$',
    // An alternative that does not spell it, at the top or in a group.
    String.raw`^/a|/b\.rsc$`,
    String.raw`^/(?:a|b\.rsc)$`,
    String.raw`^/x(?:\.rsc|\.json)$`,
    // Optional, repeated or quantified, the characters may not be there as a run.
    String.raw`^/x(?:\.rsc)?$`,
    String.raw`^/x(?:\.rsc)*$`,
    String.raw`^/x\.rsc?$`,
    String.raw`^/x\.rs*c$`,
    String.raw`^/x\.rsc{0,1}$`,
    // Case matters: the pattern is compiled without `i`.
    String.raw`^/x\.RSC$`,
    // A set, a wildcard or an anchor between the characters ends the run.
    '^/x[.]rsc$',
    '^/x.rsc$',
    String.raw`^/x\.r$sc`,
    // What this does not read is taken to spell nothing: a backreference, an octal escape, a
    // modifier group, a lookahead's contents.
    String.raw`^/(?<a>\.rsc)?\k<a>$`,
    String.raw`^/x\01rsc$`,
    String.raw`^/x(?i:\.rsc)$`,
    String.raw`^/x(?=\.rsc)`,
    // A run split by a group is not read across it.
    String.raw`^/x\.r(?:s)c$`,
  ])('does not claim every match of %s spells .rsc', (pattern) => {
    expect(requiresLiteral(pattern, RSC)).toBe(false);
  });

  it('claims nothing of the empty literal, which every string contains', () => {
    expect(requiresLiteral('^/x$', '')).toBe(false);
  });

  /**
   * Checked against the engine, over strings built to slip past a wrong reading: a `true` for any
   * of these patterns, with a match that lacks the literal, would be a route skipped for a
   * pathname it matches.
   */
  it('never claims a literal a match can go without', () => {
    const patterns = [
      String.raw`^/a|/b\.rsc$`,
      String.raw`^/(?:a|b\.rsc)$`,
      String.raw`^/x(?:\.rsc)?$`,
      String.raw`^/x\.rsc?$`,
      String.raw`^/x\.rs*c$`,
      '^/x.rsc$',
      '^/x[.]rsc$',
      String.raw`^/x\.RSC$`,
      String.raw`^/x(?=\.rsc)`,
    ];
    const samples = [
      '/a',
      '/b.rsc',
      '/x',
      '/x.rs',
      '/x.rc',
      '/xarsc',
      '/x.RSC',
      '/x.rsc',
      '/x.rscz',
    ];
    for (const pattern of patterns) {
      // eslint-disable-next-line security/detect-non-literal-regexp, require-unicode-regexp -- as the edge compiles it
      const regex = new RegExp(pattern);
      const escapes = samples.some((sample) => regex.test(sample) && !sample.includes(RSC));

      expect(escapes && requiresLiteral(pattern, RSC)).toBe(false);
    }
  });
});
