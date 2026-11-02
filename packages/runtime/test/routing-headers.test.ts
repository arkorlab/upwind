import { HEADER_RULES_AFTER_COOKIE_COUNT_HEADER } from '@stayingupwind/core/paas';
import { describe, expect, it } from 'vitest';

import { withRoutingHeaders } from '../src/routing-headers.ts';

/**
 * The headers routing collected, laid on what the handler answered: routing's over the handler's,
 * and cookies together, the middleware's first, as Next.js's server sends them
 * (`patchSetHeaderWithCookieSupport`, `server/lib/patch-set-header.ts`).
 */
describe('the headers routing collected, laid on an answer', () => {
  it('put the middleware’s cookies ahead of the handler’s, each once', () => {
    const answer = new Response('{}', {
      headers: [
        ['set-cookie', 'hello=From API'],
        ['set-cookie', 'shared=1'],
      ],
    });
    const routed = new Headers([
      ['set-cookie', 'from-middleware=1; Path=/'],
      ['set-cookie', 'shared=1'],
    ]);

    expect(withRoutingHeaders(answer, routed).headers.getSetCookie()).toStrictEqual([
      'from-middleware=1; Path=/',
      'shared=1',
      'hello=From API',
    ]);
  });

  /**
   * Under a name the handler sets otherwise, routing's follows as it always did: the handler's may be
   * Next.js's copy of the middleware's, without its `Max-Age=0`, or a value of its own, and which it
   * is is not judged here.
   */
  it.each([
    ['a copy without the deletion', 'gone=1; Path=/', 'gone=1; Path=/; Max-Age=0'],
    ['a copy whose value Next.js encoded', 'query=a%3Ab; Path=/', 'query=a:b; Path=/; Max-Age=0'],
    ['a value of its own', 'session=new; Path=/', 'session=old; Path=/'],
  ])(
    'keep routing’s after a cookie the handler sets otherwise under its name: %s',
    (_, own, set) => {
      const answer = new Response('{}', {
        headers: [
          ['set-cookie', own],
          ['set-cookie', 'hello=From API'],
        ],
      });
      const routed = new Headers([
        ['set-cookie', set],
        ['set-cookie', 'from-middleware=1; Path=/'],
      ]);

      expect(withRoutingHeaders(answer, routed).headers.getSetCookie()).toStrictEqual([
        'from-middleware=1; Path=/',
        own,
        'hello=From API',
        set,
      ]);
    },
  );

  /** Its last write stands: a cookie set, deleted and set again is set (Codex). */
  it('keep the handler’s own cookies in their order, repeats and all', () => {
    const set = 'session=active; Path=/';
    const deleted = 'session=; Path=/; Max-Age=0';
    const answer = new Response('{}', {
      headers: [
        ['set-cookie', set],
        ['set-cookie', deleted],
        ['set-cookie', set],
      ],
    });
    const routed = new Headers([['set-cookie', 'from-middleware=1; Path=/']]);

    expect(withRoutingHeaders(answer, routed).headers.getSetCookie()).toStrictEqual([
      'from-middleware=1; Path=/',
      set,
      deleted,
      set,
    ]);
  });

  /**
   * The handler's copy of routing's cookie does not keep routing's ahead of a value the handler sets
   * otherwise under that name: routing's still follows it (Codex).
   */
  it('keep routing’s after the handler’s other value, though the handler copied routing’s first', () => {
    const answer = new Response('{}', {
      headers: [
        ['set-cookie', 'theme=dark; Path=/'],
        ['set-cookie', 'theme=light; Path=/'],
      ],
    });
    const routed = new Headers([['set-cookie', 'theme=dark; Path=/']]);

    expect(withRoutingHeaders(answer, routed).headers.getSetCookie()).toStrictEqual([
      'theme=dark; Path=/',
      'theme=light; Path=/',
      'theme=dark; Path=/',
    ]);
  });

  it('keep the block the edge takes off the end last and whole', () => {
    const answer = new Response('{}', {
      headers: [
        ['set-cookie', 'later=1; Path=/'],
        ['set-cookie', 'hello=From API'],
      ],
    });
    const routed = new Headers([
      ['set-cookie', 'from-middleware=1; Path=/'],
      ['set-cookie', 'later=1; Path=/'],
      [HEADER_RULES_AFTER_COOKIE_COUNT_HEADER, '1'],
    ]);

    const laid = withRoutingHeaders(answer, routed).headers;

    expect(laid.getSetCookie()).toStrictEqual([
      'from-middleware=1; Path=/',
      'later=1; Path=/',
      'hello=From API',
      'later=1; Path=/',
    ]);
    expect(laid.get(HEADER_RULES_AFTER_COOKIE_COUNT_HEADER)).toBe('1');
  });

  it.each(['0', '01', 'x'])('take no block off the end for a count of %j', (count) => {
    const answer = new Response('{}', { headers: [['set-cookie', 'hello=From API']] });
    const routed = new Headers([
      ['set-cookie', 'from-middleware=1; Path=/'],
      [HEADER_RULES_AFTER_COOKIE_COUNT_HEADER, count],
    ]);

    expect(withRoutingHeaders(answer, routed).headers.getSetCookie()).toStrictEqual([
      'from-middleware=1; Path=/',
      'hello=From API',
    ]);
  });

  it('keep the handler’s cookies where routing set none, and routing’s other headers over its', () => {
    const answer = new Response('{}', {
      headers: [
        ['set-cookie', 'hello=From API'],
        ['x-said', 'handler'],
      ],
    });

    const laid = withRoutingHeaders(answer, new Headers({ 'x-said': 'routing' })).headers;

    expect(laid.getSetCookie()).toStrictEqual(['hello=From API']);
    expect(laid.get('x-said')).toBe('routing');
  });
});
