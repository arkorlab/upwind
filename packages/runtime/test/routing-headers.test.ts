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

  it('keep the middleware’s after the handler’s copy of it, written otherwise', () => {
    // Next.js writes a middleware's cookie back as the render's own, without a `Max-Age=0`.
    const answer = new Response('{}', {
      headers: [
        ['set-cookie', 'gone=1; Path=/'],
        ['set-cookie', 'hello=From API'],
      ],
    });
    const routed = new Headers([
      ['set-cookie', 'gone=1; Path=/; Max-Age=0'],
      ['set-cookie', 'from-middleware=1; Path=/'],
    ]);

    expect(withRoutingHeaders(answer, routed).headers.getSetCookie()).toStrictEqual([
      'from-middleware=1; Path=/',
      'gone=1; Path=/',
      'hello=From API',
      'gone=1; Path=/; Max-Age=0',
    ]);
  });

  /** A copy whose value Next.js encoded as it wrote it back is a copy still. */
  it('keep the middleware’s after a copy of it whose value the handler encoded', () => {
    const answer = new Response('{}', { headers: [['set-cookie', 'query=a%3Ab; Path=/']] });
    const routed = new Headers([['set-cookie', 'query=a:b; Path=/; Max-Age=0']]);

    expect(withRoutingHeaders(answer, routed).headers.getSetCookie()).toStrictEqual([
      'query=a%3Ab; Path=/',
      'query=a:b; Path=/; Max-Age=0',
    ]);
  });

  /** The handler's own value follows the middleware's, as on Next.js, and is the one kept. */
  it('put the handler’s own value of a cookie the middleware set after it', () => {
    const answer = new Response('{}', { headers: [['set-cookie', 'session=new; Path=/']] });
    const routed = new Headers([['set-cookie', 'session=old; Path=/']]);

    expect(withRoutingHeaders(answer, routed).headers.getSetCookie()).toStrictEqual([
      'session=old; Path=/',
      'session=new; Path=/',
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
