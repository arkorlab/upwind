import { describe, expect, it } from 'vitest';

import { queryDependent } from '../src/bundle/query.ts';
import type { Prerender } from '../src/bundle/schema.ts';
import {
  completedPathname,
  keyedParameters,
  memberEntryPathname,
} from '../src/manifest/completion.ts';

/**
 * The shell a member of a class the build left no shell of is kept under, where Next.js 16.4 keys
 * the class's entries by some of its parameters (`buildCompletedShellCacheKey`): the root
 * parameters and the others `generateStaticParams` may still provide, which the build names as the
 * query the entries vary on (`allowQuery`). Every other parameter is left a placeholder, and
 * resumed for each request.
 */

const POSTS = '/[lang]/[region]/posts/[id]';

describe('the parameters a class is keyed by', () => {
  it('are the ones the build keys its entries by, where they are some of the route’s', () => {
    expect(keyedParameters(POSTS, POSTS, ['nxtPlang', 'nxtPregion'])).toStrictEqual([
      'lang',
      'region',
    ]);
  });

  it('are in the route’s order, whatever the build’s', () => {
    expect(keyedParameters(POSTS, POSTS, ['nxtPregion', 'nxtPlang'])).toStrictEqual([
      'lang',
      'region',
    ]);
  });

  /** Every release before 16.4 names them all: each member is its own entry. */
  it('are none where the build keys the entries by every parameter', () => {
    expect(keyedParameters(POSTS, POSTS, ['nxtPlang', 'nxtPregion', 'nxtPid'])).toBeUndefined();
  });

  it.each<[string, string[] | undefined]>([
    ['no query', undefined],
    ['an empty one', []],
    ['a key that names no parameter', ['nxtPlang', 'ref']],
    ['a key without the prefix', ['lang']],
  ])('are none for %s', (_, allowQuery) => {
    expect(keyedParameters(POSTS, POSTS, allowQuery)).toBeUndefined();
  });

  /**
   * A class narrower than its route, its leading parameter resolved (`/en/[region]/posts/[id]`):
   * the members of it share that value, and are keyed by it as by the ones the build names.
   */
  it('are, of a narrower class, the ones it resolved and the ones the build names', () => {
    expect(keyedParameters(POSTS, '/en/[region]/posts/[id]', ['nxtPregion'])).toStrictEqual([
      'lang',
      'region',
    ]);
  });

  it('are none of a narrower class that leaves open only what the build names', () => {
    const route = '/closed-prefix/[top]/[bottom]';

    expect(keyedParameters(route, '/closed-prefix/t1/[bottom]', ['nxtPbottom'])).toBeUndefined();
  });

  it('are none for a class that does not line up with its route', () => {
    expect(keyedParameters(POSTS, '/en/de/fr/posts/[id]', ['nxtPlang'])).toBeUndefined();
  });

  it('are none for a route with a catch-all, whose values span segments', () => {
    expect(
      keyedParameters('/[lang]/docs/[...slug]', '/[lang]/docs/[...slug]', ['nxtPlang']),
    ).toBeUndefined();
    expect(
      keyedParameters('/[lang]/docs/[[...slug]]', '/[lang]/docs/[[...slug]]', ['nxtPlang']),
    ).toBeUndefined();
  });
});

describe('the pathname a member is kept under', () => {
  it('fills in the parameters the class is keyed by and leaves the rest placeholders', () => {
    expect(completedPathname(POSTS, ['lang', 'region'], '/de/fr/posts/1')).toBe(
      '/de/fr/posts/[id]',
    );
    expect(completedPathname(POSTS, ['lang'], '/de/fr/posts/1')).toBe('/de/[region]/posts/[id]');
  });

  it('is the one shell for every member that shares those parameters', () => {
    const keyedBy = ['lang', 'region'];

    expect(completedPathname(POSTS, keyedBy, '/de/fr/posts/2')).toBe(
      completedPathname(POSTS, keyedBy, '/de/fr/posts/1'),
    );
    expect(completedPathname(POSTS, keyedBy, '/de/ch/posts/1')).not.toBe(
      completedPathname(POSTS, keyedBy, '/de/fr/posts/1'),
    );
  });

  it('is without a trailing slash, as the entry is keyed', () => {
    expect(completedPathname(POSTS, ['lang', 'region'], '/de/fr/posts/1/')).toBe(
      '/de/fr/posts/[id]',
    );
  });

  it('is the member’s own where the member does not line up with the route', () => {
    expect(completedPathname(POSTS, ['lang'], '/de/fr/posts/1/more')).toBe('/de/fr/posts/1/more');
    expect(completedPathname(POSTS, ['lang'], '/de/fr/news/1')).toBe('/de/fr/news/1');
  });

  it('is the member’s own value where the class resolved it, and placeholders after', () => {
    expect(completedPathname(POSTS, ['lang', 'region'], '/en/uk/posts/1')).toBe(
      '/en/uk/posts/[id]',
    );
  });

  it('is the member’s own for a class whose members are each their own entry', () => {
    expect(memberEntryPathname({ route: POSTS }, '/de/fr/posts/1')).toBe('/de/fr/posts/1');
    expect(memberEntryPathname({ route: POSTS, keyedBy: ['lang'] }, '/de/fr/posts/1')).toBe(
      '/de/[region]/posts/[id]',
    );
  });
});

describe('a completed shell, by the query its class varies on', () => {
  const template = { allowQuery: ['nxtPlang', 'nxtPregion'] } as Prerender;

  it('is identified by the values it was completed with', () => {
    expect(queryDependent(template, POSTS, '/de/fr/posts/[id]')).toBe(false);
  });

  it('varies where it leaves one of them a placeholder', () => {
    expect(queryDependent(template, POSTS, '/de/[region]/posts/[id]')).toBe(true);
    expect(queryDependent(template, POSTS, POSTS)).toBe(true);
  });

  it('varies on a key that names no parameter of the route', () => {
    const foreign = { allowQuery: ['nxtPlang', 'ref'] } as Prerender;

    expect(queryDependent(foreign, POSTS, '/de/fr/posts/[id]')).toBe(true);
  });

  /** A template's payload, or a value spelled with a bracket: nothing reads which it names. */
  it('varies where its pathname holds a bracket anywhere but a placeholder', () => {
    expect(queryDependent(template, POSTS, '/de/fr/posts/[id].rsc')).toBe(true);
    expect(queryDependent(template, POSTS, '/de/fr/posts/[x]')).toBe(true);
  });

  it('is a page identified by all its values, as before', () => {
    expect(queryDependent(template, POSTS, '/de/fr/posts/1')).toBe(false);
  });
});
