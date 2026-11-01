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
