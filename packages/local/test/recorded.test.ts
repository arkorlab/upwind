import type { RouteEntry } from '@stayingupwind/core/manifest';
import { describe, expect, it } from 'vitest';

import type { Reading } from '../src/reading.ts';
import { servedGeneration } from '../src/recorded.ts';

/** An answer whose account, all the generation it was served from is read from, says `account`. */
function answering(account: string): Reading {
  return { headers: { 'x-arkor-edge': account } } as unknown as Reading;
}

describe('the generation the edge says it served a document from', () => {
  /**
   * Whether it went out whole is read from the account's fields ahead of the route alone: a route's
   * pathname may hold `;`, and with it what reads like the marker.
   */
  it('went out whole only where a field ahead of the route says so, whatever the route is named', () => {
    const route = { pathname: '/docs/a;cont=none' } as RouteEntry;
    const resumed = answering(
      'shell;strategy=edge;cont=resume;mw=miss;route=/docs/a;cont=none;cache=fresh;seq=2',
    );
    const whole = answering(
      'shell;strategy=edge;cont=none;mw=miss;route=/docs/a;cont=none;cache=fresh;seq=2',
    );

    expect(servedGeneration(resumed, route)?.whole).toBe(false);
    expect(servedGeneration(whole, route)?.whole).toBe(true);
  });
});
