import { describe, expect, it } from 'vitest';

import {
  unsafeRoutePatternReason,
  unsafeSourcePatternReason,
} from '../src/request/pattern-safety.ts';

/**
 * A hosted project's `has` / `missing` patterns are run by the edge against values a visitor
 * chose, on a Worker it shares with every other project. The check is at the upload, so what it
 * admits has to include everything Next.js writes for itself, and what it refuses has to include
 * the shapes that backtrack.
 */

describe('unsafeRoutePatternReason', () => {
  it('admits the patterns Next.js writes', () => {
    const admitted = [
      'beta',
      String.raw`^v\d+$`,
      '(?<slug>[^/]+?)',
      String.raw`^(?:\/(.*))(?:\/)?$`,
      '[a-z]{2}(-[A-Z]{2})?',
      'a{2,4}',
      '(ab){20}',
      '(a+){0}',
      '(a+){1}',
      '(a+){01}',
      '(ja|en)',
      '(?<authorized>yes|true)',
      String.raw`(\w+)`,
    ];

    for (const pattern of admitted) {
      expect([pattern, unsafeRoutePatternReason(pattern)]).toStrictEqual([pattern, undefined]);
    }
  });

  it.each(['{0,0}', '{0,1}', '{1,1}', '{00,01}', '{01,01}?'])(
    'admits a group whose %s range can run at most once',
    (quantifier) => {
      expect(unsafeRoutePatternReason(`^(a+)${quantifier}$`)).toBeUndefined();
    },
  );

  it.each(['{0,2}', '{1,2}', '{2,2}', '{00,02}', '{0,}', '{1,}', '{2,}'])(
    'still refuses nested repetition with the range %s',
    (quantifier) => {
      expect(unsafeRoutePatternReason(`^(a+)${quantifier}$`)).toBeDefined();
    },
  );

  it('refuses a quantifier inside a quantified group', () => {
    for (const pattern of [
      '(a+)+',
      '(a*)*',
      String.raw`(\w+\s?)*`,
      '^(x|y+)+$',
      '((ab)+)+',
      '(a+){2,}',
      '^(a+){20}$',
      '(a+){2}',
      '(a+){02}',
      '(a*){20}?',
      '((ab){2})+',
    ]) {
      expect([pattern, unsafeRoutePatternReason(pattern)]).toStrictEqual([
        pattern,
        'a quantifier inside a quantified group can backtrack catastrophically',
      ]);
    }
  });

  /** Repeated choices can partition one input many ways without any inner quantifier. */
  it.each([
    '^(a|aa)+$',
    '^(a|aa)*$',
    '^(?:a|aa)+$',
    '^(?<part>a|aa)+$',
    '^(a|aa){2}$',
    '^(a|aa){2,}$',
    '^(a|aa){0,2}?$',
    '^((a|aa)b)+$',
    String.raw`^([\]]|aa)+$`,
    String.raw`^(\\|aa)+$`,
  ])('refuses alternation anywhere inside a repeated group: %s', (pattern) => {
    expect(unsafeRoutePatternReason(pattern)).toBe(
      'alternation inside a repeated group can backtrack catastrophically',
    );
  });

  it('conservatively refuses repeated alternatives without proving they are disjoint', () => {
    expect(unsafeRoutePatternReason('^(?:ja|en)+$')).toBeDefined();
  });

  it.each(['', '?', '{0}', '{1}', '{0,1}', '{1,1}'])(
    'keeps alternation when its group is used at most once (%s)',
    (quantifier) => {
      expect(unsafeRoutePatternReason(`^(a|aa)${quantifier}$`)).toBeUndefined();
    },
  );

  it.each([
    String.raw`^(\|)+$`,
    '^([|])+$',
    '^([a|b]){2,}$',
    String.raw`^([\]|])+$`,
    '^(ab)+|cd$',
    '^((ab)+|cd)$',
  ])('keeps pipes that are literal or outside the repeated group: %s', (pattern) => {
    expect(unsafeRoutePatternReason(pattern)).toBeUndefined();
  });

  it.each([
    '^(a?a)+$',
    '^(aa?)+$',
    '^(aa{0,1})+$',
    '^(?:a?b){2}$',
    '^((ab)?c)+$',
    '^(a??a)*$',
    '^(a{00,01}a){2,}$',
    '^(a{0,1}?a){2}$',
    String.raw`^(\(?\()+$`,
    String.raw`^(\({0,1}\()+$`,
  ])('refuses optional choices inside a repeated group: %s', (pattern) => {
    expect(unsafeRoutePatternReason(pattern)).toBe(
      'an optional expression inside a repeated group can backtrack catastrophically',
    );
  });

  it.each([
    '^(?:ab)+$',
    '^(?<part>ab)+$',
    '^((?:ab)c)+$',
    '^((?<part>ab)c)+$',
    '^(ab)+?$',
    '^(ab{0})+$',
    '^(ab{1})+$',
    '^(ab{1}?)+$',
    '^(a{0,0}?b)+$',
    '^(a{1,1}?b)+$',
    String.raw`^(a\?b)+$`,
    '^([?])+$',
    String.raw`^([\]?])+$`,
    '^(a?a)?$',
    '^(a?a){0,1}$',
    '^(a?a){1,1}$',
  ])('distinguishes optional choices from group syntax, lazy flags and literals: %s', (pattern) => {
    expect(unsafeRoutePatternReason(pattern)).toBeUndefined();
  });

  /** A class is one unit, and an escaped bracket or paren is a character like any other. */
  it('reads classes and escapes as the engine does', () => {
    expect(unsafeRoutePatternReason('([*+]+)+')).toBeDefined();
    expect(unsafeRoutePatternReason(String.raw`(\(a\))+`)).toBeUndefined();
    expect(unsafeRoutePatternReason(String.raw`(a\+)+`)).toBeUndefined();
  });

  it.each([
    '(a+){two}',
    '(a+){zero,one}',
    '(a+){,1}',
    '(a+){0, 1}',
    '(a+){0,1\n}',
    String.raw`(a+)\{20\}`,
  ])('treats the braces in %s as literal characters', (pattern) => {
    expect(unsafeRoutePatternReason(pattern)).toBeUndefined();
  });

  it('refuses a pattern too long to reason about', () => {
    expect(unsafeRoutePatternReason('a'.repeat(1001))).toBe('longer than 1000 characters');
  });

  it.each([
    ['a)|(?:a|aa)+(?:', 'alternation inside a repeated group'],
    ['a)|(?:a?a)+(?:', 'an optional expression inside a repeated group'],
    ['a)|(?:a+)+(?:', 'a quantifier inside a quantified group'],
    ['a|aa)+(?:', 'alternation inside a repeated group'],
    ['a?a)+(?:', 'an optional expression inside a repeated group'],
    ['a+)+(?:', 'a quantifier inside a quantified group'],
  ])('checks patterns made valid by the condition matcher wrapper: %s', (pattern, reason) => {
    expect(unsafeRoutePatternReason(pattern)).toContain(reason);
  });

  it('allows a non-repeated alternative made valid by the condition matcher wrapper', () => {
    expect(unsafeRoutePatternReason('a)|(?:ja|en)(?:')).toBeUndefined();
  });

  /** Not a pattern at all: the edge compares it as a literal, which runs no engine. */
  it('admits something that does not compile', () => {
    expect(unsafeRoutePatternReason('(unclosed')).toBeUndefined();
  });
});

/**
 * A route's source, a middleware matcher and an image pattern are compiled by Next.js and run by
 * the edge as they are, against a pathname or a hostname any visitor can choose. What the check
 * admits has to include everything a build writes; what it refuses has to include what backtracks.
 */
describe('unsafeSourcePatternReason', () => {
  /** Written by Next.js 16.3: route sources, `:path*` repetitions, and globs picomatch compiled. */
  it.each([
    '^[/]?/items/(?<nxtPid>[^/]+?)(?:/)?$',
    String.raw`^(?:\/((?:[^\/]+?)(?:\/(?:[^\/]+?))*))?(?:\/)?$`,
    String.raw`^(?:\/((?:[^\/]+?)(?:\/(?:[^\/]+?))*))\/$`,
    String.raw`^\/docs(?:\/((?:[^\/]+?)(?:\/(?:[^\/]+?))*))?\.md(?:\/)?$`,
    // The redirects of `trailingSlash: true`, which divide a path by the slash after each part.
    String.raw`^(?:\/((?!\.well-known(?:\/.*)?)(?:[^/]+\/)*[^/]+\.\w+))\/$`,
    String.raw`^(?:\/((?!\.well-known(?:\/.*)?)(?:[^/]+\/)*[^/\.]+))$`,
    String.raw`^[/]?/(?<nxtPlocale>[^/]+?)/(?<nxtPorgSlug>[^/]+?)/(?<nxtPprojectId>[^/]+?)\.segments/\$d\$locale/!KHNpdGUp/\$d\$orgSlug/\$d\$projectId(?<segment>/__PAGE__\.segment\.rsc|\.segment\.rsc)(?:/)?$`,
    String.raw`^(?:(?!(?:^|\/)\.{1,2}(?:\/|$))(?:(?:(?!(?:^|\/)\.{1,2}(?:\/|$)).)*?)\/?)$`,
    String.raw`^(?:(?!(?:^|\/)\.{1,2}(?:\/|$))(?:(?:(?!(?:^|\/)\.{1,2}(?:\/|$)).)*?)\.example\.com\/?)$`,
    String.raw`^(?:\/images(?:\/(?!\.{1,2}(?:\/|$))(?:(?:(?!(?:^|\/)\.{1,2}(?:\/|$)).)*?)|$))$`,
    String.raw`^(?:\/u(?:\/(?!\.{1,2}(?:\/|$))(?:(?:(?!(?:^|\/)\.{1,2}(?:\/|$)).)*?)\/|\/|$)avatar\.[^/]*?\/?)$`,
    String.raw`^(?:^(?:cdn\-[^/]*?\.example\.com)$)$`,
  ])('admits %s', (source) => {
    expect(unsafeSourcePatternReason(source)).toBeUndefined();
  });

  /**
   * Each of these takes seconds or more on a crafted value of a few dozen characters — the two
   * quantified parts between delimiters took minutes on 155 — so each is refused at the upload.
   */
  it.each([
    ['nested repetition', String.raw`^\/(a+)+$`],
    ['repeated alternatives', String.raw`^\/(a|aa)+$`],
    ['two quantified parts between delimiters', String.raw`^(?:\/[^\/]+[^\/]+)*\.md$`],
    ['a part that can consume the delimiter', String.raw`^(?:\/.+)*\.md$`],
    ['a delimiter the class does not exclude', String.raw`^(?:a[^\/]+)*$`],
    ['the delimiter written as an escape', String.raw`^(?:\//+)*$`],
    ['a quantified group between delimiters', String.raw`^(?:\/(?:[^\/]+)*)*$`],
    ['an alternative between delimiters', String.raw`^(?:\/[^\/]+|x)*$`],
    ['a repeated backreference', String.raw`^(?:\/([^\/]+)\1+)*$`],
    ['a part before a trailing delimiter that can consume it', String.raw`^(?:.+\/)*\.md$`],
    ['two quantified parts before a trailing delimiter', String.raw`^(?:[^\/]+[^\/]+\/)*\.md$`],
    ['a trailing delimiter that is quantified itself', String.raw`^(?:[^\/]+\/+)*\.md$`],
    ['a trailing delimiter the class does not exclude', String.raw`^(?:[^a]+\/)*\.md$`],
    ['a group before a trailing delimiter', String.raw`^(?:(?:[^\/]+)\/)*\.md$`],
    ['a repetition inside a lookahead', '^(?:(?=(a+)+b).)*$'],
    // The edge compiles a source without the `u` flag, where `\u{2f}` is `u` and `{2f}`, not `/`.
    ['a braced escape the engine reads as letters', String.raw`^(?:\/[^\u{2f}]+)*\.md$`],
    ['a delimiter spelled as a braced escape', String.raw`^(?:\u{2f}[^\/]+)*\.md$`],
    ['an octal escape in a set', String.raw`^(?:1[^\01]+)*\.md$`],
    ['a negated set with a member this check cannot read', String.raw`^(?:\/[^\p]+)*\.md$`],
    // A middleware matcher runs with `i`, where `A+` consumes the `a` that was to divide it.
    ['a part that consumes the delimiter in its other case', String.raw`^\/(?:aA+)+$`],
    // `ǅ` is `ǆ` to it too, and so is `Ǆ`: a cased delimiter beyond ASCII is not reasoned about.
    ['a cased delimiter outside ASCII', String.raw`^(?:\u01C6[^\u01C6]+)*$`],
  ])('refuses %s', (_, source) => {
    expect(unsafeSourcePatternReason(source)).toBeDefined();
  });

  /** Four hex digits are an escape without the `u` flag too, and name the character they say. */
  it('reads a four-digit escape as the character it names', () => {
    expect(unsafeSourcePatternReason(String.raw`^(?:\/[^\u002F]+)*$`)).toBeUndefined();
  });

  /**
   * Its one quantified part may be optional as well as repeated: the delimiter fixes where each
   * repetition begins, so the part is tried one way or the other, once.
   */
  it('admits a repetition split by a delimiter in a condition as well', () => {
    expect(unsafeRoutePatternReason('^(ab?)+$')).toBeUndefined();
    expect(unsafeRoutePatternReason(String.raw`(?:\/a?)*`)).toBeUndefined();
  });

  it('refuses a source too long to read in full', () => {
    expect(unsafeSourcePatternReason(`^${'a'.repeat(4096)}$`)).toBe('longer than 4096 characters');
  });

  it('leaves a source that does not compile to the check that says so', () => {
    expect(unsafeSourcePatternReason('(unclosed')).toBeUndefined();
  });
});
